// 用量账本：把 $DSH_HOME/sessions 下每段对话的 `assistant/message.usage` 折成
// 「每天 / 每个对话」的 token 数，并缓存到 $DSH_HOME/cache/dsh-go-token-usage/index.json。
//
// - 冷数据（历史对话）：扫会话记录文件，按文件的 mtime + size 做增量缓存；
// - 热数据（引擎刚产生的调用）：`session/event` 立刻记账，并记下事件 seq；
//   文件里出现该 seq 之后，这笔临时账自动让位给文件里的真实数据，不会重复计。
//
// 数据源与引擎自己一致，不联网、不估算。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { addTotals, dayKey, emptyTotals, lastDays, sumDays, totalTokens, usageOf } from './tally.js'

const zstd = promisify(zlib.zstdDecompress)
const INDEX_VERSION = 5
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

const emptyRecord = () => ({
  id: '',
  origin: '',
  cwd: '',
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
    /** @type {Map<string, Array<{ seq: number, time: number, totals: any, model: string }>>} */
    this.pending = new Map()
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
   * Re-read every session log from scratch (ignoring the index and the live
   * ledger) and fold the billed usage again. Used by the panel's Verify button:
   * compare with allTime() to prove the numbers come from the logs.
   */
  async recount() {
    const files = await this.#sessionFiles()
    const totals = emptyTotals()
    const days = new Map()
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
  noteLive(sessionId, seq, time, usage, model = '', turn = undefined, provider = '') {
    const id = normalizeSessionId(sessionId)
    if (id === '' || usage === undefined) return
    const at = Number.isFinite(time) ? time : this.now()
    const position = Number.isInteger(seq) ? seq : -1
    const list = this.pending.get(id) ?? []
    // Same call seen twice (engine and file watcher): keep one.
    if (list.some((entry) => entry.seq === position && position >= 0)) return
    list.push({ seq: position, time: at, totals: usage, model, provider, turn })
    this.pending.set(id, list)
    this.#rebuild()
    this.#scheduleSave()
    this.#emit()
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
    const seen = new Set()
    let parsed = 0
    const roots = await this.#sessionFiles()
    for (const file of roots) {
      seen.add(file)
      let st
      try {
        st = await fsp.stat(file)
      } catch {
        continue
      }
      const known = this.records.get(file)
      if (known !== undefined && known.mtimeMs === st.mtimeMs && known.size === st.size) continue
      try {
        const rec = await this.#parse(file, st)
        rec.mtimeMs = st.mtimeMs
        rec.size = st.size
        this.records.set(file, rec)
        parsed += 1
      } catch {
        // 文件正在写、或这一版格式读不了：留着上一份记录，下次再读。
        this.errors += 1
      }
    }
    for (const file of [...this.records.keys()]) if (!seen.has(file)) this.records.delete(file)
    this.parsedFiles = parsed
    this.scannedAt = Date.now()
    this.loaded = true
    this.#rebuild()
    this.#scheduleSave()
    this.#emit()
    void started
  }

  async #sessionFiles() {
    const root = path.join(this.home, 'sessions')
    const out = []
    let projects
    try {
      projects = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      return out
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const projectDir = path.join(root, project.name)
      let sessions
      try {
        sessions = await fsp.readdir(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const dir = path.join(projectDir, session.name)
        let files
        try {
          files = await fsp.readdir(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of files) {
          if (!entry.isFile()) continue
          if (!/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) continue
          out.push(path.join(dir, entry.name))
        }
      }
    }
    return out
  }

  async #parse(file, st) {
    const buf = await fsp.readFile(file)
    const text = (await zstd(buf)).toString('utf8')
    const lines = text.split('\n')
    const rec = emptyRecord()
    // A forked/seeded log starts with a copy of the parent's events. Those were
    // already billed and counted from the parent's own log, so skip them:
    // everything up to and including the inherited `session/end-seed` marker.
    let inheritedCut = -1
    for (const line of lines) {
      if (line === '') continue
      if (line.startsWith('{"type":"session"') && rec.id === '') {
        try {
          const header = JSON.parse(line)
          if (header.type === 'session') {
            rec.id = typeof header.id === 'string' ? header.id : ''
            rec.origin = typeof header.origin === 'string' ? header.origin : ''
            rec.createdAt = Number.isFinite(header.createdAt) ? header.createdAt : 0
            rec.isSeeded = header.isSeeded === true
          }
        } catch { /* ignore a torn first line */ }
        continue
      }
      if (!rec.isSeeded || !line.includes('"session/end-seed"')) continue
      try {
        const marker = JSON.parse(line)
        if (marker.type === 'session/end-seed' && marker.data?.inherited === true) {
          const seq = Number.isInteger(marker.seq) ? marker.seq : -1
          if (seq > inheritedCut) inheritedCut = seq
        }
      } catch { /* ignore */ }
    }
    rec.inheritedCut = inheritedCut
    for (const line of lines) {
      if (line === '') continue
      if (!line.includes('"usage"')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type !== 'assistant/message') continue
      const seq = Number.isInteger(event.seq) ? event.seq : -1
      // Part of the parent's inherited prefix: the parent log already has it.
      if (inheritedCut >= 0 && seq <= inheritedCut) continue
      const usage = usageOf(event)
      if (usage === undefined) continue
      const time = Number.isFinite(event.time) ? event.time : rec.createdAt
      const rawUsage = event.data?.usage
      if (rawUsage !== null && typeof rawUsage === 'object') {
        if (rawUsage.cacheReadTokens !== undefined || rawUsage.cacheWriteTokens !== undefined) rec.cacheSeen = true
      }
      const day = dayKey(time)
      const bucket = rec.days[day] ?? (rec.days[day] = emptyTotals())
      addTotals(bucket, usage.totals)
      if (usage.model !== '') {
        const byModel = rec.models[day] ?? (rec.models[day] = {})
        const key = modelKey(usage.provider, usage.model)
        byModel[key] = (byModel[key] ?? 0) + totalTokens(usage.totals)
      }
      const turn = Number.isInteger(event.data?.turn) && event.data.turn >= 0 ? event.data.turn : undefined
      if (turn !== undefined) {
        const bucket = rec.turns[turn] ?? (rec.turns[turn] = emptyTotals())
        addTotals(bucket, usage.totals)
      }
      if (Number.isInteger(event.seq) && event.seq > rec.lastSeq) rec.lastSeq = event.seq
      if (time > rec.lastTime) rec.lastTime = time
    }
    rec.totals = emptyTotals()
    for (const bucket of Object.values(rec.days)) addTotals(rec.totals, bucket)
    // 目录名就是会话 id：文件头缺失或损坏时仍然能对上「本对话」。
    if (rec.id === '') rec.id = path.basename(path.dirname(file))
    return rec
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
      if (data?.v !== INDEX_VERSION || typeof data.files !== 'object' || data.files === null) return
      for (const [file, rec] of Object.entries(data.files)) {
        if (rec === null || typeof rec !== 'object') continue
        const restored = { ...emptyRecord(), ...rec }
        restored.totals = emptyTotals()
        for (const bucket of Object.values(restored.days ?? {})) addTotals(restored.totals, bucket)
        this.records.set(file, restored)
      }
      this.loaded = true
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
      const body = JSON.stringify({ v: INDEX_VERSION, files })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, this.file)
    } catch {
      // 缓存写不进去不影响读数
    }
  }
}
