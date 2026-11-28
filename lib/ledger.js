// 用量账本：把 $DSH_HOME/sessions 下每段对话的 `assistant/message.usage` 折成
// 「每天 / 每个对话」的 token 数，并缓存到 $DSH_HOME/cache/dsh-go-token-usage/index.json。
//
// - 冷数据（历史对话）：扫会话记录文件，按文件的 mtime + size 做增量缓存；
//   文件没了（引擎清理、用户删会话、换日志目录）也不清缓存：已经折好的数字
//   继续计入，只把这条记录标成 missing，面板据此给一句「历史按缓存保留」。
// - 热数据（引擎刚产生的调用）：`session/event` 立刻记账，并记下事件 seq；
//   临时账自己也落盘，重启后还在；文件里出现该 seq 之后自动让位，不会重复计。
// - 每个会话目录只读引擎当前那一代日志（版本号最大的），更老的历史代际不重复计；
//   `compression: 'none'` 的原始 JSONL 也认。
//
// 数据源与引擎自己一致，不联网、不估算。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { addTotals, bucketsEqual, dayKey, emptyTotals, lastDays, promptTokens, settlementOf, sumDays, totalTokens, usableTime } from './tally.js'
import { resolveHome } from './exec.js'

const INDEX_VERSION = 10
const SAVE_DEBOUNCE_MS = 4000
/** 2026-11-28 审查 P1-3：保存是「重读最新索引 → 合并 → 原子替换」一个跨进程事务，
 * 另一个实例正在合并时最多等这么久（异步等，不冻结宿主）；等不到就交给下次防抖。 */
const SAVE_LOCK_WAIT_MS = 1500
const SAVE_LOCK_RETRY_MS = 25
/**
 * dispose() 必须同步写完（下一个实例马上读缓存），所以那里保留一段有上限的同步等待。
 * 只在进程收尾时用一次，250ms 是可接受的停顿。
 */
const SAVE_LOCK_DISPOSE_WAIT_MS = 250
/**
 * 2026-11-28 复审 P1：锁的 mtime 只在创建时写一次，所以「mtime 旧」不能单独判死。
 * 判陈旧要同时满足「超过阈值」和「写锁的进程已经不在了」；超过 ANCIENT 才无条件回收
 * （一次保存卡十分钟本来就是坏掉的进程）。
 */
const SAVE_LOCK_STALE_MS = 60_000
/** Even a live holder gets its lock taken after this long: no real save holds one that long. */
const SAVE_LOCK_ANCIENT_MS = 30 * 60_000
/** Frames larger than this are decoded as a stream so memory stays bounded. */
const STREAM_FRAME_BYTES = 1 << 20
/** Older generations beyond this are ignored; the engine keeps at most a handful. */
const MAX_GENERATIONS = 16

/** Normalize a session id for matching: `session-<uuid>` and `<uuid>` are the same chat. */
export function normalizeSessionId(id) {
  const text = typeof id === 'string' ? id.trim() : ''
  return text.startsWith('session-') ? text.slice('session-'.length) : text
}

/** Model totals are keyed by provider too: the same model name can come from an
 * official account and from a relay, and the panel labels where it came from. */
const MODEL_SEP = '\u0000'
const modelKey = (provider, model) => `${typeof provider === 'string' ? provider : ''}${MODEL_SEP}${model}`
const splitModelKey = (key) => {
  const at = key.indexOf(MODEL_SEP)
  return at < 0 ? ['', key] : [key.slice(0, at), key.slice(at + 1)]
}

/** One settlement slot, as a plain string key ("turn/step"). */
const slotKey = (turn, step) => `${Number.isInteger(turn) ? turn : ''}/${step}`

const currentTzOffset = () => -new Date().getTimezoneOffset()
/** A cached record from a different timezone must be re-read into the right days. */
const NO_TZ = -9999

const totalCalls = (days) => {
  let calls = 0
  for (const bucket of days.values()) calls += bucket.calls
  return calls
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
/** A day bucket key must be a real calendar day, not "NaN-NaN-NaN". */
const isDayKey = (key) =>
  typeof key === 'string' && DAY_KEY.test(key) && !Number.isNaN(Date.parse(`${key}T12:00:00Z`))

/** Whether `target` is one of `dirs` or lives under one of them. */
const isUnder = (target, dirs) => {
  for (const dir of dirs) if (target === dir || target.startsWith(dir + path.sep)) return true
  return false
}

/**
 * Node's recursive mkdir can spin forever on pseudo filesystems, so a stray
 * `$DSH_HOME` pointing into one must never reach it. (The cache is a convenience;
 * refusing it is always safe.)
 */
const PSEUDO_FS_ROOTS = process.platform === 'win32' ? [] : ['/proc', '/sys', '/dev']
const isPseudoFsPath = (target) => {
  if (PSEUDO_FS_ROOTS.length === 0) return false
  let resolved
  try {
    resolved = path.resolve(target)
  } catch {
    return true
  }
  return PSEUDO_FS_ROOTS.some((root) => resolved === root || resolved.startsWith(root + path.sep))
}

/**
 * A live model call's totals. Malformed input must never corrupt the ledger, so
 * every counter has to be a finite non-negative number; totals with zero billed
 * tokens are valid (they still own a replacement slot, like the engine's).
 */
const liveTotals = (usage) => {
  if (!isPlainObject(usage)) return undefined
  const totals = emptyTotals()
  for (const key of Object.keys(totals)) {
    const value = usage[key]
    if (!Number.isFinite(value) || value < 0) return undefined
    totals[key] = value
  }
  return totals.calls >= 1 ? totals : undefined
}

/** A cached bucket is usable only when every counter is a finite non-negative number. */
const sanitizeBucket = (bucket) => {
  if (!isPlainObject(bucket)) return undefined
  const clean = emptyTotals()
  for (const key of Object.keys(clean)) {
    const value = bucket[key]
    if (!Number.isFinite(value) || value < 0) return undefined
    clean[key] = value
  }
  return clean
}

const emptyRecord = () => ({
  id: '',
  origin: '',
  createdAt: 0,
  days: {},
  models: {},
  turns: {},
  /** Settlements that reported cache counters, per day / per turn (null = unknown). */
  cacheDays: {},
  cacheTurns: {},
  /** Prompt tokens of just those settlements: the honest hit-rate denominator. */
  cachePrompt: {},
  cachePromptTurns: {},
  isSeeded: false,
  inheritedCut: -1,
  cacheSeen: false,
  /** Generation number of the log file this record was read from (higher = newer). */
  version: 0,
  lastSeq: -1,
  lastTime: 0,
  /**
   * 2026-11-28 审查 P1-6：日志里最后一个结算槽（turn+step）的完整信息。引擎按 turn+step
   * 覆盖同一槽位，实时重结算必须先把这个已入日志的旧结算扣掉，否则面板会旧值+新值一起算。
   */
  lastSlot: null,
  tzOffset: NO_TZ,
  totals: emptyTotals(),
})

/** One settlement slot, as booked: what a later settlement of the same turn+step replaces. */
const emptySlot = () => ({
  turn: undefined,
  step: undefined,
  seq: -1,
  time: 0,
  totals: emptyTotals(),
  model: '',
  provider: '',
  cacheCounters: false,
  counted: false,
})

/** A cached/log-derived slot is trusted only when every field has the right shape. */
const sanitizeSlot = (slot) => {
  if (!isPlainObject(slot)) return null
  const totals = sanitizeBucket(slot.totals)
  if (totals === undefined) return null
  const clean = emptySlot()
  clean.turn = Number.isInteger(slot.turn) && slot.turn >= 0 ? slot.turn : undefined
  clean.step = Number.isInteger(slot.step) && slot.step >= 0 ? slot.step : undefined
  clean.seq = Number.isInteger(slot.seq) ? slot.seq : -1
  clean.time = usableTime(slot.time) ? slot.time : 0
  clean.totals = totals
  clean.model = typeof slot.model === 'string' ? slot.model : ''
  clean.provider = typeof slot.provider === 'string' ? slot.provider : ''
  clean.cacheCounters = slot.cacheCounters === true
  clean.counted = slot.counted === true
  return clean
}

/** Coverage maps are untrusted: keep only finite positive counts. */
const sanitizeCoverage = (value) => {
  if (!isPlainObject(value)) return null
  const clean = {}
  for (const [key, count] of Object.entries(value)) if (Number.isFinite(count) && count > 0) clean[key] = count
  return clean
}

/**
 * Restore one cached record. Shared by #load and by the save-time merge, so a record
 * another instance wrote is held to exactly the same rules as one we read ourselves.
 * Returns undefined for a record whose shape cannot be trusted.
 */
const restoreRecord = (rec) => {
  if (!isPlainObject(rec)) return undefined
  if (rec.days !== undefined && !isPlainObject(rec.days)) return undefined
  const days = {}
  for (const [day, bucket] of Object.entries(isPlainObject(rec.days) ? rec.days : {})) {
    const clean = isDayKey(day) ? sanitizeBucket(bucket) : undefined
    if (clean === undefined) return undefined
    days[day] = clean
  }
  const models = {}
  for (const [day, byModel] of Object.entries(isPlainObject(rec.models) ? rec.models : {})) {
    if (!isPlainObject(byModel)) continue
    const clean = {}
    for (const [key, value] of Object.entries(byModel)) if (Number.isFinite(value) && value > 0) clean[key] = value
    if (Object.keys(clean).length > 0) models[day] = clean
  }
  const turns = {}
  for (const [turn, bucket] of Object.entries(isPlainObject(rec.turns) ? rec.turns : {})) {
    const clean = sanitizeBucket(bucket)
    if (clean !== undefined) turns[turn] = clean
  }
  const restored = {
    ...emptyRecord(),
    id: typeof rec.id === 'string' ? rec.id : '',
    origin: typeof rec.origin === 'string' ? rec.origin : '',
    createdAt: Number.isFinite(rec.createdAt) ? rec.createdAt : 0,
    days,
    models,
    turns,
    cacheDays: sanitizeCoverage(rec.cacheDays),
    cacheTurns: sanitizeCoverage(rec.cacheTurns),
    cachePrompt: sanitizeCoverage(rec.cachePrompt),
    cachePromptTurns: sanitizeCoverage(rec.cachePromptTurns),
    isSeeded: rec.isSeeded === true,
    partial: rec.partial === true,
    inheritedCut: Number.isInteger(rec.inheritedCut) ? rec.inheritedCut : -1,
    cacheSeen: rec.cacheSeen === true,
    version: Number.isInteger(rec.version) ? rec.version : 0,
    lastSeq: Number.isInteger(rec.lastSeq) ? rec.lastSeq : -1,
    lastTime: Number.isFinite(rec.lastTime) ? rec.lastTime : 0,
    lastSlot: sanitizeSlot(rec.lastSlot),
    mtimeMs: Number.isFinite(rec.mtimeMs) ? rec.mtimeMs : 0,
    size: Number.isFinite(rec.size) ? rec.size : 0,
    ctimeMs: Number.isFinite(rec.ctimeMs) ? rec.ctimeMs : -1,
    // A cache from an older layout cannot be trusted for day boundaries: NO_TZ makes
    // the next scan re-read any log that is still on disk.
    tzOffset: Number.isFinite(rec.tzOffset) ? rec.tzOffset : NO_TZ,
    // Aliases are a scan-time detail and are never restored from disk.
    missing: rec.missing === true,
  }
  restored.totals = emptyTotals()
  for (const bucket of Object.values(days)) addTotals(restored.totals, bucket)
  return restored
}

/** Restore one saved live call (pending), or undefined when it cannot be trusted. */
const restorePending = (entry) => {
  if (entry === null || typeof entry !== 'object') return undefined
  if (!Number.isInteger(entry.seq) || entry.seq < 0 || !usableTime(entry.time)) return undefined
  const totals = sanitizeBucket(entry.totals)
  if (totals === undefined) return undefined
  // A void entry owns a settlement slot that bills nothing; every other entry is a call.
  const isVoid = entry.void === true && totalTokens(totals) === 0
  if (totals.calls < 1 && !isVoid) return undefined
  return {
    seq: entry.seq,
    time: entry.time,
    totals,
    model: typeof entry.model === 'string' ? entry.model : '',
    provider: typeof entry.provider === 'string' ? entry.provider : '',
    turn: Number.isInteger(entry.turn) ? entry.turn : undefined,
    step: Number.isInteger(entry.step) ? entry.step : undefined,
    cacheCounters: entry.cacheCounters === true,
    ...(isVoid ? { void: true } : {}),
    ...(entry.independent === true ? { independent: true } : {}),
  }
}

/**
 * Linux start time of a pid (field 22 of /proc/<pid>/stat, in clock ticks). A pid that was
 * recycled by an unrelated process keeps the number but gets a new start time, so recording
 * it turns "pid looks alive" into "the same process still holds the lock".
 * Undefined on hosts without /proc (macOS, some sandboxes).
 */
const procStartTick = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const tick = Number.parseInt(fields[19], 10) // 22nd field overall = index 19 after "pid (comm)"
    return Number.isInteger(tick) ? tick : undefined
  } catch {
    return undefined
  }
}

/** This process's start tick, written into the lock so a waiter can detect pid reuse. */
const PROCESS_START_TICK = procStartTick(process.pid) ?? 0

/** Whether a pid is still running (EPERM means alive but not ours). */
const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Read the owner recorded inside a lock file: "<pid> <startTick>". */
const readLockOwner = (lockFile) => {
  try {
    const text = fs.readFileSync(lockFile, 'utf8')
    const [pid, start] = text.trim().split(/\s+/)
    const value = Number.parseInt(pid, 10)
    if (!Number.isInteger(value) || value <= 0) return undefined
    const tick = Number.parseInt(start, 10)
    return { pid: value, tick: Number.isInteger(tick) ? tick : 0 }
  } catch {
    return undefined
  }
}

/** Blocking sleep, only used by dispose()'s bounded last-chance flush. */
const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // No SharedArrayBuffer (rare sandbox): spin for the same budget instead.
    const until = Date.now() + ms
    while (Date.now() < until) { /* wait */ }
  }
}

/**
 * Merge this process's records with the ones already on disk: per log the more
 * complete record wins, and a log one side never saw is kept. Returns plain JSON
 * values ready to serialise (the disk side stays as it was read, so no data the
 * other instance holds is rewritten from a lossy copy).
 */
const mergeRecords = (mine, disk) => {
  const other = isPlainObject(disk) && isPlainObject(disk.files) ? disk.files : {}
  const out = {}
  // The other instance's record is kept verbatim (its shape is re-checked on load),
  // so a save never rewrites history read by someone else from a lossy copy.
  for (const [file, raw] of Object.entries(other)) if (isPlainObject(raw)) out[file] = raw
  for (const [file, rec] of Object.entries(mine ?? {})) {
    const raw = out[file]
    if (raw === undefined) {
      out[file] = rec
      continue
    }
    const knownSeq = Number.isInteger(raw.lastSeq) ? raw.lastSeq : -1
    // Only a valid, more complete record from the other side wins.
    if (knownSeq > (rec.lastSeq ?? -1) && restoreRecord(raw) !== undefined) continue
    out[file] = rec
  }
  return out
}

/**
 * Merge the live-slot notes. Another instance's slot is kept only while the call it
 * points at is still unflushed; otherwise `slots` would grow with every session the
 * cache ever saw (复审 P3), because each save merges the previous file back in.
 */
const mergeSlots = (live, disk, pending) => {
  const out = {}
  for (const [id, state] of Object.entries(isPlainObject(disk) ? disk : {})) {
    const list = Array.isArray(pending?.[id]) ? pending[id] : []
    if (list.length === 0) continue
    if (!isPlainObject(state)) continue
    if (Number.isInteger(state.seq) && !list.some((entry) => entry.seq === state.seq)) continue
    out[id] = state
  }
  for (const [id, state] of Object.entries(live ?? {})) out[id] = state
  return out
}

/** Merge pending live calls by log position; this process wins on the same position. */
const mergePending = (mine, disk, settledSeq = new Map()) => {
  const other = isPlainObject(disk) && isPlainObject(disk.pending) ? disk.pending : {}
  const out = {}
  const ids = new Set([...Object.keys(other), ...Object.keys(mine ?? {})])
  for (const id of ids) {
    const byPosition = new Map()
    const settled = settledSeq.get(id) ?? -1
    for (const [list, own] of [[other[id], false], [mine?.[id], true]]) {
      if (!Array.isArray(list)) continue
      for (const entry of list) {
        const restored = own ? restorePending(entry) : entry
        const seq = restored?.seq
        if (restored === undefined || !Number.isInteger(seq)) continue
        // The log already holds this call: it is not pending any more.
        if (seq <= settled) continue
        byPosition.set(seq, restored)
      }
    }
    const list = [...byPosition.values()].sort((a, b) => a.seq - b.seq)
    if (list.length > 0) out[id] = list
  }
  return out
}

class ZstdTruncatedError extends Error {}

const ZSTD_MAGIC = 0xfd2fb528
const ZSTD_SKIPPABLE_MASK = 0xfffffff0
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50

/**
 * Split one concatenated-zstd buffer into its frames. Every durable write is one
 * frame, so a session log is a frame chain. Node's zstd decoders before 24.22
 * silently stop after the first frame of a chain, which would undercount every
 * log on older runtimes, so the plugin walks the frame layout itself and decodes
 * frame by frame — correct on every supported Node version.
 *
 * Throws when the chain is not a valid frame sequence (torn tail or foreign
 * bytes); the caller decides whether that is a partial read or a real failure.
 */
function* zstdFrames(buffer) {
  let at = 0
  while (at < buffer.length) {
    if (buffer.length - at < 4) {
      const tail = buffer.subarray(at)
      const standard = [0x28, 0xb5, 0x2f, 0xfd]
      const skippable = [0x50, 0x2a, 0x4d, 0x18]
      const validPrefix = tail.every((byte, i) => byte === standard[i])
        || tail.every((byte, i) => i === 0 ? (byte & 0xf0) === 0x50 : byte === skippable[i])
      if (!validPrefix) throw new Error('zstd: bad frame magic')
      throw new ZstdTruncatedError('zstd: truncated frame magic')
    }
    const magic = buffer.readUInt32LE(at)
    if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
      if (buffer.length - at < 8) throw new ZstdTruncatedError('zstd: truncated skippable frame')
      const size = buffer.readUInt32LE(at + 4)
      at += 8 + size
      if (at > buffer.length) throw new ZstdTruncatedError('zstd: truncated skippable frame body')
      continue
    }
    if (magic !== ZSTD_MAGIC) throw new Error('zstd: bad frame magic')
    const start = at
    at += 4
    if (at >= buffer.length) throw new ZstdTruncatedError('zstd: truncated frame header')
    const descriptor = buffer[at]
    at += 1
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const fcsFlag = descriptor >> 6
    const dictFlag = descriptor & 0x03
    if (!singleSegment) at += 1 // window descriptor
    at += [0, 1, 2, 4][dictFlag] // dictionary id
    at += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag] // frame content size
    if (at > buffer.length) throw new ZstdTruncatedError('zstd: truncated frame header')
    for (;;) {
      if (buffer.length - at < 3) throw new ZstdTruncatedError('zstd: truncated block header')
      const header = buffer[at] | (buffer[at + 1] << 8) | (buffer[at + 2] << 16)
      at += 3
      const last = (header & 1) !== 0
      const blockType = (header >> 1) & 0x03
      const blockSize = (header >> 3) & 0x1fffff
      if (blockType === 3) throw new Error('zstd: reserved block type')
      at += blockType === 1 ? 1 : blockSize // RLE blocks carry one byte
      if (at > buffer.length) throw new ZstdTruncatedError('zstd: truncated block')
      if (last) break
    }
    if (checksum) at += 4
    if (at > buffer.length) throw new ZstdTruncatedError('zstd: truncated frame checksum')
    yield buffer.subarray(start, at)
  }
}

export class UsageLedger {
  /** @param {{ home?: string, now?: () => number }} [options] */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now())
    this.home = resolveHome(options.home)
    this.dir = path.join(this.home, 'cache', 'dsh-go-token-usage')
    this.file = path.join(this.dir, 'index.json')
    /** @type {Map<string, ReturnType<typeof emptyRecord>>} */
    this.records = new Map()
    /** @type {Map<string, Array<{ seq: number, time: number, totals: any, model: string, step?: number }>>} */
    this.pending = new Map()
    /** @type {Map<string, { turn?: number, step?: number, entry?: any, closed?: boolean }>} last live settlement per session */
    this.liveLast = new Map()
    /** @type {Map<string, any>} normalized session id -> the last settlement slot the log holds */
    this.slotById = new Map()
    /** @type {Map<string, Set<string>>} session id -> "turn/step" slots a retry closed */
    this.closedSlots = new Map()
    /** @type {Map<string, any>} date -> totals */
    this.days = new Map()
    /** @type {Map<string, any>} normalized session id -> totals */
    this.sessions = new Map()
    /** @type {Map<string, Map<string, number>>} date -> model -> tokens */
    this.modelsByDay = new Map()
    /** @type {Map<string, Map<number, any>>} normalized session id -> turn -> totals */
    this.sessionTurns = new Map()
    /** Cache-counter coverage per day / session / turn: how many settlements knew them. */
    this.cacheDays = new Map()
    this.cacheSessions = new Map()
    this.cacheTurns = new Map()
    /** Prompt tokens of just the settlements that reported cache counters (hit-rate denominator). */
    this.cachePromptDays = new Map()
    this.cachePromptSessions = new Map()
    this.cachePromptTurns = new Map()
    /** Cache-counter coverage: counts of calls whose record had unknown coverage. */
    this.cacheUnknownDays = new Map()
    this.cacheUnknownSessions = new Map()
    this.cacheUnknownTurns = new Map()
    this.allCalls = 0
    this.allCacheCalls = 0
    this.allCacheUnknown = 0
    this.scanErrors = 0
    this.emptyLogs = 0
    this.oversizedLogs = 0
    this.cacheDamaged = false
    /** The cache on disk was written by a newer build: read it, never overwrite it. */
    this.cacheNewer = false
    /** The lock path is held by something we may not remove (symlink/dir/other uid). */
    this.cacheLocked = false
    /** In-flight async save, so two debounce timers cannot write at once. */
    this.savePromise = undefined
    /** Defensive caps: a hijacked/symlinked path in a rooted phone must not OOM us. */
    this.maxLogBytes = Number.isFinite(options.maxLogBytes) ? options.maxLogBytes : 128 * 1024 * 1024
    this.maxLineBytes = Number.isFinite(options.maxLineBytes) ? options.maxLineBytes : 32 * 1024 * 1024
    // 2026-11-25：maxLogBytes 只限压缩文件；700B 的 zstd 帧可解出 20MB 全换行把单线程占满。
    // 解压总量/总行数各自封顶，超限按坏日志跳过。
    this.maxDecodedBytes = Number.isFinite(options.maxDecodedBytes)
      ? options.maxDecodedBytes : 256 * 1024 * 1024
    this.maxLines = Number.isFinite(options.maxLines) ? options.maxLines : 2_000_000
    this.maxCacheBytes = Number.isFinite(options.maxCacheBytes) ? options.maxCacheBytes : 64 * 1024 * 1024
    /** Debounce before an idle save; only tests need to shorten it. */
    this.saveDebounceMs = Number.isFinite(options.saveDebounceMs) && options.saveDebounceMs >= 0
      ? options.saveDebounceMs : SAVE_DEBOUNCE_MS
    /** Files already known to be an unusable generation, with the stat that proved it. */
    this.ignored = new Map()
    /** Files that failed to parse, remembered by stat so a 20s poll stops re-reading them. */
    this.failed = new Map()
    /** Directories/log paths this scan could not read (EACCES/ENOENT/ELOOP/not a file). */
    this.unavailable = []
    /** Cached records dropped on load because their stored shape was corrupt. */
    this.cacheDropped = 0
    this.loaded = false
    this.scanning = undefined
    this.listeners = new Set()
    this.saveTimer = undefined
    this.scannedAt = 0
    this.parsedFiles = 0
    this.errors = 0
    /** Set by dispose(): no further scans write the cache or emit to feeds. */
    this.disposed = false
    /** Number of session log files the last scan found on disk (0 = no history source). */
    this.logFiles = 0
    /** Whether the sessions root itself could not be read. */
    this.rootMissing = false
    /** Last self-check result shown in the panel ('' until one runs). */
    this.verifyNote = ''
    this.#load()
  }

  // ── public ────────────────────────────────────────────────────────────────

  /** Today's key in the host's local calendar. */
  today() {
    return dayKey(this.now())
  }

  /** Called by the feed: remember it wants updates; returns an unsubscribe. */
  listen(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Totals of the `n` local days ending with today (oldest first ordering matters only for charts). */
  window(n) {
    return sumDays(this.days, lastDays(this.today(), n))
  }

  /** Totals of every day the ledger knows. */
  allTime() {
    const out = emptyTotals()
    for (const t of this.days.values()) addTotals(out, t)
    return out
  }

  /** Per-turn totals of one chat (turn number -> totals), newest turns kept by the caller. */
  sessionTurnsOf(id) {
    if (typeof id !== 'string' || id === '') return new Map()
    return this.sessionTurns.get(normalizeSessionId(id)) ?? new Map()
  }

  /** Totals of one chat, or undefined when the ledger has never seen it. */
  session(id) {
    if (typeof id !== 'string' || id === '') return undefined
    return this.sessions.get(normalizeSessionId(id))
  }

  /** How many of the `n` days ending today actually have model calls. */
  coveredDays(n) {
    let covered = 0
    for (const date of lastDays(this.today(), n)) {
      const bucket = this.days.get(date)
      if (bucket !== undefined && totalTokens(bucket) > 0) covered += 1
    }
    return covered
  }

  /** Tokens per day for the `n` days ending today, oldest first. */
  dailyValues(n) {
    const today = this.today()
    return lastDays(today, n).map((date) => totalTokens(this.days.get(date) ?? emptyTotals()))
  }

  /** Calls counted provisionally but not yet seen in the session files. */
  pendingCount() {
    let count = 0
    // A void entry only owns a cleared settlement slot; it is not a call.
    for (const list of this.pending.values()) for (const entry of list) if (entry.void !== true) count += 1
    return count
  }

  /**
   * What the last scan actually saw on disk, so the panel can be honest about
   * missing history instead of silently showing 0. `lostFiles` are sessions the
   * ledger has read before whose log is no longer on disk; their totals stay in
   * the ledger (the calls were really billed). `lostTotals` is the raw sum of
   * those records; Verify uses the per-session comparison in compareRecount()
   */
  sourceState() {
    const lostTotals = emptyTotals()
    let lostFiles = 0
    for (const rec of this.#ownedRecords()) {
      if (rec.missing !== true) continue
      lostFiles += 1
      addTotals(lostTotals, rec.totals)
    }
    return {
      scanned: this.scannedAt > 0,
      logFiles: this.logFiles,
      rootMissing: this.rootMissing,
      unavailableDirs: this.unavailable.length,
      lostFiles,
      lostTotals,
      errors: this.errors,
      scanErrors: this.scanErrors,
      emptyLogs: this.emptyLogs,
      oversizedLogs: this.oversizedLogs,
      cacheDamaged: this.cacheDamaged,
      cacheDenied: this.cacheDenied,
      cacheLocked: this.cacheLocked,
      cacheNewer: this.cacheNewer,
      cacheDropped: this.cacheDropped,
      pending: this.pendingCount(),
    }
  }

  /**
   * Re-read every session log from scratch (ignoring the index and the live
   * ledger) and fold the billed usage again. Used by the panel's Verify button:
   * compare with allTime() to prove the numbers come from the logs.
   */
  async recount() {
    const empty = () => ({
      totals: emptyTotals(),
      days: new Map(),
      sessions: new Map(),
      seqs: new Map(),
      files: 0,
      unavailable: [],
    })
    if (this.disposed) return empty()
    const { sessions, unavailable, rootMissing } = await this.#sessionFiles()
    if (rootMissing) unavailable.push(path.join(this.home, 'sessions'))
    if (this.disposed) return empty()
    const parsed = new Map()
    let filesRead = 0
    for (const { candidates } of sessions) {
      const usable = []
      for (const candidate of candidates) {
        if (candidate.size === 0 || candidate.size > this.maxLogBytes) continue
        try {
          const rec = await this.#parse(candidate.file)
          if (rec.partial) unavailable.push(candidate.file)
          usable.push({ candidate, rec })
        } catch {
          unavailable.push(candidate.file)
          // Unreadable generations are reflected by the scan's scanErrors; a
          // verify pass must not inflate the ledger's own error counters.
        }
      }
      if (usable.length === 0) continue
      // Same rule as the live scan: the most complete generation wins.
      usable.sort((a, b) => b.rec.lastSeq - a.rec.lastSeq
        || b.candidate.version - a.candidate.version
        || b.candidate.mtimeMs - a.candidate.mtimeMs)
      const rec = usable[0].rec
      filesRead += 1
      const id = normalizeSessionId(rec.id)
      const key = id === '' ? `file:${usable[0].candidate.file}` : `id:${id}`
      const known = parsed.get(key)
      const moreComplete = known === undefined
        || rec.lastSeq > known.lastSeq
        || (rec.lastSeq === known.lastSeq && totalTokens(rec.totals) > totalTokens(known.totals))
      if (moreComplete) parsed.set(key, rec)
    }
    const totals = emptyTotals()
    const days = new Map()
    const bySession = new Map()
    /** Highest settlement seq this recount actually saw, per session. A pending
     * live call at or below it is already in the logs, not an unexplained diff. */
    const seqs = new Map()
    for (const rec of parsed.values()) {
      const id = normalizeSessionId(rec.id)
      for (const [day, bucket] of Object.entries(rec.days)) {
        const target = days.get(day) ?? days.set(day, emptyTotals()).get(day)
        addTotals(target, bucket)
        addTotals(totals, bucket)
      }
      if (id !== '') {
        const sessionTotals = bySession.get(id) ?? emptyTotals()
        addTotals(sessionTotals, rec.totals)
        bySession.set(id, sessionTotals)
        seqs.set(id, Math.max(seqs.get(id) ?? -1, rec.lastSeq))
      }
    }
    return { totals, days, sessions: bySession, seqs, files: filesRead, unavailable }
  }

  /** Whether every recorded call carried cache counters (some relays omit them). */
  cacheKnown() {
    return this.allCacheKnown()
  }

  /**
   * Cache-counter coverage of the whole ledger: calls vs calls that reported them,
   * plus the prompt tokens of just those calls (the only honest hit-rate denominator).
   */
  allCacheCoverage() {
    let prompt = 0
    for (const value of this.cachePromptDays.values()) prompt += value
    return { calls: this.allCalls, withCounters: this.allCacheCalls, unknown: this.allCacheUnknown, prompt }
  }

  /** Cache-counter coverage of the last `n` local days. */
  windowCacheCoverage(n) {
    let calls = 0
    let withCounters = 0
    let unknown = 0
    let prompt = 0
    for (const day of lastDays(this.today(), n)) {
      calls += this.days.get(day)?.calls ?? 0
      withCounters += this.cacheDays.get(day) ?? 0
      unknown += this.cacheUnknownDays.get(day) ?? 0
      prompt += this.cachePromptDays.get(day) ?? 0
    }
    return { calls, withCounters, unknown, prompt }
  }

  /** Cache-counter coverage of one chat. */
  sessionCacheCoverage(id) {
    const normalized = normalizeSessionId(id)
    return {
      calls: this.sessions.get(normalized)?.calls ?? 0,
      withCounters: this.cacheSessions.get(normalized) ?? 0,
      unknown: this.cacheUnknownSessions.get(normalized) ?? 0,
      prompt: this.cachePromptSessions.get(normalized) ?? 0,
    }
  }

  /** Cache-counter coverage of one turn. */
  turnCacheCoverage(id, turn) {
    const normalized = normalizeSessionId(id)
    return {
      calls: this.sessionTurns.get(normalized)?.get(turn)?.calls ?? 0,
      withCounters: this.cacheTurns.get(normalized)?.get(turn) ?? 0,
      unknown: this.cacheUnknownTurns.get(normalized)?.get(turn) ?? 0,
      prompt: this.cachePromptTurns.get(normalized)?.get(turn) ?? 0,
    }
  }

  /** Whether every call in the whole ledger reported cache counters. */
  allCacheKnown() {
    const { calls, withCounters, unknown } = this.allCacheCoverage()
    return calls > 0 && unknown === 0 && withCounters >= calls
  }

  /** Whether every call over the last `n` local days reported cache counters. */
  windowCacheKnown(n) {
    const { calls, withCounters, unknown } = this.windowCacheCoverage(n)
    return calls > 0 && unknown === 0 && withCounters >= calls
  }

  /** Whether every call of one chat reported cache counters. */
  sessionCacheKnown(id) {
    const { calls, withCounters, unknown } = this.sessionCacheCoverage(id)
    return calls > 0 && unknown === 0 && withCounters >= calls
  }

  /** Whether every call of one turn reported cache counters. */
  turnCacheKnown(id, turn) {
    const { calls, withCounters, unknown } = this.turnCacheCoverage(id, turn)
    return calls > 0 && unknown === 0 && withCounters >= calls
  }

  /**
   * Compare the ledger against a fresh recount per session. Cached history whose
   * log is gone is reported as "lost" instead of a fake token diff; a real
   * mismatch inside readable logs is still reported as unexplained.
   */
  compareRecount(recount) {
    // A path that could not be read is not evidence of a wrong number: the
    // ledger keeps its cached history for it and the recount cannot see it, so
    // counting it as "lost" or as a diff would both be lies. Such sessions are
    // skipped on both sides instead, and the panel names how many paths failed.
    const unavailable = [...new Set([...(this.unavailable ?? []), ...(recount?.unavailable ?? [])])]
    const skipped = new Set()
    if (unavailable.length > 0) {
      for (const [file, rec] of this.records) {
        if (rec.alias === true) continue
        const id = normalizeSessionId(rec.id)
        if (id !== '' && isUnder(file, unavailable)) skipped.add(id)
      }
    }
    const pending = new Map()
    /** Pending calls past the recount snapshot: only those explain a difference. */
    const pendingOutOfLog = new Map()
    /** Highest live settlement position already held per session. */
    const pendingSeq = new Map()
    const seqs = recount?.seqs instanceof Map ? recount.seqs : undefined
    for (const [id, list] of this.pending) {
      if (skipped.has(id)) continue
      const target = pending.get(id) ?? emptyTotals()
      const outside = pendingOutOfLog.get(id) ?? emptyTotals()
      const cutoff = seqs?.get(id) ?? -1
      for (const entry of list) {
        if (Number.isInteger(entry.seq) && entry.seq > (pendingSeq.get(id) ?? -1)) pendingSeq.set(id, entry.seq)
        addTotals(target, entry.totals)
        // A live settlement the log already holds is counted by both sides; only
        // calls the recount could not see are excluded from the comparison.
        if (!Number.isInteger(entry.seq) || entry.seq > cutoff) addTotals(outside, entry.totals)
      }
      pending.set(id, target)
      pendingOutOfLog.set(id, outside)
    }
    const shown = new Map()
    const missing = new Set()
    for (const rec of this.#ownedRecords()) {
      const id = normalizeSessionId(rec.id)
      if (id === '' || skipped.has(id)) continue
      const target = shown.get(id) ?? emptyTotals()
      addTotals(target, rec.totals)
      shown.set(id, target)
      if (rec.missing === true) missing.add(id)
    }
    for (const [id, totals] of pending) {
      const target = shown.get(id) ?? emptyTotals()
      addTotals(target, totals)
      shown.set(id, target)
    }
    const ids = new Set([...shown.keys(), ...recount.sessions.keys()])
    const shownTotals = emptyTotals()
    const recountTotals = emptyTotals()
    const pendingTotals = emptyTotals()
    // A session the recount saw further along than the ledger means the log kept
    // growing between refresh() and recount(): the difference is scan lag, not a
    // wrong number. Excluding it keeps Verify from flagging an active chat.
    const ledgerSeq = this.#fileSeq()
    const recountSeqs = recount?.seqs instanceof Map ? recount.seqs : undefined
    let lostTokens = 0
    let lostCalls = 0
    let lostFiles = 0
    let unexplainedTokens = 0
    let unexplainedCalls = 0
    let lagging = 0
    for (const id of ids) {
      if (skipped.has(id)) continue
      const recountSeq = recountSeqs?.get(id)
      if (Number.isInteger(recountSeq) && recountSeq > (ledgerSeq.get(id) ?? -1)
        // Growth the ledger's live entries already hold is explained below as
        // pending; only growth past both means Verify is simply a scan behind.
        && recountSeq > (pendingSeq.get(id) ?? -1)) {
        lagging += 1
        continue
      }
      const shownFor = shown.get(id) ?? emptyTotals()
      const recountFor = recount.sessions.get(id) ?? emptyTotals()
      const pendingFor = pending.get(id) ?? emptyTotals()
      const pendingOutsideFor = pendingOutOfLog.get(id) ?? emptyTotals()
      addTotals(shownTotals, shownFor)
      addTotals(recountTotals, recountFor)
      addTotals(pendingTotals, pendingFor)
      const shownTokens = totalTokens(shownFor)
      const recountTokens = totalTokens(recountFor)
      const pendingTokens = totalTokens(pendingOutsideFor)
      if (missing.has(id)) {
        lostFiles += 1
        lostTokens += Math.max(0, shownTokens - recountTokens - pendingTokens)
        lostCalls += Math.max(0, shownFor.calls - recountFor.calls - pendingOutsideFor.calls)
        unexplainedTokens += Math.max(0, recountTokens + pendingTokens - shownTokens)
        unexplainedCalls += Math.max(0, recountFor.calls + pendingOutsideFor.calls - shownFor.calls)
      } else {
        unexplainedTokens += Math.abs(shownTokens - recountTokens - pendingTokens)
        unexplainedCalls += Math.abs(shownFor.calls - recountFor.calls - pendingOutsideFor.calls)
      }
    }
    return {
      shownTotals,
      recountTotals,
      pendingTotals,
      lostTokens,
      lostCalls,
      lostFiles,
      unexplainedTokens,
      unexplainedCalls,
      skippedDirs: new Set(unavailable).size,
      lagging,
    }
  }

  /** Today's token totals by provider + model, biggest first: [[provider, model, tokens]]. */
  todayModels(limit = 6) {
    const byModel = this.modelsByDay.get(this.today())
    if (byModel === undefined) return []
    return [...byModel.entries()]
      .filter(([, tokens]) => Number.isFinite(tokens) && tokens > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key, tokens]) => [...splitModelKey(key), tokens])
  }

  /** How many chats the ledger knows (subagent chats excluded) and the newest event time. */
  meta() {
    let chats = 0
    let files = 0
    let newest = 0
    for (const rec of this.#ownedRecords()) {
      files += 1
      if (rec.origin !== 'subagent') chats += 1
      if (rec.lastTime > newest) newest = rec.lastTime
    }
    for (const list of this.pending.values()) {
      for (const entry of list) if (entry.time > newest) newest = entry.time
    }
    return { chats, files, newest, errors: this.errors, scannedAt: this.scannedAt }
  }

  /**
   * A model call the engine just made (before the session file catches up).
   * `seq` is the log position; entries the file already contains drop out on the next scan.
   */
  noteLive(sessionId, seq, time, usage, model = '', turn = undefined, provider = '', step = undefined, cacheCounters = false) {
    if (this.disposed) return
    const id = normalizeSessionId(sessionId)
    if (id === '') return
    // A malformed live call must never corrupt the ledger: every counter has to
    // be a finite non-negative number, and a non-integral log position means the
    // call can never be matched against the file (the scan counts it instead).
    const totals = liveTotals(usage)
    if (totals === undefined) return
    if (!Number.isInteger(seq) || seq < 0) return
    const at = usableTime(time) ? time : this.now()
    const safeTurn = Number.isInteger(turn) && turn >= 0 ? turn : undefined
    const safeStep = Number.isInteger(step) && step >= 0 ? step : undefined
    const cleanModel = typeof model === 'string' ? model : ''
    const cleanProvider = typeof provider === 'string' ? provider : ''
    const counters = cacheCounters === true
    const zero = totalTokens(totals) === 0
    const position = seq
    const list = this.pending.get(id) ?? []
    // Same call seen twice (engine and file watcher): keep one.
    if (list.some((entry) => entry.seq === position)) return
    const last = this.liveLast.get(id)
    // A retry closed the slot: the next settlement of that turn+step is a new call.
    // 2026-11-28 复审 P2：被 retry 关闭的槽独立记在 closedSlots 里（不依赖 liveLast），
    // 见到这个槽的那次结算就是「另一次调用」，同时把这个关闭标记消费掉。
    const retried = safeStep !== undefined && this.#consumeClosedSlot(id, safeTurn, safeStep)
    const closedSlot = retried || (last !== undefined && last.closed === true && safeStep !== undefined
      && last.turn === safeTurn && last.step === safeStep)
    const sameSlot = !retried && last !== undefined && last.closed !== true && safeStep !== undefined
      && last.turn === safeTurn && last.step === safeStep
    // Same turn+step as the last live settlement: the engine's projection replaces
    // it instead of adding a second call.
    if (zero) {
      // A zero-token settlement replaces its slot with nothing: the provisional
      // call it replaces is no longer billed, and it never adds a call itself.
      if (sameSlot && last.entry !== undefined && list.includes(last.entry)) {
        const index = list.indexOf(last.entry)
        if (index >= 0) list.splice(index, 1)
      }
      // The empty slot still owns its turn+step, so a settlement the log already
      // holds for it has to come off until the log carries this zero itself. That
      // also holds when no live call came first: the log's own last slot is the one
      // this zero replaces.
      const logged = this.slotById.get(id)
      const replacesLogged = !sameSlot && !retried
        && logged !== undefined && logged !== null && logged.counted === true
        && safeStep !== undefined && logged.turn === safeTurn && logged.step === safeStep
        && position > logged.seq
        && !list.some((entry) => entry.turn === safeTurn && entry.step === safeStep)
      const occupant = sameSlot || replacesLogged
        ? {
            seq: position,
            time: at,
            totals,
            model: cleanModel,
            provider: cleanProvider,
            turn: safeTurn,
            step: safeStep,
            cacheCounters: counters,
            void: true,
          }
        : undefined
      if (occupant !== undefined) list.push(occupant)
      if (list.length === 0) this.pending.delete(id)
      else this.pending.set(id, list)
      this.liveLast.set(id, { turn: safeTurn, step: safeStep, entry: occupant, closed: false })
      this.#rebuild()
      this.#scheduleSave()
      this.#emit()
      return
    }
    if (sameSlot && last.entry !== undefined && list.includes(last.entry)) {
      const existing = last.entry
      // 2026-11-28 审查 P1-7：同额重结算也要更新日期与元数据，否则这笔调用会一直挂在
      // 旧的一天上（面板的今日/7 天/30 天窗口跟着错），模型与覆盖也停在旧值。
      const moved = dayKey(existing.time) !== dayKey(at)
        || existing.model !== cleanModel
        || existing.provider !== cleanProvider
        || existing.cacheCounters !== counters
        || existing.void === true
      // 推理 tokens 不计入 bucketsEqual（它在 output 里），只看它时会漏掉刷新。
      const changed = !bucketsEqual(existing.totals, totals) || existing.totals.reasoning !== totals.reasoning
      existing.seq = position
      existing.totals = totals
      if (moved) {
        existing.time = at
        existing.model = cleanModel
        existing.provider = cleanProvider
        existing.cacheCounters = counters
        delete existing.void
        this.liveLast.set(id, { turn: safeTurn, step: safeStep, entry: existing, closed: false })
      }
      if (moved || changed) {
        this.#rebuild()
        this.#emit()
      }
      this.#scheduleSave()
      return
    }
    const entry = {
      seq: position,
      time: at,
      totals,
      model: cleanModel,
      provider: cleanProvider,
      turn: safeTurn,
      step: safeStep,
      cacheCounters: counters,
      // A call made after a retry closed the slot: it must not take the settled value
      // of the log's last slot back.
      ...(closedSlot ? { independent: true } : {}),
    }
    list.push(entry)
    this.pending.set(id, list)
    this.liveLast.set(id, { turn: safeTurn, step: safeStep, entry, closed: false })
    this.#rebuild()
    this.#scheduleSave()
    this.#emit()
  }

  /**
   * A retried request closes the current settlement slot: the next settlement for
   * the same turn+step is a new call, not a replacement of the previous one.
   */
  noteRetryStarted(sessionId, turn, step) {
    if (this.disposed) return
    const id = normalizeSessionId(sessionId)
    if (!Number.isInteger(step)) return
    // 2026-11-28 复审 P2：这一步必须独立于 liveLast。插件在两次事件之间重载、或第一次
    // attempt 只落在日志里时，liveLast 里没有这个槽，原来这次调用就成了空操作，随后到达
    // 的新结算会被当成「替换已入日志的槽」——面板先少算一半，日志追平后再跳上去。
    let closed = this.closedSlots.get(id)
    if (closed === undefined) this.closedSlots.set(id, (closed = new Set()))
    closed.add(slotKey(turn, step))
    this.#scheduleSave()
    const last = this.liveLast.get(id)
    if (last !== undefined && last.turn === turn && last.step === step) {
      this.liveLast.set(id, { turn, step, entry: undefined, closed: true })
    }
  }

  /** Whether this settlement is the one a recorded retry opened the slot for (consumes it). */
  #consumeClosedSlot(id, turn, step) {
    const closed = this.closedSlots.get(id)
    if (closed === undefined) return false
    const key = slotKey(turn, step)
    if (!closed.delete(key)) return false
    if (closed.size === 0) this.closedSlots.delete(id)
    return true
  }

  /** Re-read changed session logs (cheap when nothing changed). Resolves when the pass is done. */
  async refresh() {
    if (this.disposed) return undefined
    if (this.scanning !== undefined) return this.scanning
    this.scanning = this.#scan().finally(() => {
      this.scanning = undefined
    })
    return this.scanning
  }

  /** Flush once and stop writing/emitting: an unmounted instance must not clobber the next one's cache. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    // The next instance reads the cache right after dispose() returns, so this one
    // stays synchronous (bounded by SAVE_LOCK_DISPOSE_WAIT_MS).
    try {
      if (!this.cacheDenied && !this.cacheNewer && this.#cacheInsideHome() && this.#ensureCacheDir() && this.#cacheInsideHome()) {
        this.#saveSync()
      }
    } catch {
      // 缓存写不进去不影响读数
    }
  }

  // ── scanning ──────────────────────────────────────────────────────────────

  async #scan() {
    const firstScan = this.scannedAt === 0
    const { sessions, rootMissing, unavailable } = await this.#sessionFiles()
    if (this.disposed) return
    this.unavailable = rootMissing ? [] : [...new Set(unavailable)].sort()
    const seen = new Set()
    const unresolved = new Set()
    /** Files that still could not be read in this scan (new failures + memoized ones). */
    const failedNow = new Set()
    const tz = currentTzOffset()
    let parsed = 0
    let usableSessions = 0
    let changed = false
    this.emptyLogs = 0
    this.oversizedLogs = 0
    for (const { candidates } of sessions) {
      const evaluated = []
      for (const candidate of candidates) {
        const { file, size, mtimeMs, ctimeMs, version } = candidate
        const known = this.records.get(file)
        const unchanged = known !== undefined
          && known.missing !== true
          && known.mtimeMs === mtimeMs
          && known.size === size
          && (known.ctimeMs === ctimeMs || known.ctimeMs <= 0 || ctimeMs <= 0)
          && known.tzOffset === tz
          && isPlainObject(known.cacheDays)
          && isPlainObject(known.cacheTurns)
        if (unchanged) {
          if (known.partial) failedNow.add(file)
          evaluated.push({ candidate, record: known })
          continue
        }
        const ignored = this.ignored.get(file)
        if (ignored !== undefined && ignored.size === size && ignored.mtimeMs === mtimeMs && ignored.ctimeMs === ctimeMs) {
          // 2026-11-28 审查 P2-2：跳过原因要跟着本轮统计走。原来命中记忆后直接 continue，
          // emptyLogs/oversizedLogs 归零，面板第二次刷新就不再提示「有日志被跳过」。
          if (ignored.kind === 'oversized') this.oversizedLogs += 1
          else if (ignored.kind === 'empty') this.emptyLogs += 1
          continue
        }
        // A generation that already failed to parse is not re-read every poll;
        // any change to its stat gives it another chance.
        const failed = this.failed.get(file)
        if (failed !== undefined && failed.size === size && failed.mtimeMs === mtimeMs && failed.ctimeMs === ctimeMs) {
          failedNow.add(file)
          continue
        }
        if (size === 0) {
          this.emptyLogs += 1
          this.ignored.set(file, { size, mtimeMs, ctimeMs, kind: 'empty' })
          continue
        }
        if (size > this.maxLogBytes) {
          // A real log that big is not worth an OOM on a phone; skip it visibly.
          this.oversizedLogs += 1
          this.ignored.set(file, { size, mtimeMs, ctimeMs, kind: 'oversized' })
          continue
        }
        try {
          const rec = await this.#parse(file)
          if (this.disposed) return
          rec.mtimeMs = mtimeMs
          rec.size = size
          rec.ctimeMs = ctimeMs
          rec.version = version
          this.failed.delete(file)
          if (rec.partial) failedNow.add(file)
          const previous = this.records.get(file)
          const sameSession = previous !== undefined && normalizeSessionId(previous.id) === normalizeSessionId(rec.id)
          if (sameSession && rec.lastSeq < previous.lastSeq) {
            // A rewrite or crash repair that ends earlier must not drop calls we
            // already counted as billed; a later append past the old end adopts
            // the file again.
            previous.mtimeMs = mtimeMs
            previous.size = size
            previous.ctimeMs = ctimeMs
            previous.tzOffset = tz
            delete previous.missing
            delete previous.alias
            this.ignored.delete(file)
            evaluated.push({ candidate, record: previous })
            continue
          }
          delete rec.missing
          delete rec.alias
          this.records.set(file, rec)
          this.ignored.delete(file)
          changed = true
          parsed += 1
          evaluated.push({ candidate, record: rec })
        } catch {
          // 文件正在写、或这一代读不了：留上一份记录，继续试更老的一代。
          this.failed.set(file, { size, mtimeMs, ctimeMs })
          failedNow.add(file)
        }
      }
      if (evaluated.length === 0) {
        // Nothing usable in this session: keep whatever history we already have.
        for (const candidate of candidates) if (this.records.has(candidate.file)) unresolved.add(candidate.file)
        continue
      }
      // Most complete generation wins; a newer header-only/partial generation
      // cannot silently replace a complete older one.
      evaluated.sort((a, b) => b.record.lastSeq - a.record.lastSeq
        || b.candidate.version - a.candidate.version
        || b.candidate.mtimeMs - a.candidate.mtimeMs)
      const winner = evaluated[0]
      usableSessions += 1
      if (winner.record.alias === true) changed = true
      delete winner.record.alias
      seen.add(winner.candidate.file)
      for (const loser of evaluated.slice(1)) {
        if (loser.record.alias !== true) changed = true
        loser.record.alias = true
        seen.add(loser.candidate.file)
        this.records.set(loser.candidate.file, loser.record)
      }
      for (const candidate of candidates) {
        if (seen.has(candidate.file)) continue
        const stale = this.records.get(candidate.file)
        if (stale !== undefined) stale.alias = true
      }
    }
    if (this.disposed) return
    const present = new Set()
    for (const { candidates } of sessions) for (const candidate of candidates) present.add(candidate.file)
    for (const file of [...this.ignored.keys()]) if (!present.has(file)) this.ignored.delete(file)
    for (const file of [...this.failed.keys()]) if (!present.has(file)) this.failed.delete(file)
    // 之前读过、现在文件不在的会话：保留数字，只标记来源消失。
    // A directory or log we could not read is not evidence of a missing log.
    if (!rootMissing) {
      for (const [file, rec] of this.records) {
        if (seen.has(file) || rec.missing === true) continue
        if (unresolved.has(file)) continue
        if (isUnder(file, this.unavailable)) continue
        rec.missing = true
        changed = true
      }
    }
    // Keep the error counters a snapshot of the current state instead of a
    // lifetime total that grows on every poll.
    this.errors = failedNow.size
    this.scanErrors = failedNow.size
    this.#dedupeSessions()
    this.logFiles = usableSessions
    this.rootMissing = rootMissing
    this.parsedFiles = parsed
    this.scannedAt = Date.now()
    this.loaded = true
    this.#rebuild()
    // A warm poll that read nothing new must not rewrite the cache (phones).
    if (changed || parsed > 0 || firstScan) this.#scheduleSave()
    this.#emit()
  }

  /**
   * Session log candidates to read, one entry per session, best generation first.
   * The engine serves the numerically highest generation and keeps older ones as
   * immutable history, so reading every generation would double-count; but when
   * the newest generation is empty or unreadable an older one still holds the
   * history, and the scan falls back to it. `rootMissing` says the sessions root
   * could not be read at all; `unavailable` lists directories that failed.
   */
  async #sessionFiles() {
    const root = path.join(this.home, 'sessions')
    const sessions = []
    let projects
    try {
      projects = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      return { sessions, rootMissing: true, unavailable: [] }
    }
    const unavailable = []
    for (const project of projects) {
      const projectDir = path.join(root, project.name)
      // Never trust the dirent type: on Android proot (and some FUSE/Android
      // filesystems) getdents d_type is unreliable — a regular file can come back
      // as DT_LNK, which made entry.isFile() skip every session log. stat follows
      // what the path really is.
      let projectStat
      try {
        projectStat = await fsp.stat(projectDir)
      } catch {
        unavailable.push(projectDir)
        continue
      }
      if (!projectStat.isDirectory()) {
        // A file where the engine keeps a project directory is a path we cannot
        // read, not evidence that the sessions inside were deleted.
        unavailable.push(projectDir)
        continue
      }
      let sessionDirs
      try {
        sessionDirs = await fsp.readdir(projectDir, { withFileTypes: true })
      } catch {
        unavailable.push(projectDir)
        continue
      }
      for (const session of sessionDirs) {
        const dir = path.join(projectDir, session.name)
        let dirStat
        try {
          dirStat = await fsp.stat(dir)
        } catch {
          unavailable.push(dir)
          continue
        }
        if (!dirStat.isDirectory()) {
          unavailable.push(dir)
          continue
        }
        let entries
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true })
        } catch {
          unavailable.push(dir)
          continue
        }
        const candidates = []
        for (const entry of entries) {
          const match = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(entry.name)
          if (match === null) continue
          const file = path.join(dir, entry.name)
          let st
          try {
            st = await fsp.stat(file) // follows links; d_type is not trusted
          } catch {
            // A broken link/unreadable log is not a deleted log.
            unavailable.push(file)
            continue
          }
          if (!st.isFile()) {
            unavailable.push(file)
            continue
          }
          candidates.push({ file, version: Number(match[1]), size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs > 0 ? st.ctimeMs : 0 })
        }
        if (candidates.length === 0) continue
        // Higher generation first; within one generation the newest file (a
        // compression switch keeps both names) — completeness decides later.
        candidates.sort((a, b) => b.version - a.version || b.mtimeMs - a.mtimeMs)
        sessions.push({ candidates: candidates.slice(0, MAX_GENERATIONS) })
      }
    }
    return { sessions, rootMissing: false, unavailable }
  }

  /**
   * Fold one session log. Lines are streamed through an incremental zstd decoder
   * and a line reader, so a 100 MB+ log costs a bounded amount of memory instead
   * of being decompressed and split whole. Settlement order and the engine's
   * replacement rule are preserved:
   * - a later settlement for the same turn+step replaces the previous one unless
   *   a `llm/retry-started` marker closed that slot;
   * - an identical re-settlement is ignored;
   * - a seeded (forked) log skips everything up to its inherited `session/end-seed`
   *   marker, because the parent's own log already bills that prefix.
   */
  async #parse(file) {
    const rec = emptyRecord()
    let seeded = false
    let headerSettled = false
    let cutSettled = false
    let last = null
    /** Settlements seen before the log proves whether its prefix is inherited. */
    const buffered = []
    const itemOf = (event) => {
      if (event?.type === 'llm/retry-started') {
        return { retry: true, turn: event.data?.turn, step: event.data?.step }
      }
      const settlement = settlementOf(event)
      return settlement === undefined ? undefined : { settlement }
    }
    const applyItem = (item) => {
      if (item.retry === true) {
        // Only a settlement slot the engine owns (integer turn+step) can be closed.
        if (last !== null && Number.isInteger(item.step) && last.turn === item.turn && last.step === item.step) last = null
        return
      }
      last = this.#foldSettlement(rec, last, item.settlement)
    }
    for await (let line of this.#lines(file, () => { rec.partial = true })) {
      if (line === '') continue
      if (!headerSettled) {
        headerSettled = true
        if (line.charCodeAt(0) === 0xfeff) line = line.slice(1) // UTF-8 BOM
        // The header is the first record; do not rely on its key order or spacing.
        let header
        try {
          header = JSON.parse(line)
        } catch {
          header = undefined // torn first line: treat the log as ordinary
        }
        if (header !== null && typeof header === 'object' && header.type === 'session') {
          rec.id = typeof header.id === 'string' ? header.id : ''
          rec.origin = typeof header.origin === 'string' ? header.origin : ''
          rec.createdAt = usableTime(header.createdAt) ? header.createdAt : 0
          rec.isSeeded = header.isSeeded === true
          seeded = rec.isSeeded
          continue
        }
      }
      if (seeded && !cutSettled) {
        if (line.includes('"session/end-seed"')) {
          let marker
          try {
            marker = JSON.parse(line)
          } catch {
            marker = undefined
          }
          if (marker?.type === 'session/end-seed') {
            cutSettled = true
            if (marker.data?.inherited === true) {
              // Everything before the marker belongs to the parent.
              rec.inheritedCut = Number.isInteger(marker.seq) ? marker.seq : -1
              buffered.length = 0
              continue
            }
            // A seed marker that does not mark an inherited prefix: count it all.
            for (const item of buffered) applyItem(item)
            buffered.length = 0
            continue
          }
        }
        if (!line.includes('"usage"') && !line.includes('"llm/retry-started"')) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        const item = itemOf(event)
        if (item !== undefined) buffered.push(item)
        continue
      }
      if (line.includes('"session/end-seed"')) {
        let marker
        try {
          marker = JSON.parse(line)
        } catch {
          marker = undefined
        }
        if (marker?.type === 'session/end-seed' && marker.data?.inherited === true) {
          // The header is gone but the inherited-prefix marker survived: whatever
          // was folded before it belongs to the parent and must be dropped.
          rec.isSeeded = true
          rec.inheritedCut = Number.isInteger(marker.seq) ? marker.seq : -1
          rec.days = {}
          rec.models = {}
          rec.turns = {}
          rec.cacheDays = {}
          rec.cacheTurns = {}
          rec.cacheSeen = false
          rec.lastSeq = -1
          rec.lastTime = 0
          rec.totals = emptyTotals()
          last = null
          continue
        }
      }
      if (!line.includes('"usage"') && !line.includes('"llm/retry-started"')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      const item = itemOf(event)
      if (item !== undefined) applyItem(item)
    }
    // 2026-11-25：seeded 日志缺 end-seed（引擎写完前缀就崩/被截断）时不能把前缀再计一次：
    // 父日志已经计过同一批调用，这里 apply 会静默重复计费，recount 同规则也不报差异。
    if (seeded && !cutSettled) {
      rec.tornSeeded = buffered.length > 0
      buffered.length = 0
    }
    rec.totals = emptyTotals()
    for (const bucket of Object.values(rec.days)) addTotals(rec.totals, bucket)
    rec.tzOffset = currentTzOffset()
    // 目录名就是会话 id：文件头缺失或损坏时仍然能对上「本对话」。
    if (rec.id === '') rec.id = path.basename(path.dirname(file))
    return rec
  }

  /**
   * One log's lines. The file is opened non-blocking and checked with fstat on the
   * same descriptor: on a rooted phone a session path may be a FIFO, a device or a
   * symlink to a huge file, and a plain readFile/stat-then-read would block or OOM.
   * Size and line length are capped for the same reason.
   */
  async *#lines(file, onPartial) {
    if (!file.endsWith('.zstd')) {
      yield* this.#rawLines(file)
      return
    }
    const buffer = await this.#readRegularFile(file, this.maxLogBytes, 'zstd: empty log')
    if (buffer.length === 0) throw new Error('zstd: empty log')
    yield* this.#splitLines(this.#decodeFrames(buffer, onPartial))
  }

  /** Stream an uncompressed log in chunks so a big one never lands in memory whole. */
  async *#rawLines(file) {
    const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : (fs.constants.O_NONBLOCK ?? 0))
    let handle
    try {
      handle = await fsp.open(file, flags)
    } catch (error) {
      throw new Error(`cannot open log: ${error?.code ?? error?.message ?? error}`)
    }
    try {
      const st = await handle.stat()
      if (!st.isFile()) throw new Error('log is not a regular file')
      if (st.size > this.maxLogBytes) throw new Error('log is too large')
      if (st.size === 0) throw new Error('empty log')
      // The snapshot size is fixed up front: growth while reading is ignored.
      const stream = handle.createReadStream({ start: 0, end: st.size - 1, autoClose: false })
      try {
        yield* this.#splitLines(stream)
      } finally {
        stream.destroy()
      }
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /** Read at most `limit` bytes of a regular file, refusing FIFO/device/symlink bombs. */
  async #readRegularFile(file, limit, emptyMessage) {
    const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : (fs.constants.O_NONBLOCK ?? 0))
    let handle
    try {
      handle = await fsp.open(file, flags)
    } catch (error) {
      throw new Error(`cannot open log: ${error?.code ?? error?.message ?? error}`)
    }
    try {
      const st = await handle.stat()
      if (!st.isFile()) throw new Error('log is not a regular file')
      if (st.size > limit) throw new Error('log is too large')
      if (st.size === 0) throw new Error(emptyMessage)
      const buffer = Buffer.alloc(st.size)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      // The engine may append while we read; we only take the snapshot size that
      // fstat reported, so growth can never make this read unbounded.
      return offset === buffer.length ? buffer : buffer.subarray(0, offset)
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /** Read a cache file safely: regular file, bounded size, otherwise treated as damaged. */
  #readCacheFile(file) {
    // A cache file that is itself a symlink is never trusted (root hosts: it could
    // point anywhere); it counts as damage and the logs get rescanned instead.
    let link
    try {
      link = fs.lstatSync(file)
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM') return { unreadable: true }
      return { raw: undefined }
    }
    if (!link.isFile()) return { raw: undefined }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
    let fd
    try {
      fd = fs.openSync(file, flags)
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM') return { unreadable: true }
      return { raw: undefined }
    }
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile() || st.size > this.maxCacheBytes || st.dev !== link.dev || st.ino !== link.ino) return { raw: undefined }
      // 2026-11-28 审查 P1-5：lstat/inode 检查看不出硬链接——同一个 inode 可能另有名字在 home
      // 外面。收紧权限会改掉别人的文件，所以只给「只有我们一个名字」的 inode chmod。
      if (st.nlink <= 1) {
        try { fs.fchmodSync(fd, 0o600) } catch { /* best effort */ }
      }
      const buffer = Buffer.alloc(st.size)
      let offset = 0
      while (offset < buffer.length) {
        const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      return { raw: buffer.subarray(0, offset).toString('utf8') }
    } finally {
      try { fs.closeSync(fd) } catch { /* closing is best effort */ }
    }
  }

  /** Decode a zstd frame chain into byte chunks; big frames stream, small ones decode inline. */
  async *#decodeFrames(buffer, onPartial) {
    let decodedFrames = 0
    let total = 0
    try {
      for (const frame of zstdFrames(buffer)) {
        if (frame.length > STREAM_FRAME_BYTES) {
          const stream = Readable.from([frame]).pipe(zlib.createZstdDecompress())
          try {
            for await (const chunk of stream) {
              total += chunk.length
              if (total > this.maxDecodedBytes) throw new Error('decoded log is too large')
              yield chunk
            }
          } finally {
            stream.destroy()
          }
        } else {
          const out = zlib.zstdDecompressSync(frame, {
            maxOutputLength: Math.max(1, this.maxDecodedBytes - total),
          })
          total += out.length
          if (total > this.maxDecodedBytes) throw new Error('decoded log is too large')
          yield out
        }
        decodedFrames += 1
      }
    } catch (error) {
      // Frames that decoded before the tear are committed data; only a log with
      // no readable frame at all is a real unreadable file.
      if (decodedFrames === 0 || !(error instanceof ZstdTruncatedError)) throw error
      onPartial()
    }
  }

  /** Turn byte chunks into lines, carrying a partial line across chunk boundaries. */
  async *#splitLines(chunks) {
    let carry = null
    let discarding = false
    let lineCount = 0
    for await (const decoded of chunks) {
      const chunk = carry === null ? decoded : Buffer.concat([carry, decoded])
      carry = null
      let start = 0
      for (;;) {
        const newline = chunk.indexOf(0x0a, start)
        if (newline === -1) break
        if (!discarding) {
          lineCount += 1
          if (lineCount > this.maxLines) throw new Error('too many log lines')
          yield chunk.toString('utf8', start, newline)
        }
        discarding = false
        start = newline + 1
      }
      if (start < chunk.length) {
        const rest = chunk.subarray(start)
        if (rest.length > this.maxLineBytes) {
          // A single line that big is not a usage record; dropping it keeps a
          // crafted log from exhausting memory.
          discarding = true
        } else {
          carry = rest
        }
      }
    }
    if (carry !== null && !discarding) yield carry.toString('utf8')
  }

  /** A settlement's day-stable time: the event's own, else the session start, else now. */
  #timeOf(settlement, rec) {
    if (usableTime(settlement.time)) return settlement.time
    if (usableTime(rec.createdAt)) return rec.createdAt
    return this.now()
  }

  /**
   * Apply one settlement to a record with the engine's replacement rule.
   * A zero-token settlement is never billed and adds no call, but the engine's
   * projection still lets it replace the slot for its turn+step (add-replacing
   * with zero buckets). Tracking that slot keeps token totals identical to the
   * engine on logs where a failed attempt reports zero usage.
   */
  #foldSettlement(rec, last, settlement) {
    if (settlement.rejected === true) {
      // 2026-11-28 审查 P2-3：计数超出可计费范围（1e308、小数、负数）不洗成 0 也不记一笔：
      // 跳过这次结算，把日志标成不完整，面板照旧提示「日志读不全」。
      rec.partial = true
      return last
    }
    const time = this.#timeOf(settlement, rec)
    const entry = { ...settlement, time, counted: false }
    // Replacement needs a real settlement slot; events without turn+step are
    // independent calls (the engine's projection keys the slot the same way).
    const sameSlot = last !== null && entry.step !== undefined
      && last.turn === entry.turn && last.step === entry.step
    if (sameSlot) {
      const sameBuckets = bucketsEqual(last.totals, entry.totals)
      // 2026-11-28 审查 P1-7 / CHANGELOG 0.3.5：同额重结算落在另一天（或换了模型/缓存口径）
      // 时，账要跟着重结算的时间迁移，否则今日/近 7/30 天窗口把这笔算在旧的一天。
      const sameBooking = dayKey(last.time) === dayKey(time)
        && last.model === entry.model
        && last.provider === entry.provider
        && last.cacheCounters === entry.cacheCounters
        // reasoning 含在 output 里，bucketsEqual 看不出来，但它要跟着重结算更新。
        && last.totals.reasoning === entry.totals.reasoning
      if (sameBuckets && sameBooking) {
        // Same numbers re-settled: the call is counted once, but the log position
        // moved, so the provisional live entry must still be dropped later.
        if (entry.seq > rec.lastSeq) rec.lastSeq = entry.seq
        if (time > rec.lastTime) rec.lastTime = time
        last.seq = entry.seq
        // The identical settlement was ignored, so its original bucket and
        // metadata remain authoritative for any later replacement.
        rec.lastSlot = last
        return last
      }
      // Subtract the settlement this one replaces (if it was billed at all).
      if (last.counted === true) this.#applySettlement(rec, last, -1)
    }
    if (totalTokens(entry.totals) > 0) {
      entry.counted = true
      this.#applySettlement(rec, entry, 1)
      if (entry.cacheCounters) rec.cacheSeen = true
    }
    if (entry.seq > rec.lastSeq) rec.lastSeq = entry.seq
    if (time > rec.lastTime) rec.lastTime = time
    rec.lastSlot = entry
    return entry
  }

  // ── aggregates ────────────────────────────────────────────────────────────

  /** File log position per normalized session id (the highest one recorded). */
  #fileSeq() {
    const out = new Map()
    for (const rec of this.#ownedRecords()) {
      const id = normalizeSessionId(rec.id)
      if (id === '') continue
      const known = out.get(id) ?? -1
      if (rec.lastSeq > known) out.set(id, rec.lastSeq)
    }
    return out
  }

  /** Records that feed the numbers; duplicated copies of a session are aliases. */
  #ownedRecords() {
    const out = []
    for (const rec of this.records.values()) if (rec.alias !== true) out.push(rec)
    return out
  }

  /**
   * One session id owns one record. The same session can show up under two paths
   * — a moved or copied `$DSH_HOME`, a relocated session directory, a renamed
   * project directory — and those copies describe the same calls, so counting
   * both would double the history. Keep the copy whose log is still on disk and
   * is the most complete; the others are aliases of it.
   */
  #dedupeSessions() {
    const byId = new Map()
    for (const [file, rec] of this.records) {
      const id = normalizeSessionId(rec.id)
      if (id === '') continue
      let list = byId.get(id)
      if (list === undefined) byId.set(id, (list = []))
      list.push({ file, rec })
    }
    for (const list of byId.values()) {
      if (list.length === 1) {
        // A surviving copy is the owner even if it was an alias before.
        delete list[0].rec.alias
        continue
      }
      list.sort((a, b) => {
        // Most complete first: losing history to a stale copy is worse than
        // re-reading a file that no longer exists.
        if (a.rec.lastSeq !== b.rec.lastSeq) return b.rec.lastSeq - a.rec.lastSeq
        // 2026-11-28 审查 P2-3：同一会话的两份日志一样长时，引擎读的是版本号更高那一代；
        // 原来按文件大小/名字挑，可能把旧代际当成主记录，等于丢掉了最新的结算。
        if ((a.rec.version ?? 0) !== (b.rec.version ?? 0)) return (b.rec.version ?? 0) - (a.rec.version ?? 0)
        const aMissing = a.rec.missing === true ? 1 : 0
        const bMissing = b.rec.missing === true ? 1 : 0
        if (aMissing !== bMissing) return aMissing - bMissing
        if ((a.rec.size ?? 0) !== (b.rec.size ?? 0)) return (b.rec.size ?? 0) - (a.rec.size ?? 0)
        return a.file < b.file ? -1 : a.file > b.file ? 1 : 0
      })
      delete list[0].rec.alias
      // Keep the other copies as aliases (not records) so a warm scan skips
      // re-reading them on every pass.
      for (const alias of list.slice(1)) alias.rec.alias = true
    }
  }

  /** Add one settlement's buckets (sign 1) or take them back (sign -1). */
  #applySettlement(rec, settlement, sign) {
    // Settlements reach here with a normalized (finite, in-range) time, so the
    // day used for the add and the later subtract is identical.
    const time = usableTime(settlement.time) ? settlement.time : this.#timeOf(settlement, rec)
    const day = dayKey(time)
    const bucket = rec.days[day] ?? (rec.days[day] = emptyTotals())
    for (const key of Object.keys(bucket)) bucket[key] += sign * (settlement.totals[key] ?? 0)
    if (settlement.model !== '') {
      const byModel = rec.models[day] ?? (rec.models[day] = {})
      const key = modelKey(settlement.provider, settlement.model)
      byModel[key] = (byModel[key] ?? 0) + sign * totalTokens(settlement.totals)
    }
    if (settlement.turn !== undefined && settlement.turn >= 0) {
      const turnBucket = rec.turns[settlement.turn] ?? (rec.turns[settlement.turn] = emptyTotals())
      for (const key of Object.keys(turnBucket)) turnBucket[key] += sign * (settlement.totals[key] ?? 0)
    }
    if (settlement.cacheCounters === true) {
      rec.cacheDays[day] = (rec.cacheDays[day] ?? 0) + sign
      if (rec.cacheDays[day] <= 0) delete rec.cacheDays[day]
      // 2026-11-28 审查 P2-1：命中率的分子（cached）只有上报方贡献，分母也只能用这些
      // 调用自己的 prompt，否则中转不上报的输入会把比例算小。
      rec.cachePrompt = isPlainObject(rec.cachePrompt) ? rec.cachePrompt : {}
      rec.cachePrompt[day] = (rec.cachePrompt[day] ?? 0) + sign * promptTokens(settlement.totals)
      if (rec.cachePrompt[day] <= 0) delete rec.cachePrompt[day]
      if (settlement.turn !== undefined && settlement.turn >= 0) {
        rec.cacheTurns[settlement.turn] = (rec.cacheTurns[settlement.turn] ?? 0) + sign
        if (rec.cacheTurns[settlement.turn] <= 0) delete rec.cacheTurns[settlement.turn]
        rec.cachePromptTurns = isPlainObject(rec.cachePromptTurns) ? rec.cachePromptTurns : {}
        rec.cachePromptTurns[settlement.turn] = (rec.cachePromptTurns[settlement.turn] ?? 0) + sign * promptTokens(settlement.totals)
        if (rec.cachePromptTurns[settlement.turn] <= 0) delete rec.cachePromptTurns[settlement.turn]
      }
    }
  }

  #rebuild() {
    this.days.clear()
    this.sessions.clear()
    this.modelsByDay.clear()
    this.sessionTurns.clear()
    this.cacheDays.clear()
    this.cacheSessions.clear()
    this.cacheTurns.clear()
    this.cachePromptDays.clear()
    this.cachePromptSessions.clear()
    this.cachePromptTurns.clear()
    this.cacheUnknownDays.clear()
    this.cacheUnknownSessions.clear()
    this.cacheUnknownTurns.clear()
    this.slotById.clear()
    this.allCalls = 0
    this.allCacheCalls = 0
    this.allCacheUnknown = 0
    /** normalized session id -> the record that owns it (one per id after dedupe). */
    const owners = new Map()
    for (const rec of this.#ownedRecords()) {
      const id = normalizeSessionId(rec.id)
      for (const [day, bucket] of Object.entries(rec.days)) {
        const target = this.days.get(day) ?? this.days.set(day, emptyTotals()).get(day)
        addTotals(target, bucket)
      }
      for (const [day, models] of Object.entries(rec.models)) {
        let byModel = this.modelsByDay.get(day)
        if (byModel === undefined) this.modelsByDay.set(day, (byModel = new Map()))
        for (const [model, tokens] of Object.entries(models)) byModel.set(model, (byModel.get(model) ?? 0) + tokens)
      }
      if (id !== '') {
        owners.set(id, rec)
        this.slotById.set(id, rec.lastSlot)
        const target = this.sessions.get(id) ?? this.sessions.set(id, emptyTotals()).get(id)
        addTotals(target, rec.totals)
        for (const [turn, bucket] of Object.entries(rec.turns ?? {})) {
          const turns = this.sessionTurns.get(id) ?? this.sessionTurns.set(id, new Map()).get(id)
          const known = turns.get(Number(turn)) ?? turns.set(Number(turn), emptyTotals()).get(Number(turn))
          addTotals(known, bucket)
        }
      }
      // Cache-counter coverage: a record without maps has unknown counters for
      // its calls; that only makes the windows it covers read "—".
      if (!isPlainObject(rec.cacheDays) || !isPlainObject(rec.cacheTurns)) {
        // 2026-11-27 全检 P2：allCacheUnknown 原来只初始化、从不累加（恒 0），
        // allCacheCoverage().unknown 永远报 0。这里把整条记录的调用数计入未知。
        this.allCacheUnknown += rec.totals.calls
        for (const [day, bucket] of Object.entries(rec.days)) {
          this.cacheUnknownDays.set(day, (this.cacheUnknownDays.get(day) ?? 0) + bucket.calls)
        }
        if (id !== '') {
          this.cacheUnknownSessions.set(id, (this.cacheUnknownSessions.get(id) ?? 0) + rec.totals.calls)
          let unknownTurns = this.cacheUnknownTurns.get(id)
          for (const [turn, bucket] of Object.entries(rec.turns ?? {})) {
            if (unknownTurns === undefined) this.cacheUnknownTurns.set(id, (unknownTurns = new Map()))
            const turnNumber = Number(turn)
            unknownTurns.set(turnNumber, (unknownTurns.get(turnNumber) ?? 0) + bucket.calls)
          }
        }
        continue
      }
      let recordCacheCalls = 0
      let recordPrompt = 0
      for (const [day, count] of Object.entries(rec.cacheDays)) {
        if (!Number.isFinite(count) || count <= 0) continue
        this.cacheDays.set(day, (this.cacheDays.get(day) ?? 0) + count)
        recordCacheCalls += count
      }
      for (const [day, prompt] of Object.entries(rec.cachePrompt ?? {})) {
        if (!Number.isFinite(prompt) || prompt <= 0) continue
        this.cachePromptDays.set(day, (this.cachePromptDays.get(day) ?? 0) + prompt)
        recordPrompt += prompt
      }
      if (id !== '') {
        this.cacheSessions.set(id, (this.cacheSessions.get(id) ?? 0) + recordCacheCalls)
        if (recordPrompt > 0) this.cachePromptSessions.set(id, (this.cachePromptSessions.get(id) ?? 0) + recordPrompt)
        let turns = this.cacheTurns.get(id)
        for (const [turn, count] of Object.entries(rec.cacheTurns)) {
          if (!Number.isFinite(count) || count <= 0) continue
          if (turns === undefined) this.cacheTurns.set(id, (turns = new Map()))
          const turnNumber = Number(turn)
          turns.set(turnNumber, (turns.get(turnNumber) ?? 0) + count)
        }
        let promptTurns = this.cachePromptTurns.get(id)
        for (const [turn, prompt] of Object.entries(rec.cachePromptTurns ?? {})) {
          if (!Number.isFinite(prompt) || prompt <= 0) continue
          if (promptTurns === undefined) this.cachePromptTurns.set(id, (promptTurns = new Map()))
          const turnNumber = Number(turn)
          promptTurns.set(turnNumber, (promptTurns.get(turnNumber) ?? 0) + prompt)
        }
      }
      this.allCacheCalls += recordCacheCalls
    }
    this.allCalls = totalCalls(this.days)
    const fileSeq = this.#fileSeq()
    for (const [id, list] of this.pending) {
      const offset = fileSeq.get(id) ?? -1
      const kept = []
      // A cached entry without a log position can never be matched against a file.
      const usable = list.filter((entry) => Number.isInteger(entry.seq) && entry.seq >= 0)
      for (const entry of usable) {
        // The file already holds this call: the record above counted it.
        if (entry.seq <= offset) continue
        kept.push(entry)
        // A void entry only owns a cleared slot: it bills nothing and creates no turn.
        if (entry.void === true) continue
        const day = dayKey(entry.time)
        const target = this.days.get(day) ?? this.days.set(day, emptyTotals()).get(day)
        addTotals(target, entry.totals)
        const session = this.sessions.get(id) ?? this.sessions.set(id, emptyTotals()).get(id)
        addTotals(session, entry.totals)
        if (entry.model !== '') {
          let byModel = this.modelsByDay.get(day)
          if (byModel === undefined) this.modelsByDay.set(day, (byModel = new Map()))
          const key = modelKey(entry.provider, entry.model)
          byModel.set(key, (byModel.get(key) ?? 0) + totalTokens(entry.totals))
        }
        if (Number.isInteger(entry.turn)) {
          const turns = this.sessionTurns.get(id) ?? this.sessionTurns.set(id, new Map()).get(id)
          const bucket = turns.get(entry.turn) ?? turns.set(entry.turn, emptyTotals()).get(entry.turn)
          addTotals(bucket, entry.totals)
        }
        if (entry.cacheCounters === true) {
          const prompt = promptTokens(entry.totals)
          this.cacheDays.set(day, (this.cacheDays.get(day) ?? 0) + 1)
          this.cachePromptDays.set(day, (this.cachePromptDays.get(day) ?? 0) + prompt)
          if (id !== '') {
            this.cacheSessions.set(id, (this.cacheSessions.get(id) ?? 0) + 1)
            this.cachePromptSessions.set(id, (this.cachePromptSessions.get(id) ?? 0) + prompt)
          }
          if (Number.isInteger(entry.turn) && id !== '') {
            let turns = this.cacheTurns.get(id)
            if (turns === undefined) this.cacheTurns.set(id, (turns = new Map()))
            turns.set(entry.turn, (turns.get(entry.turn) ?? 0) + 1)
            if (prompt > 0) {
              let promptTurns = this.cachePromptTurns.get(id)
              if (promptTurns === undefined) this.cachePromptTurns.set(id, (promptTurns = new Map()))
              promptTurns.set(entry.turn, (promptTurns.get(entry.turn) ?? 0) + prompt)
            }
          }
        }
      }
      if (kept.length === 0) this.pending.delete(id)
      else this.pending.set(id, kept)
    }
    // 2026-11-28 审查 P1-6：实时重结算的若正是日志里最后一个槽位，引擎的口径是「替换」。
    // 在日志追平之前，那笔已经入日志的旧结算必须先扣掉，否则面板会旧值+新值一起算。
    for (const [id, rec] of owners) {
      const slot = rec.lastSlot
      if (slot === null || slot.counted !== true || slot.step === undefined) continue
      const list = this.pending.get(id)
      if (list === undefined) continue
      let occupant
      for (const entry of list) {
        if (entry.turn !== slot.turn || entry.step !== slot.step) continue
        if (!(entry.seq > slot.seq)) continue
        // A call made after `llm/retry-started` closed the slot is not a replacement.
        if (entry.independent === true) continue
        if (occupant === undefined || entry.seq > occupant.seq) occupant = entry
      }
      if (occupant !== undefined) this.#unbookSlot(rec, slot)
    }
    this.allCalls = totalCalls(this.days)
    this.allCacheCalls = [...this.cacheDays.values()].reduce((sum, count) => sum + count, 0)
  }

  /**
   * Take one settlement slot back out of the aggregates, because a newer settlement
   * of the same turn+step is live and the engine's projection replaces rather than
   * adds. Mirrors #applySettlement, one level up (aggregates instead of a record).
   */
  #unbookSlot(rec, slot) {
    const time = usableTime(slot.time) ? slot.time : this.#timeOf(slot, rec)
    const day = dayKey(time)
    const id = normalizeSessionId(rec.id)
    const bucket = this.days.get(day)
    if (bucket !== undefined) for (const key of Object.keys(bucket)) bucket[key] -= slot.totals[key] ?? 0
    if (slot.model !== '') {
      const byModel = this.modelsByDay.get(day)
      if (byModel !== undefined) {
        const key = modelKey(slot.provider, slot.model)
        const left = (byModel.get(key) ?? 0) - totalTokens(slot.totals)
        if (left > 0) byModel.set(key, left)
        else byModel.delete(key)
      }
    }
    if (id !== '') {
      const session = this.sessions.get(id)
      if (session !== undefined) for (const key of Object.keys(session)) session[key] -= slot.totals[key] ?? 0
    }
    if (Number.isInteger(slot.turn) && slot.turn >= 0) {
      const turnBucket = this.sessionTurns.get(id)?.get(slot.turn)
      if (turnBucket !== undefined) for (const key of Object.keys(turnBucket)) turnBucket[key] -= slot.totals[key] ?? 0
    }
    if (slot.cacheCounters !== true) return
    const prompt = promptTokens(slot.totals)
    const dec = (map, key, amount) => {
      const left = (map.get(key) ?? 0) - amount
      if (left > 0) map.set(key, left)
      else map.delete(key)
    }
    dec(this.cacheDays, day, 1)
    dec(this.cachePromptDays, day, prompt)
    if (id === '') return
    dec(this.cacheSessions, id, 1)
    dec(this.cachePromptSessions, id, prompt)
    if (!Number.isInteger(slot.turn) || slot.turn < 0) return
    const decTurn = (outer, amount) => {
      const inner = outer.get(id)
      if (inner === undefined) return
      const left = (inner.get(slot.turn) ?? 0) - amount
      if (left > 0) inner.set(slot.turn, left)
      else inner.delete(slot.turn)
    }
    decTurn(this.cacheTurns, 1)
    decTurn(this.cachePromptTurns, prompt)
  }

  #emit() {
    if (this.disposed) return
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        // 一个订阅者出错不影响其他订阅者
      }
    }
  }

  // ── persistence ───────────────────────────────────────────────────────────

  #readCache() {
    let damaged = false
    let denied = false
    for (const file of [this.file, `${this.file}.bak`]) {
      const result = this.#readCacheFile(file)
      if (result.unreadable === true) {
        // Another user (root vs app uid) owns the cache: not damage, but history
        // is unavailable to us and we must not overwrite their file.
        denied = true
        continue
      }
      if (result.raw === undefined) {
        if (fs.existsSync(file)) damaged = true
        continue
      }
      try {
        return { data: JSON.parse(result.raw), damaged: damaged || file.endsWith('.bak'), denied: false }
      } catch {
        damaged = true
      }
    }
    return { data: undefined, damaged, denied }
  }

  #load() {
    try {
      if (!this.#cacheInsideHome()) {
        this.cacheDamaged = true
        return
      }
      const { data, damaged, denied } = this.#readCache()
      this.cacheDamaged = damaged
      this.cacheDenied = denied
      this.cacheDropped = 0
      // Tighten the directory through a no-follow descriptor, not its path.
      try {
        const fd = fs.openSync(this.dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0))
        try { if (fs.fstatSync(fd).isDirectory()) fs.fchmodSync(fd, 0o700) } finally { fs.closeSync(fd) }
      } catch { /* best effort */ }
      // Files are tightened on their verified, no-follow descriptor in #readCacheFile.
      // v6/v7 caches are still valid history; their records gain the newer fields
      // through the defaults below and a re-read of the logs still on disk.
      if (!isPlainObject(data)) return
      // 2026-11-28 复审 P3：缓存比自己新时只读不写。旧版本（0.3.5 认 v9）否则会整份丢弃、
      // 再用旧格式覆盖回去，把 lastSlot/cachePrompt 和未落盘的实时调用一起抹掉。
      if (Number.isInteger(data.v) && data.v > INDEX_VERSION) {
        this.cacheNewer = true
        return
      }
      if (![INDEX_VERSION, 9, 8, 7, 6].includes(data?.v)) return
      if (!isPlainObject(data.files)) return
      for (const [file, rec] of Object.entries(data.files)) {
        const restored = restoreRecord(rec)
        if (restored === undefined) {
          this.cacheDropped += 1
          continue
        }
        // A cache written by an older layout cannot be trusted for day boundaries
        // (nor for the coverage fields added later): force a re-read of the logs.
        restored.tzOffset = data.v === INDEX_VERSION && Number.isFinite(rec.tzOffset) ? rec.tzOffset : NO_TZ
        this.records.set(file, restored)
      }
      // Live calls saved before a restart: without their log they are the only
      // record of those calls, so they must not evaporate on reload.
      if (data.v >= 7 && typeof data.pending === 'object' && data.pending !== null) {
        for (const [id, list] of Object.entries(data.pending)) {
          if (!Array.isArray(list)) continue
          const entries = []
          for (const entry of list) {
            const restored = restorePending(entry)
            if (restored !== undefined) entries.push(restored)
          }
          if (entries.length > 0) this.pending.set(id, entries)
        }
      }
      // The slot the last live settlement owned, so a restart still replaces instead
      // of adding a second call for the same turn+step (2026-11-28 审查 P1-6).
      if (isPlainObject(data.slots)) {
        for (const [id, state] of Object.entries(data.slots)) {
          if (!isPlainObject(state)) continue
          const list = this.pending.get(id) ?? []
          const entry = Number.isInteger(state.seq) ? list.find((item) => item.seq === state.seq) : undefined
          this.liveLast.set(id, {
            turn: Number.isInteger(state.turn) ? state.turn : undefined,
            step: Number.isInteger(state.step) ? state.step : undefined,
            entry,
            closed: entry === undefined && state.closed === true,
          })
        }
      }
      // Slots a retry closed must survive a restart too: the settlement that follows
      // is an extra call, not a replacement of the one already in the log.
      if (isPlainObject(data.closedSlots)) {
        for (const [id, keys] of Object.entries(data.closedSlots)) {
          if (!Array.isArray(keys)) continue
          const clean = keys.filter((key) => typeof key === 'string' && key !== '')
          if (clean.length > 0) this.closedSlots.set(id, new Set(clean))
        }
      }
      this.loaded = true
      this.#dedupeSessions()
      this.#rebuild()
    } catch {
      // 没有缓存或缓存坏了：当作第一次运行，等 refresh() 扫盘。
    }
  }

  /** The cache is a convenience, never a way to write outside `$DSH_HOME`. */
  #cacheInsideHome() {
    if (isPseudoFsPath(this.home) || isPseudoFsPath(this.dir)) return false
    let homeReal
    try {
      homeReal = fs.realpathSync(this.home)
    } catch {
      // No such home: the plugin never creates `$DSH_HOME` itself.
      return false
    }
    const inside = (real) => real === homeReal || real.startsWith(homeReal + path.sep)
    // 2026-11-28 审查 P1-4：目录还不存在时不能直接返回 true——`$DSH_HOME/cache` 可能是指向
    // home 外面的软链，mkdir 之后一切就都建到外面去了。这里走到最近一个存在的祖先，用它的
    // 真实路径判断；祖先在 home 内，后面逐级创建的每一段才在 home 内。
    let probe = path.resolve(this.dir)
    for (let depth = 0; depth < 64; depth += 1) {
      try {
        return inside(fs.realpathSync(probe))
      } catch {
        const parent = path.dirname(probe)
        if (parent === probe) return false
        probe = parent
      }
    }
    return false
  }

  #scheduleSave() {
    if (this.disposed) return
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.#save()
    }, this.saveDebounceMs)
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  /**
   * Create `home/cache/dsh-go-token-usage` step by step. Never `mkdir -p` an
   * arbitrary path: Node's recursive mkdir hangs the event loop on pseudo
   * filesystems (/proc, /sys, /dev), and the plugin must not create `$DSH_HOME`.
   */
  #ensureCacheDir() {
    if (isPseudoFsPath(this.dir) || isPseudoFsPath(this.home)) return false
    const targets = [path.join(this.home, 'cache'), this.dir]
    /** Only a directory we just created must be a real one (no symlink swap window). */
    const isRealDir = (target) => {
      try {
        return fs.lstatSync(target).isDirectory()
      } catch {
        return false
      }
    }
    for (const target of targets) {
      let st
      try {
        st = fs.statSync(target)
      } catch {
        st = undefined
      }
      if (st !== undefined) {
        // 2026-11-28 复审 P2：已存在的项用 stat（跟随软链）判断——`$DSH_HOME/cache` 指向
        // home 内另一个目录是合法布局（原来 lstat 拒软链，缓存会静默永远不写）。
        // 边界仍由 #cacheInsideHome() 的真实路径判定把关。
        if (!st.isDirectory()) return false
        if (!this.#cacheInsideHome()) return false
        continue
      }
      try {
        fs.mkdirSync(target, { mode: 0o700 })
      } catch (error) {
        if (error?.code !== 'EEXIST') return false
      }
      if (!isRealDir(target)) return false
      if (!this.#cacheInsideHome()) return false
    }
    return true
  }

  #save() {
    try {
      // Never clobber a cache we could not read (another user owns it).
      if (this.cacheDenied) return
      if (this.cacheNewer) return
      if (!this.#cacheInsideHome()) return
      if (!this.#ensureCacheDir()) return
      if (!this.#cacheInsideHome()) return
      // 2026-11-28 审查 P1-3：保存不是「写自己的快照」，而是「加锁 → 重读最新索引 → 按
      // 会话/seq 合并 → 原子替换」。两个实例各自拿旧快照覆盖时，丢掉的账在日志被清理后
      // 再也回不来，所以整个读改写必须是一个跨进程事务。
      // 复审 P2：等待改成异步——插件跑在引擎主进程里，同步 sleep 会把面板和工具调用一起冻住。
      if (this.savePromise !== undefined) {
        this.#scheduleSave()
        return
      }
      this.savePromise = this.#saveAsync().catch(() => {}).finally(() => {
        this.savePromise = undefined
      })
    } catch {
      // 缓存写不进去不影响读数
    }
  }

  /** Async save: poll for the lock without blocking the host's event loop. */
  async #saveAsync() {
    const deadline = Date.now() + SAVE_LOCK_WAIT_MS
    for (;;) {
      const lock = this.#acquireLock()
      if (lock.ok) {
        try {
          return this.#writeCache(lock)
        } finally {
          this.#releaseLock(lock)
        }
      }
      if (lock.reason === 'blocked') {
        // A foreign object owns the lock path: report it instead of failing silently.
        this.cacheLocked = true
        return false
      }
      if (this.disposed || Date.now() >= deadline) {
        // Another instance is still saving: leave the snapshot for the next debounce.
        if (!this.disposed) this.#scheduleSave()
        return false
      }
      await new Promise((resolve) => { setTimeout(resolve, SAVE_LOCK_RETRY_MS).unref?.() })
    }
  }

  /**
   * Final flush on dispose(). Bounded synchronous wait: the next instance reads the
   * cache immediately after dispose() returns, so this one cannot be a promise.
   */
  #saveSync() {
    const deadline = Date.now() + SAVE_LOCK_DISPOSE_WAIT_MS
    for (;;) {
      const lock = this.#acquireLock()
      if (lock.ok) {
        try {
          return this.#writeCache(lock)
        } finally {
          this.#releaseLock(lock)
        }
      }
      if (lock.reason === 'blocked') {
        this.cacheLocked = true
        return false
      }
      if (Date.now() >= deadline) return false
      sleepSync(SAVE_LOCK_RETRY_MS)
    }
  }

  /**
   * Take `<index>.lock`, or say why not. Never follows a symlink, never removes a lock
   * that another user owns, and only steals a lock whose owner is gone.
   * @returns {{ ok: true, file: string, ino: number } | { ok: false, reason: 'busy'|'blocked' }}
   */
  #acquireLock() {
    const file = `${this.file}.lock`
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let fd
      try {
        fd = fs.openSync(file, flags, 0o600)
      } catch (error) {
        if (error?.code !== 'EEXIST') return { ok: false, reason: 'blocked' }
        const seen = this.#lockState(file, uid)
        if (seen.state === 'foreign') return { ok: false, reason: 'blocked' }
        if (seen.state !== 'stale') return { ok: false, reason: 'busy' }
        // Steal, but only the exact inode we judged dead: re-lstat right before the
        // unlink, so a lock that was re-created meanwhile is left alone.
        try {
          const again = fs.lstatSync(file)
          if (again.ino !== seen.ino || again.dev !== seen.dev) return { ok: false, reason: 'busy' }
          fs.unlinkSync(file)
        } catch {
          return { ok: false, reason: 'busy' }
        }
        continue
      }
      let ino
      try {
        ino = fs.fstatSync(fd).ino
        // The owner is recorded inside the file: a waiter can then tell a crashed
        // holder from a frozen one, instead of trusting mtime alone.
        fs.writeSync(fd, `${process.pid} ${PROCESS_START_TICK}\n`)
      } catch {
        // The lock still exists even if the note could not be written.
      } finally {
        try { fs.closeSync(fd) } catch { /* ignore */ }
      }
      return { ok: true, file, ino }
    }
    return { ok: false, reason: 'busy' }
  }

  /**
   * What is sitting at the lock path right now.
   * `foreign` = not ours to touch (symlink, directory, another user's file);
   * `busy` = a live holder (or a fresh file);
   * `stale` = old enough and its owner is gone.
   */
  #lockState(file, uid) {
    let st
    try {
      st = fs.lstatSync(file)
    } catch (error) {
      return { state: error?.code === 'ENOENT' ? 'missing' : 'foreign' }
    }
    if (!st.isFile() || (uid !== undefined && st.uid !== uid)) return { state: 'foreign' }
    const age = Date.now() - st.mtimeMs
    const owner = readLockOwner(file)
    // 2026-11-28 复审 P1：mtime 只在创建时写一次，所以「mtime 很旧」不能单独判死——
    // 持锁超过阈值、进程被 SIGSTOP、或校时把时钟往前跳，都会让活锁看起来像陈旧锁。
    // 有属主信息时以「那一进程还在不在」为准；只有完全读不出属主的老锁才退回看 mtime。
    if (owner !== undefined) {
      if (owner.pid !== process.pid) {
        if (!processAlive(owner.pid)) return { state: 'stale', ino: st.ino, dev: st.dev }
        // pid 被复用时，活着的进程已经不是持锁者。
        if (owner.tick > 0) {
          const live = procStartTick(owner.pid)
          if (live !== undefined && live !== owner.tick) return { state: 'stale', ino: st.ino, dev: st.dev }
        }
      }
      // A live holder that has not touched its lock in ANCIENT ms cannot be saving normally.
      if (age > SAVE_LOCK_ANCIENT_MS) return { state: 'stale', ino: st.ino, dev: st.dev }
      return { state: 'busy', ino: st.ino, dev: st.dev }
    }
    if (age > SAVE_LOCK_STALE_MS) return { state: 'stale', ino: st.ino, dev: st.dev }
    return { state: 'busy', ino: st.ino, dev: st.dev }
  }

  /** Release only our own lock: a stolen (re-created) lock file has a different inode. */
  #releaseLock(lock) {
    try {
      const st = fs.lstatSync(lock.file)
      if (st.ino !== lock.ino) return false
      fs.unlinkSync(lock.file)
      return true
    } catch {
      return false
    }
  }

  /** Refresh the lock's mtime so a long critical section does not look abandoned. */
  #touchLock(lock) {
    const now = new Date()
    try { fs.utimesSync(lock.file, now, now) } catch { /* the lock is gone: nothing to refresh */ }
  }

  /** Merge with the cache on disk and atomically replace it. Runs under the lock. */
  #writeCache(lock) {
    const current = this.#readCacheFile(this.file)
    // Another user owns the cache file: reading is impossible, writing would take
    // their history away. The panel already has a line for exactly this state.
    if (current.unreadable === true) {
      this.cacheDenied = true
      return false
    }
    let disk
    if (typeof current.raw === 'string') {
      try {
        disk = JSON.parse(current.raw)
      } catch {
        disk = undefined
      }
    }
    const files = {}
    // Aliases are derived at scan time; writing them would double-count on a
    // downgrade to an older build that does not know the flag.
    for (const [file, rec] of this.records) if (rec.alias !== true) files[file] = rec
    const pending = {}
    for (const [id, list] of this.pending) if (list.length > 0) pending[id] = list
    this.#touchLock(lock)
    const live = this.#slotsForSave()
    const mergedFiles = mergeRecords(files, disk)
    // A log position the record set already covers is settled: keeping it as "pending"
    // would make the entry (and the slot note pointing at it) live forever.
    const settledSeq = new Map()
    for (const raw of Object.values(mergedFiles)) {
      if (!isPlainObject(raw)) continue
      const id = normalizeSessionId(typeof raw.id === 'string' ? raw.id : '')
      if (id === '') continue
      const seq = Number.isInteger(raw.lastSeq) ? raw.lastSeq : -1
      if (seq > (settledSeq.get(id) ?? -1)) settledSeq.set(id, seq)
    }
    const mergedPending = mergePending(pending, disk, settledSeq)
    const body = JSON.stringify({
      v: INDEX_VERSION,
      files: mergedFiles,
      pending: mergedPending,
      slots: mergeSlots(live.slots, isPlainObject(disk) ? disk.slots : undefined, mergedPending),
      closedSlots: { ...(isPlainObject(disk) && isPlainObject(disk.closedSlots) ? disk.closedSlots : {}), ...live.closed },
    })
    const tmp = `${this.file}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`
    let created = false
    try {
      // Write the new snapshot to a temp file and fsync it before touching the
      // live cache, so a crash can never leave a half-written index.json.
      const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
      created = true
      try {
        fs.writeSync(fd, body)
        // fsync of a big snapshot is the slow step; refresh the lock around it so a
        // waiter does not mistake a busy holder for a crashed one.
        this.#touchLock(lock)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      // Keep the previous cache as a fallback, but only when it still parses:
      // a corrupt main file must not replace a good .bak.
      try {
        if (typeof current.raw === 'string') {
          JSON.parse(current.raw)
          fs.renameSync(this.file, `${this.file}.bak`)
        }
      } catch {
        // unreadable/corrupt main file: leave the existing .bak alone (best-effort)
      }
      this.#touchLock(lock)
      fs.renameSync(tmp, this.file)
    } catch (error) {
      if (created) try { fs.unlinkSync(tmp) } catch { /* nothing to clean */ }
      throw error
    }
    // The newly-created temporary file already has private permissions.
    // The cache on disk is now a healthy snapshot: a fallback from .bak (or a
    // corrupt main file) must not keep the panel warning for the whole process.
    this.cacheDamaged = false
    return true
  }

  /**
   * The live settlement slot of each session, so a restart keeps replacing it, plus
   * the slots a retry closed (the next settlement there is an extra call).
   * 复审 P3：只写「还有 pending 的会话 / 还处于关闭状态的槽」，否则 slots 会随历史
   * 会话数无限增长。
   */
  #slotsForSave() {
    const slots = {}
    const closed = {}
    for (const [id, state] of this.liveLast) {
      // 只写「还指向一个未落盘调用」或「还有被 retry 关掉的槽」的会话。
      const holdsPending = state.entry !== undefined && (this.pending.get(id)?.includes(state.entry) ?? false)
      const closedNow = this.closedSlots.get(id)
      if (!holdsPending && (closedNow?.size ?? 0) === 0) continue
      slots[id] = {
        turn: Number.isInteger(state.turn) ? state.turn : null,
        step: Number.isInteger(state.step) ? state.step : null,
        closed: state.closed === true,
        seq: state.entry !== undefined && Number.isInteger(state.entry.seq) ? state.entry.seq : null,
      }
    }
    for (const [id, set] of this.closedSlots) {
      if (set.size > 0) closed[id] = [...set]
    }
    return { slots, closed }
  }
}
