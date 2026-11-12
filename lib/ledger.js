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
import zlib from 'node:zlib'
import { addTotals, bucketsEqual, dayKey, emptyTotals, lastDays, settlementOf, sumDays, totalTokens } from './tally.js'

const INDEX_VERSION = 7
const SAVE_DEBOUNCE_MS = 4000

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

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const emptyRecord = () => ({
  id: '',
  origin: '',
  createdAt: 0,
  days: {},
  models: {},
  turns: {},
  isSeeded: false,
  inheritedCut: -1,
  cacheSeen: false,
  lastSeq: -1,
  lastTime: 0,
  totals: emptyTotals(),
})

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
   * the ledger (the calls were really billed) and `lostTotals` is exactly that
   * portion, which the Verify button subtracts from its recount.
   */
  sourceState() {
    const lostTotals = emptyTotals()
    let lostFiles = 0
    for (const rec of this.records.values()) {
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
      pending: this.pendingCount(),
    }
  }

  /**
   * Re-read every session log from scratch (ignoring the index and the live
   * ledger) and fold the billed usage again. Used by the panel's Verify button:
   * compare with allTime() to prove the numbers come from the logs.
   */
  async recount() {
    const { files } = await this.#sessionFiles()
    // Same de-duplication as the live scan: one session id may show up on two
    // paths (moved $DSH_HOME), and Verify must not count it twice either.
    const parsed = new Map()
    let filesRead = 0
    for (const file of files) {
      let rec
      try {
        rec = await this.#parse(file)
      } catch {
        this.errors += 1
        continue
      }
      filesRead += 1
      const id = normalizeSessionId(rec.id)
      const key = id === '' ? file : `id:${id}`
      const known = parsed.get(key)
      if (known === undefined || rec.lastSeq > known.lastSeq) parsed.set(key, rec)
    }
    const totals = emptyTotals()
    const days = new Map()
    for (const rec of parsed.values()) {
      for (const [day, bucket] of Object.entries(rec.days)) {
        const target = days.get(day) ?? new Map()
        if (!days.has(day)) days.set(day, target)
        const known = target.get('totals') ?? emptyTotals()
        target.set('totals', known)
        addTotals(known, bucket)
        addTotals(totals, bucket)
      }
    }
    return { totals, days, files: filesRead }
  }

  /** Whether any recorded call carried cache counters (some relays omit them). */
  cacheKnown() {
    for (const rec of this.records.values()) if (rec.cacheSeen) return true
    return false
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
    let newest = 0
    for (const rec of this.records.values()) {
      if (rec.origin !== 'subagent') chats += 1
      if (rec.lastTime > newest) newest = rec.lastTime
    }
    for (const list of this.pending.values()) {
      for (const entry of list) if (entry.time > newest) newest = entry.time
    }
    return { chats, files: this.records.size, newest, errors: this.errors, scannedAt: this.scannedAt }
  }

  /**
   * A model call the engine just made (before the session file catches up).
   * `seq` is the log position; entries the file already contains drop out on the next scan.
   */
  noteLive(sessionId, seq, time, usage, model = '', turn = undefined, provider = '', step = undefined) {
    const id = normalizeSessionId(sessionId)
    if (id === '' || usage === undefined) return
    const at = Number.isFinite(time) ? time : this.now()
    const position = Number.isInteger(seq) ? seq : -1
    const list = this.pending.get(id) ?? []
    // Same call seen twice (engine and file watcher): keep one.
    if (list.some((entry) => entry.seq === position && position >= 0)) return
    // Same turn+step as the last live settlement: the engine's projection replaces
    // it instead of adding a second call. Update the provisional entry in place so
    // the panel never double-counts a re-settled attempt.
    const last = this.liveLast.get(id)
    if (last !== undefined && last.turn === turn && last.step === step && last.step !== undefined) {
      const existing = list.includes(last.entry) ? last.entry : undefined
      if (existing !== undefined) {
        if (bucketsEqual(existing.totals, usage)) return
        existing.seq = position
        existing.time = at
        existing.totals = usage
        existing.model = model
        existing.provider = provider
        this.liveLast.set(id, { turn, step, entry: existing })
        this.#rebuild()
        this.#scheduleSave()
        this.#emit()
        return
      }
    }
    const entry = { seq: position, time: at, totals: usage, model, provider, turn, step }
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
    const { files, superseded, rootMissing, unavailable } = await this.#sessionFiles()
    const seen = new Set()
    let parsed = 0
    for (const file of files) {
      seen.add(file)
      let st
      try {
        st = await fsp.stat(file)
      } catch {
        continue
      }
      const known = this.records.get(file)
      if (known !== undefined && known.missing !== true && known.mtimeMs === st.mtimeMs && known.size === st.size) continue
      try {
        const rec = await this.#parse(file, st)
        rec.mtimeMs = st.mtimeMs
        rec.size = st.size
        delete rec.missing
        this.records.set(file, rec)
        parsed += 1
      } catch {
        // 文件正在写、或这一版格式读不了：留着上一份记录，下次再读。
        this.errors += 1
      }
    }
    // 同一会话里被新版日志取代的旧代际：引擎读的是最新一代，旧的那份不再计入。
    for (const file of superseded) this.records.delete(file)
    // 之前读过、现在文件不在的会话：保留数字，只标记来源消失。
    // 会话日志被引擎清理或用户删掉时，历史用量不会因此归零。
    // A directory we could not read is not evidence of a missing log: leave those
    // records alone (a transient unreadable root must not mark everything lost).
    if (!rootMissing) {
      for (const [file, rec] of this.records) {
        if (seen.has(file) || rec.missing === true) continue
        if (unavailable.some((dir) => file.startsWith(dir + path.sep))) continue
        rec.missing = true
      }
    }
    this.#dedupeSessions()
    this.logFiles = files.length
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
   * Session log files to read, one per session: the engine serves the numerically
   * highest format generation and keeps older ones on disk as immutable history,
   * so reading every generation would count the same calls twice. `superseded`
   * lists the files deliberately skipped that way; `rootMissing` says the sessions
   * root could not be read at all.
   */
  async #sessionFiles() {
    const root = path.join(this.home, 'sessions')
    const files = []
    const superseded = []
    let projects
    try {
      projects = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      return { files, superseded, rootMissing: true, unavailable: [] }
    }
    const unavailable = []
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const projectDir = path.join(root, project.name)
      let sessions
      try {
        sessions = await fsp.readdir(projectDir, { withFileTypes: true })
      } catch {
        unavailable.push(projectDir)
        continue
      }
      for (const session of sessions) {
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
          candidates.push({
            file: path.join(dir, entry.name),
            version: Number(match[1]),
            zstd: match[2] === '.zstd',
          })
        }
        if (candidates.length === 0) continue
        candidates.sort((a, b) => b.version - a.version || Number(b.zstd) - Number(a.zstd))
        files.push(candidates[0].file)
        for (const extra of candidates.slice(1)) superseded.push(extra.file)
      }
    }
    return { files, superseded, rootMissing: false, unavailable }
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
        if (last !== null && last.turn === item.turn && last.step === item.step) last = null
        return
      }
      last = this.#foldSettlement(rec, last, item.settlement)
    }
    for await (const line of this.#lines(file)) {
      if (line === '') continue
      if (!headerSettled) {
        headerSettled = true
        if (line.startsWith('{"type":"session"')) {
          try {
            const header = JSON.parse(line)
            if (header.type === 'session') {
              rec.id = typeof header.id === 'string' ? header.id : ''
              rec.origin = typeof header.origin === 'string' ? header.origin : ''
              rec.createdAt = Number.isFinite(header.createdAt) ? header.createdAt : 0
              rec.isSeeded = header.isSeeded === true
              seeded = rec.isSeeded
              continue
            }
          } catch {
            // Not a readable header: fall through and treat the log as ordinary.
          }
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
    // 目录名就是会话 id：文件头缺失或损坏时仍然能对上「本对话」。
    if (rec.id === '') rec.id = path.basename(path.dirname(file))
    return rec
  }

  /** Stream one log's lines: zstd frames decode incrementally, raw logs pass through. */
  async *#lines(file) {
    const stream = fs.createReadStream(file)
    const decoded = file.endsWith('.zstd') ? stream.pipe(zlib.createZstdDecompress()) : stream
    const reader = createInterface({ input: decoded, crlfDelay: Infinity })
    try {
      for await (const line of reader) yield line
    } finally {
      reader.close()
      if (decoded !== stream) decoded.destroy()
      stream.destroy()
    }
  }

  /** Apply one settlement to a record with the engine's replacement rule. */
  #foldSettlement(rec, last, settlement) {
    if (last !== null && last.turn === settlement.turn && last.step === settlement.step) {
      if (bucketsEqual(last.totals, settlement.totals)) return last
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
    for (const rec of this.records.values()) {
      const id = normalizeSessionId(rec.id)
      if (id === '') continue
      const known = out.get(id) ?? -1
      if (rec.lastSeq > known) out.set(id, rec.lastSeq)
      else if (!out.has(id)) out.set(id, known)
    }
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
      if (list.length <= 1) continue
      list.sort((a, b) => {
        const aMissing = a.rec.missing === true ? 1 : 0
        const bMissing = b.rec.missing === true ? 1 : 0
        if (aMissing !== bMissing) return aMissing - bMissing
        if (a.rec.lastSeq !== b.rec.lastSeq) return b.rec.lastSeq - a.rec.lastSeq
        if ((a.rec.size ?? 0) !== (b.rec.size ?? 0)) return (b.rec.size ?? 0) - (a.rec.size ?? 0)
        return a.file < b.file ? -1 : a.file > b.file ? 1 : 0
      })
      for (const alias of list.slice(1)) this.records.delete(alias.file)
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
  }

  #rebuild() {
    this.days.clear()
    this.sessions.clear()
    this.modelsByDay.clear()
    this.sessionTurns.clear()
    for (const rec of this.records.values()) {
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
    }
    const fileSeq = this.#fileSeq()
    for (const [id, list] of this.pending) {
      const offset = fileSeq.get(id) ?? -1
      const kept = []
      for (const entry of list) {
        // The file already holds this call: the record above counted it.
        if (entry.seq >= 0 && entry.seq <= offset) continue
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
      }
      if (kept.length === 0) this.pending.delete(id)
      else this.pending.set(id, kept)
    }
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

  #load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const data = JSON.parse(raw)
      // v6 caches are still valid history: they only lack the saved live entries.
      if (data?.v !== INDEX_VERSION && data?.v !== 6) return
      if (typeof data.files !== 'object' || data.files === null) return
      for (const [file, rec] of Object.entries(data.files)) {
        if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue
        if (!isPlainObject(rec.days)) continue
        const restored = { ...emptyRecord(), ...rec }
        if (!isPlainObject(restored.days)) restored.days = {}
        if (!isPlainObject(restored.models)) restored.models = {}
        if (!isPlainObject(restored.turns)) restored.turns = {}
        let damaged = false
        for (const bucket of Object.values(restored.days)) if (!isPlainObject(bucket)) damaged = true
        if (damaged) continue
        restored.totals = emptyTotals()
        for (const bucket of Object.values(restored.days)) addTotals(restored.totals, bucket)
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
            if (!Number.isInteger(entry.seq) || !Number.isFinite(entry.time)) continue
            if (entry.totals === null || typeof entry.totals !== 'object') continue
            entries.push({
              seq: entry.seq,
              time: entry.time,
              totals: { ...emptyTotals(), ...entry.totals },
              model: typeof entry.model === 'string' ? entry.model : '',
              provider: typeof entry.provider === 'string' ? entry.provider : '',
              turn: Number.isInteger(entry.turn) ? entry.turn : undefined,
              step: Number.isInteger(entry.step) ? entry.step : undefined,
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
      for (const [file, rec] of this.records) files[file] = rec
      const pending = {}
      for (const [id, list] of this.pending) if (list.length > 0) pending[id] = list
      const body = JSON.stringify({ v: INDEX_VERSION, files, pending })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, this.file)
    } catch {
      // 缓存写不进去不影响读数
    }
  }
}
