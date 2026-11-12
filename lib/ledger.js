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
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { addTotals, bucketsEqual, dayKey, emptyTotals, lastDays, settlementOf, sumDays, totalTokens } from './tally.js'

const INDEX_VERSION = 8
const SAVE_DEBOUNCE_MS = 4000
/** Frames larger than this are decoded as a stream so memory stays bounded. */
const STREAM_FRAME_BYTES = 1 << 20

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

const currentTzOffset = () => -new Date().getTimezoneOffset()
/** A cached record from a different timezone must be re-read into the right days. */
const NO_TZ = -9999

const totalCalls = (days) => {
  let calls = 0
  for (const bucket of days.values()) calls += bucket.calls
  return calls
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

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
  isSeeded: false,
  inheritedCut: -1,
  cacheSeen: false,
  lastSeq: -1,
  lastTime: 0,
  tzOffset: NO_TZ,
  totals: emptyTotals(),
})

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
    if (buffer.length - at < 4) throw new Error('zstd: truncated frame magic')
    const magic = buffer.readUInt32LE(at)
    if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
      if (buffer.length - at < 8) throw new Error('zstd: truncated skippable frame')
      const size = buffer.readUInt32LE(at + 4)
      at += 8 + size
      if (at > buffer.length) throw new Error('zstd: truncated skippable frame body')
      continue
    }
    if (magic !== ZSTD_MAGIC) throw new Error('zstd: bad frame magic')
    const start = at
    at += 4
    if (at >= buffer.length) throw new Error('zstd: truncated frame header')
    const descriptor = buffer[at]
    at += 1
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const fcsFlag = descriptor >> 6
    const dictFlag = descriptor & 0x03
    if (!singleSegment) at += 1 // window descriptor
    at += [0, 1, 2, 4][dictFlag] // dictionary id
    at += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag] // frame content size
    if (at > buffer.length) throw new Error('zstd: truncated frame header')
    for (;;) {
      if (buffer.length - at < 3) throw new Error('zstd: truncated block header')
      const header = buffer[at] | (buffer[at + 1] << 8) | (buffer[at + 2] << 16)
      at += 3
      const last = (header & 1) !== 0
      const blockType = (header >> 1) & 0x03
      const blockSize = (header >> 3) & 0x1fffff
      if (blockType === 3) throw new Error('zstd: reserved block type')
      at += blockType === 1 ? 1 : blockSize // RLE blocks carry one byte
      if (at > buffer.length) throw new Error('zstd: truncated block')
      if (last) break
    }
    if (checksum) at += 4
    if (at > buffer.length) throw new Error('zstd: truncated frame checksum')
    yield buffer.subarray(start, at)
  }
}

export class UsageLedger {
  /** @param {{ home?: string, now?: () => number }} [options] */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now())
    this.home = options.home ?? (String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh'))
    this.dir = path.join(this.home, 'cache', 'dsh-go-token-usage')
    this.file = path.join(this.dir, 'index.json')
    /** @type {Map<string, ReturnType<typeof emptyRecord>>} */
    this.records = new Map()
    /** @type {Map<string, Array<{ seq: number, time: number, totals: any, model: string, step?: number }>>} */
    this.pending = new Map()
    /** @type {Map<string, { turn?: number, step?: number, entry: any }>} last live settlement per session */
    this.liveLast = new Map()
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
    /** Cache-counter coverage: counts of calls whose record had unknown coverage. */
    this.cacheUnknownDays = new Map()
    this.cacheUnknownSessions = new Map()
    this.cacheUnknownTurns = new Map()
    this.allCalls = 0
    this.allCacheCalls = 0
    this.allCacheUnknown = 0
    this.scanErrors = 0
    this.emptyLogs = 0
    this.cacheDamaged = false
    /** Files already known to be an unusable generation, with the stat that proved it. */
    this.ignored = new Map()
    this.loaded = false
    this.scanning = undefined
    this.listeners = new Set()
    this.saveTimer = undefined
    this.scannedAt = 0
    this.parsedFiles = 0
    this.errors = 0
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
    for (const list of this.pending.values()) count += list.length
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
      lostFiles,
      lostTotals,
      errors: this.errors,
      scanErrors: this.scanErrors,
      emptyLogs: this.emptyLogs,
      cacheDamaged: this.cacheDamaged,
      pending: this.pendingCount(),
    }
  }

  /**
   * Re-read every session log from scratch (ignoring the index and the live
   * ledger) and fold the billed usage again. Used by the panel's Verify button:
   * compare with allTime() to prove the numbers come from the logs.
   */
  async recount() {
    const { sessions } = await this.#sessionFiles()
    const parsed = new Map()
    let filesRead = 0
    for (const { candidates } of sessions) {
      const usable = []
      for (const candidate of candidates) {
        if (candidate.size === 0) continue
        try {
          usable.push({ candidate, rec: await this.#parse(candidate.file) })
        } catch {
          this.errors += 1
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
      }
    }
    return { totals, days, sessions: bySession, files: filesRead }
  }

  /** Whether every recorded call carried cache counters (some relays omit them). */
  cacheKnown() {
    return this.allCacheKnown()
  }

  /** Whether every call in the whole ledger reported cache counters. */
  allCacheKnown() {
    return this.allCalls > 0 && this.allCacheUnknown === 0 && this.allCacheCalls >= this.allCalls
  }

  /** Whether every call over the last `n` local days reported cache counters. */
  windowCacheKnown(n) {
    let calls = 0
    let cached = 0
    let unknown = 0
    for (const day of lastDays(this.today(), n)) {
      calls += this.days.get(day)?.calls ?? 0
      cached += this.cacheDays.get(day) ?? 0
      unknown += this.cacheUnknownDays.get(day) ?? 0
    }
    return calls > 0 && unknown === 0 && cached >= calls
  }

  /** Whether every call of one chat reported cache counters. */
  sessionCacheKnown(id) {
    const normalized = normalizeSessionId(id)
    const calls = this.sessions.get(normalized)?.calls ?? 0
    const cached = this.cacheSessions.get(normalized) ?? 0
    const unknown = this.cacheUnknownSessions.get(normalized) ?? 0
    return calls > 0 && unknown === 0 && cached >= calls
  }

  /** Whether every call of one turn reported cache counters. */
  turnCacheKnown(id, turn) {
    const normalized = normalizeSessionId(id)
    const calls = this.sessionTurns.get(normalized)?.get(turn)?.calls ?? 0
    const cached = this.cacheTurns.get(normalized)?.get(turn) ?? 0
    const unknown = this.cacheUnknownTurns.get(normalized)?.get(turn) ?? 0
    return calls > 0 && unknown === 0 && cached >= calls
  }

  /**
   * Compare the ledger against a fresh recount per session. Cached history whose
   * log is gone is reported as "lost" instead of a fake token diff; a real
   * mismatch inside readable logs is still reported as unexplained.
   */
  compareRecount(recount) {
    const pending = new Map()
    for (const [id, list] of this.pending) {
      const target = pending.get(id) ?? emptyTotals()
      for (const entry of list) addTotals(target, entry.totals)
      pending.set(id, target)
    }
    const shown = new Map()
    const missing = new Set()
    for (const rec of this.#ownedRecords()) {
      const id = normalizeSessionId(rec.id)
      if (id === '') continue
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
    let lostTokens = 0
    let lostCalls = 0
    let lostFiles = 0
    let unexplainedTokens = 0
    let unexplainedCalls = 0
    for (const id of ids) {
      const shownFor = shown.get(id) ?? emptyTotals()
      const recountFor = recount.sessions.get(id) ?? emptyTotals()
      const pendingFor = pending.get(id) ?? emptyTotals()
      addTotals(shownTotals, shownFor)
      addTotals(recountTotals, recountFor)
      addTotals(pendingTotals, pendingFor)
      const shownTokens = totalTokens(shownFor)
      const recountTokens = totalTokens(recountFor)
      const pendingTokens = totalTokens(pendingFor)
      if (missing.has(id)) {
        lostFiles += 1
        lostTokens += Math.max(0, shownTokens - recountTokens - pendingTokens)
        lostCalls += Math.max(0, shownFor.calls - recountFor.calls - pendingFor.calls)
        unexplainedTokens += Math.max(0, recountTokens + pendingTokens - shownTokens)
        unexplainedCalls += Math.max(0, recountFor.calls + pendingFor.calls - shownFor.calls)
      } else {
        unexplainedTokens += Math.abs(shownTokens - recountTokens - pendingTokens)
        unexplainedCalls += Math.abs(shownFor.calls - recountFor.calls - pendingFor.calls)
      }
    }
    return { shownTotals, recountTotals, pendingTotals, lostTokens, lostCalls, lostFiles, unexplainedTokens, unexplainedCalls }
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
    const id = normalizeSessionId(sessionId)
    if (id === '' || usage === undefined) return
    // Without a durable log position the provisional call can never be matched
    // against the file (and would double-count once the log is parsed), so only
    // the scan counts it.
    if (!Number.isInteger(seq) || seq < 0) return
    const at = Number.isFinite(time) ? time : this.now()
    const position = seq
    const list = this.pending.get(id) ?? []
    // Same call seen twice (engine and file watcher): keep one.
    if (list.some((entry) => entry.seq === position && position >= 0)) return
    // Same turn+step as the last live settlement: the engine's projection replaces
    // it instead of adding a second call. Update the provisional entry in place so
    // the panel never double-counts a re-settled attempt.
    const last = this.liveLast.get(id)
    if (last !== undefined && Number.isInteger(step) && last.turn === turn && last.step === step) {
      const existing = list.includes(last.entry) ? last.entry : undefined
      if (existing !== undefined) {
        if (bucketsEqual(existing.totals, usage)) return
        existing.seq = position
        existing.time = at
        existing.totals = usage
        existing.model = model
        existing.provider = provider
        existing.cacheCounters = cacheCounters === true
        this.liveLast.set(id, { turn, step, entry: existing })
        this.#rebuild()
        this.#scheduleSave()
        this.#emit()
        return
      }
    }
    const entry = { seq: position, time: at, totals: usage, model, provider, turn, step, cacheCounters: cacheCounters === true }
    list.push(entry)
    this.pending.set(id, list)
    this.liveLast.set(id, { turn, step, entry })
    this.#rebuild()
    this.#scheduleSave()
    this.#emit()
  }

  /**
   * A retried request closes the current settlement slot: the next settlement for
   * the same turn+step is a new call, not a replacement of the previous one.
   */
  noteRetryStarted(sessionId, turn, step) {
    const id = normalizeSessionId(sessionId)
    if (!Number.isInteger(step)) return
    const last = this.liveLast.get(id)
    if (last !== undefined && last.turn === turn && last.step === step) this.liveLast.delete(id)
  }

  /** Re-read changed session logs (cheap when nothing changed). Resolves when the pass is done. */
  async refresh() {
    if (this.scanning !== undefined) return this.scanning
    this.scanning = this.#scan().finally(() => {
      this.scanning = undefined
    })
    return this.scanning
  }

  dispose() {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
      this.#save()
    }
  }

  // ── scanning ──────────────────────────────────────────────────────────────

  async #scan() {
    const started = Date.now()
    const { sessions, rootMissing, unavailable } = await this.#sessionFiles()
    const seen = new Set()
    const unresolved = new Set()
    const tz = currentTzOffset()
    let parsed = 0
    let usableSessions = 0
    this.scanErrors = 0
    this.emptyLogs = 0
    for (const { candidates } of sessions) {
      const evaluated = []
      for (const candidate of candidates) {
        const { file, size, mtimeMs, ctimeMs, version } = candidate
        const known = this.records.get(file)
        const unchanged = known !== undefined
          && known.missing !== true
          && known.mtimeMs === mtimeMs
          && known.size === size
          && known.ctimeMs === ctimeMs
          && known.tzOffset === tz
          && isPlainObject(known.cacheDays)
          && isPlainObject(known.cacheTurns)
        if (unchanged) {
          evaluated.push({ candidate, record: known })
          continue
        }
        const ignored = this.ignored.get(file)
        if (ignored !== undefined && ignored.size === size && ignored.mtimeMs === mtimeMs && ignored.ctimeMs === ctimeMs) continue
        if (size === 0) {
          this.emptyLogs += 1
          this.ignored.set(file, { size, mtimeMs, ctimeMs })
          continue
        }
        try {
          const rec = await this.#parse(file)
          rec.mtimeMs = mtimeMs
          rec.size = size
          rec.ctimeMs = ctimeMs
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
          parsed += 1
          evaluated.push({ candidate, record: rec })
        } catch {
          // 文件正在写、或这一代读不了：留上一份记录，继续试更老的一代。
          this.errors += 1
          this.scanErrors += 1
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
      delete winner.record.alias
      seen.add(winner.candidate.file)
      for (const loser of evaluated.slice(1)) {
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
    const present = new Set()
    for (const { candidates } of sessions) for (const candidate of candidates) present.add(candidate.file)
    for (const file of [...this.ignored.keys()]) if (!present.has(file)) this.ignored.delete(file)
    // 之前读过、现在文件不在的会话：保留数字，只标记来源消失。
    // A directory or session we could not read is not evidence of a missing log.
    if (!rootMissing) {
      for (const [file, rec] of this.records) {
        if (seen.has(file) || rec.missing === true) continue
        if (unresolved.has(file)) continue
        if (unavailable.some((dir) => file.startsWith(dir + path.sep))) continue
        rec.missing = true
      }
    }
    this.#dedupeSessions()
    this.logFiles = usableSessions
    this.rootMissing = rootMissing
    this.parsedFiles = parsed
    this.scannedAt = Date.now()
    this.loaded = true
    this.#rebuild()
    this.#scheduleSave()
    this.#emit()
    void started
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
      if (!project.isDirectory()) continue
      const projectDir = path.join(root, project.name)
      let sessionDirs
      try {
        sessionDirs = await fsp.readdir(projectDir, { withFileTypes: true })
      } catch {
        unavailable.push(projectDir)
        continue
      }
      for (const session of sessionDirs) {
        if (!session.isDirectory()) continue
        const dir = path.join(projectDir, session.name)
        let entries
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true })
        } catch {
          unavailable.push(dir)
          continue
        }
        const candidates = []
        for (const entry of entries) {
          if (!entry.isFile()) continue
          const match = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(entry.name)
          if (match === null) continue
          const file = path.join(dir, entry.name)
          let st
          try {
            st = await fsp.stat(file)
          } catch {
            continue
          }
          candidates.push({ file, version: Number(match[1]), size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs })
        }
        if (candidates.length === 0) continue
        // Higher generation first; within one generation the newest file (a
        // compression switch keeps both names) — completeness decides later.
        candidates.sort((a, b) => b.version - a.version || b.mtimeMs - a.mtimeMs)
        sessions.push({ candidates })
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
  async #parse(file, st) {
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
    for await (let line of this.#lines(file)) {
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
          rec.createdAt = Number.isFinite(header.createdAt) ? header.createdAt : 0
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
    // A seeded log without its end marker (torn/foreign): count it, as before.
    if (seeded && !cutSettled) for (const item of buffered) applyItem(item)
    rec.totals = emptyTotals()
    for (const bucket of Object.values(rec.days)) addTotals(rec.totals, bucket)
    rec.tzOffset = currentTzOffset()
    // 目录名就是会话 id：文件头缺失或损坏时仍然能对上「本对话」。
    if (rec.id === '') rec.id = path.basename(path.dirname(file))
    return rec
  }

  /**
   * One log's lines. Raw logs stream through a line reader; compressed logs are
   * split into their zstd frames and decoded one frame at a time, so memory
   * follows the largest batch rather than the whole log, and frame chains work on
   * every runtime. A torn final frame keeps the committed frames before it.
   */
  async *#lines(file) {
    if (!file.endsWith('.zstd')) {
      const stream = fs.createReadStream(file)
      const reader = createInterface({ input: stream, crlfDelay: Infinity })
      try {
        for await (const line of reader) yield line
      } finally {
        reader.close()
        stream.destroy()
      }
      return
    }
    const buffer = await fsp.readFile(file)
    if (buffer.length === 0) throw new Error('zstd: empty log')
    yield* this.#splitLines(this.#decodeFrames(buffer))
  }

  /** Decode a zstd frame chain into byte chunks; big frames stream, small ones decode inline. */
  async *#decodeFrames(buffer) {
    let decodedFrames = 0
    try {
      for (const frame of zstdFrames(buffer)) {
        if (frame.length > STREAM_FRAME_BYTES) {
          const stream = Readable.from([frame]).pipe(zlib.createZstdDecompress())
          try {
            for await (const chunk of stream) yield chunk
          } finally {
            stream.destroy()
          }
        } else {
          yield zlib.zstdDecompressSync(frame)
        }
        decodedFrames += 1
      }
    } catch (error) {
      // Frames that decoded before the tear are committed data; only a log with
      // no readable frame at all is a real unreadable file.
      if (decodedFrames === 0) throw error
    }
  }

  /** Turn byte chunks into lines, carrying a partial line across chunk boundaries. */
  async *#splitLines(chunks) {
    let carry = null
    for await (const decoded of chunks) {
      const chunk = carry === null ? decoded : Buffer.concat([carry, decoded])
      carry = null
      let start = 0
      for (;;) {
        const newline = chunk.indexOf(0x0a, start)
        if (newline === -1) break
        yield chunk.toString('utf8', start, newline)
        start = newline + 1
      }
      if (start < chunk.length) carry = chunk.subarray(start)
    }
    if (carry !== null && carry.length > 0) yield carry.toString('utf8')
  }

  /** Apply one settlement to a record with the engine's replacement rule. */
  #foldSettlement(rec, last, settlement) {
    // Replacement needs a real settlement slot; events without turn+step are
    // independent calls (the engine's projection keys the slot the same way).
    if (last !== null && settlement.step !== undefined && last.turn === settlement.turn && last.step === settlement.step) {
      if (bucketsEqual(last.totals, settlement.totals)) {
        // Same numbers re-settled: the call is counted once, but the log position
        // moved, so the provisional live entry must still be dropped later.
        if (settlement.seq > rec.lastSeq) rec.lastSeq = settlement.seq
        const time = settlement.time > 0 ? settlement.time : rec.createdAt
        if (time > rec.lastTime) rec.lastTime = time
        return last
      }
      this.#applySettlement(rec, last, -1)
    }
    this.#applySettlement(rec, settlement, 1)
    if (settlement.cacheCounters) rec.cacheSeen = true
    if (settlement.seq > rec.lastSeq) rec.lastSeq = settlement.seq
    const time = settlement.time > 0 ? settlement.time : rec.createdAt
    if (time > rec.lastTime) rec.lastTime = time
    return settlement
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
      else if (!out.has(id)) out.set(id, known)
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
    const time = settlement.time > 0 ? settlement.time : rec.createdAt
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
      if (settlement.turn !== undefined && settlement.turn >= 0) {
        rec.cacheTurns[settlement.turn] = (rec.cacheTurns[settlement.turn] ?? 0) + sign
        if (rec.cacheTurns[settlement.turn] <= 0) delete rec.cacheTurns[settlement.turn]
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
    this.cacheUnknownDays.clear()
    this.cacheUnknownSessions.clear()
    this.cacheUnknownTurns.clear()
    this.allCalls = 0
    this.allCacheCalls = 0
    this.allCacheUnknown = 0
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
      for (const [day, count] of Object.entries(rec.cacheDays)) {
        if (!Number.isFinite(count) || count <= 0) continue
        this.cacheDays.set(day, (this.cacheDays.get(day) ?? 0) + count)
        recordCacheCalls += count
      }
      if (id !== '') {
        this.cacheSessions.set(id, (this.cacheSessions.get(id) ?? 0) + recordCacheCalls)
        let turns = this.cacheTurns.get(id)
        for (const [turn, count] of Object.entries(rec.cacheTurns)) {
          if (!Number.isFinite(count) || count <= 0) continue
          if (turns === undefined) this.cacheTurns.set(id, (turns = new Map()))
          const turnNumber = Number(turn)
          turns.set(turnNumber, (turns.get(turnNumber) ?? 0) + count)
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
          this.cacheDays.set(day, (this.cacheDays.get(day) ?? 0) + 1)
          if (id !== '') this.cacheSessions.set(id, (this.cacheSessions.get(id) ?? 0) + 1)
          if (Number.isInteger(entry.turn) && id !== '') {
            let turns = this.cacheTurns.get(id)
            if (turns === undefined) this.cacheTurns.set(id, (turns = new Map()))
            turns.set(entry.turn, (turns.get(entry.turn) ?? 0) + 1)
          }
        }
      }
      if (kept.length === 0) this.pending.delete(id)
      else this.pending.set(id, kept)
    }
    this.allCalls = totalCalls(this.days)
    this.allCacheCalls = [...this.cacheDays.values()].reduce((sum, count) => sum + count, 0)
  }

  #emit() {
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
    let existed = false
    for (const file of [this.file, `${this.file}.bak`]) {
      try {
        const raw = fs.readFileSync(file, 'utf8')
        existed = true
        return { data: JSON.parse(raw), damaged: existed && file.endsWith('.bak') }
      } catch {
        if (fs.existsSync(file)) existed = true
      }
    }
    return { data: undefined, damaged: existed }
  }

  #load() {
    try {
      const { data, damaged } = this.#readCache()
      this.cacheDamaged = damaged
      // v6/v7 caches are still valid history; their records gain the newer fields
      // through the defaults below and a re-read of the logs still on disk.
      if (data?.v !== INDEX_VERSION && data?.v !== 7 && data?.v !== 6) return
      if (typeof data.files !== 'object' || data.files === null) return
      for (const [file, rec] of Object.entries(data.files)) {
        if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue
        // A record that lost its day map is not salvageable history.
        if (rec.days !== undefined && !isPlainObject(rec.days)) continue
        const days = {}
        let damaged = false
        for (const [day, bucket] of Object.entries(isPlainObject(rec.days) ? rec.days : {})) {
          const clean = sanitizeBucket(bucket)
          if (clean === undefined) damaged = true
          else days[day] = clean
        }
        if (damaged) continue
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
        // Coverage maps are optional: caches written before them are "unknown",
        // which keeps the hit rate honest and forces a re-read of present logs.
        const cacheDays = isPlainObject(rec.cacheDays) ? { ...rec.cacheDays } : null
        const cacheTurns = isPlainObject(rec.cacheTurns) ? { ...rec.cacheTurns } : null
        const restored = {
          ...emptyRecord(),
          id: typeof rec.id === 'string' ? rec.id : '',
          origin: typeof rec.origin === 'string' ? rec.origin : '',
          createdAt: Number.isFinite(rec.createdAt) ? rec.createdAt : 0,
          days,
          models,
          turns,
          cacheDays,
          cacheTurns,
          isSeeded: rec.isSeeded === true,
          inheritedCut: Number.isInteger(rec.inheritedCut) ? rec.inheritedCut : -1,
          cacheSeen: rec.cacheSeen === true,
          lastSeq: Number.isInteger(rec.lastSeq) ? rec.lastSeq : -1,
          lastTime: Number.isFinite(rec.lastTime) ? rec.lastTime : 0,
          mtimeMs: Number.isFinite(rec.mtimeMs) ? rec.mtimeMs : 0,
          size: Number.isFinite(rec.size) ? rec.size : 0,
          ctimeMs: Number.isFinite(rec.ctimeMs) ? rec.ctimeMs : -1,
          tzOffset: Number.isFinite(rec.tzOffset) ? rec.tzOffset : NO_TZ,
          // Aliases are a scan-time detail and are never restored from disk.
          missing: rec.missing === true,
        }
        restored.totals = emptyTotals()
        for (const bucket of Object.values(days)) addTotals(restored.totals, bucket)
        this.records.set(file, restored)
      }
      // Live calls saved before a restart: without their log they are the only
      // record of those calls, so they must not evaporate on reload.
      if (data.v >= 7 && typeof data.pending === 'object' && data.pending !== null) {
        for (const [id, list] of Object.entries(data.pending)) {
          if (!Array.isArray(list)) continue
          const entries = []
          for (const entry of list) {
            if (entry === null || typeof entry !== 'object') continue
            if (!Number.isInteger(entry.seq) || entry.seq < 0 || !Number.isFinite(entry.time)) continue
            const totals = sanitizeBucket(entry.totals)
            if (totals === undefined || totals.calls === 0) continue
            entries.push({
              seq: entry.seq,
              time: entry.time,
              totals,
              model: typeof entry.model === 'string' ? entry.model : '',
              provider: typeof entry.provider === 'string' ? entry.provider : '',
              turn: Number.isInteger(entry.turn) ? entry.turn : undefined,
              step: Number.isInteger(entry.step) ? entry.step : undefined,
              cacheCounters: entry.cacheCounters === true,
            })
          }
          if (entries.length > 0) this.pending.set(id, entries)
        }
      }
      this.loaded = true
      this.#dedupeSessions()
      this.#rebuild()
    } catch {
      // 没有缓存或缓存坏了：当作第一次运行，等 refresh() 扫盘。
    }
  }

  #scheduleSave() {
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.#save()
    }, SAVE_DEBOUNCE_MS)
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  #save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const files = {}
      // Aliases are derived at scan time; writing them would double-count on a
      // downgrade to an older build that does not know the flag.
      for (const [file, rec] of this.records) if (rec.alias !== true) files[file] = rec
      const pending = {}
      for (const [id, list] of this.pending) if (list.length > 0) pending[id] = list
      const body = JSON.stringify({ v: INDEX_VERSION, files, pending })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, body)
      // Keep the previous cache as a fallback: an interrupted or corrupted write
      // must not cost the history of logs that are already gone.
      try {
        if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.bak`)
      } catch {
        // the fallback is best-effort
      }
      fs.renameSync(tmp, this.file)
    } catch {
      // 缓存写不进去不影响读数
    }
  }
}
