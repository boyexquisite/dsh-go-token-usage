// dsh-go-token-usage：dsh-go 手机原生界面里的 token 用量。
//
// 状态条显示「本对话 xx · 今日 xx」，点开是「Token 用量」面板：
// 今日 / 近 7 天 / 近 30 天 / 累计，缓存命中率，近 7 天柱状图，明细。
//
// 数据源是引擎自己的会话记录（每次模型调用的 assistant/message.usage），
// 不联网、不估算。没有 dsh-go 桥接的主机上，ctx.inject(['dshGo']) 不执行，
// 插件只安静记账，不报错。
import { existsSync, readFileSync } from 'node:fs'
import { UsageLedger } from './ledger.js'
import { renderUsageImage } from './render.js'
import { settlementOf } from './tally.js'
import { imagePanelData, stripData, summaryText, turnNoteData, usageData, usageView, verifyLine, words } from './view.js'
import { peakPanelData, peakPanelView } from './peak.js'

// 公开包和本机本地包可能不同名（dsh-go-token-usage / local-token-usage），
// 名字以 package.json 为准，两边同步 lib 时不用改代码。
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export const name = PKG.name

/** 引擎刚产生的调用先记账，随后让文件里的真实数据接管。 */
const SCAN_DEBOUNCE_MS = 1500
/** 面板/状态条有人看的时候，隔一会儿补扫一次（只读变化的文件）。 */
const POLL_MS = 20_000
/** 每个对话只记住最近一张用量图；超过这个数就丢最久没看的那张。 */
const IMAGE_CACHE_MAX = 8

export function apply(ctx, options = {}) {
  const ledger = new UsageLedger(options)
  /** 每个对话最近一次生成的用量图；别的对话的面板不显示这张图。 */
  const lastImages = new Map()
  const feeds = new Set()
  let pollTimer
  let scanTimer
  /** 卸载后不再排新的扫描/轮询，也不往已停用的 feed 推数据。 */
  let disposed = false

  const scanSoon = () => {
    if (disposed || scanTimer !== undefined) return
    scanTimer = setTimeout(() => {
      scanTimer = undefined
      void ledger.refresh()
    }, SCAN_DEBOUNCE_MS)
    if (typeof scanTimer.unref === 'function') scanTimer.unref()
  }

  const stopPolling = () => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  const startPolling = () => {
    if (disposed || pollTimer !== undefined) return
    pollTimer = setInterval(() => void ledger.refresh(), POLL_MS)
    if (typeof pollTimer.unref === 'function') pollTimer.unref()
  }

  /** Remember one session's image; oldest entries fall off so a long-lived host cannot grow. */
  const rememberImage = (sessionId, image) => {
    lastImages.delete(sessionId)
    lastImages.set(sessionId, image)
    for (const key of lastImages.keys()) {
      if (lastImages.size <= IMAGE_CACHE_MAX) break
      lastImages.delete(key)
    }
  }

  /** This chat's image, or null when it was never drawn or the file is gone. */
  const imageFor = (scope) => {
    const id = typeof scope?.sessionId === 'string' ? scope.sessionId : ''
    const image = lastImages.get(id)
    if (image === undefined) return null
    if (!existsSync(image.file)) {
      lastImages.delete(id)
      return null
    }
    return image
  }

  /** Start one feed (panel data or strip data): push now, then on every change. */
  function feed(scope, emit, build) {
    if (disposed) return () => {}
    const push = () => {
      if (disposed) return
      emit(build(scope))
    }
    const off = ledger.listen(push)
    feeds.add(off)
    startPolling()
    push()
    void ledger.refresh()
    return () => {
      off()
      feeds.delete(off)
      if (feeds.size === 0) stopPolling()
    }
  }

  // 冷历史：插件加载后在后台扫一遍会话记录（有缓存时只补变化的文件）。
  void ledger.refresh()

  // 实时：每次模型调用先记一笔，1.5 秒后再让文件里的数据核对一次。
  // 重试/失败的 attempt 也是计费调用，按引擎口径一起记；重试开始则关闭替换槽。
  ctx.on('session/event', (session, event) => {
    if (disposed) return
    if (event?.type === 'llm/retry-started') {
      ledger.noteRetryStarted(session?.id, event?.data?.turn, event?.data?.step)
      return
    }
    const settlement = settlementOf(event)
    if (settlement === undefined) return
    ledger.noteLive(
      session?.id,
      settlement.seq,
      settlement.time,
      settlement.totals,
      settlement.model,
      settlement.turn,
      settlement.provider,
      settlement.step,
      settlement.cacheCounters,
    )
    scanSoon()
  })

  ctx.effect(() => () => {
    disposed = true
    stopPolling()
    if (scanTimer !== undefined) clearTimeout(scanTimer)
    scanTimer = undefined
    ledger.dispose()
  })

  ctx.inject(['dshGo'], (ctx) => {
    // 点「生成图片」：主机侧异步画一张 PNG，写进包内 assets，再由桥接提供给 App。
    // 出图可能超过 3 秒点按窗口（首次导入 Pillow、慢字体），所以走延后效果。
    const exportImage = (scope, event) => {
      const w = words(event?.locale)
      const sessionId = typeof scope?.sessionId === 'string' ? scope.sessionId : ''
      return {
        pending: { label: w.exportImage, timeoutMs: 60_000 },
        result: async (signal) => {
          if (signal?.aborted) return []
          try {
            // Only files that still exist are worth protecting from the prune pass.
            const protectedFiles = [...lastImages.values()].map((item) => item.file).filter((file) => existsSync(file))
            const image = await renderUsageImage({ ledger, scope, locale: event?.locale, outDir: options.imageDir, protectedFiles })
            if (signal?.aborted) return []
            rememberImage(sessionId, image)
            return [
              { type: 'toast', text: w.exportDone },
              { type: 'patch', id: 'usage', data: imagePanelData(image, event?.locale) },
            ]
          } catch (error) {
            const message = String(error?.message || error)
            const text = message.includes('missing-python') ? w.exportNoPython : w.exportFailGeneric
            return { type: 'toast', text: text.slice(0, 40) }
          }
        },
      }
    }

    ctx.dshGo.panel('usage', {
      view: (scope, caps) => usageView(scope, caps),
      data: (scope, emit, caps) =>
        feed(scope, emit, (active) => ({
          ...usageData(ledger, active, caps?.locale),
          ...imagePanelData(imageFor(active), caps?.locale),
        })),
      actions: {
        refresh: (scope, event) => {
          const w = words(event?.locale)
          return {
            pending: { label: w.refresh, timeoutMs: 15_000 },
            result: async (signal) => {
              if (signal?.aborted) return []
              await ledger.refresh()
              if (signal?.aborted) return []
              return { toast: w.refreshed }
            },
          }
        },
        export: (scope, event) => exportImage(scope, event),
        copy: (scope, event) => [
          { type: 'copy', text: summaryText(ledger, scope, event?.locale) },
          { type: 'toast', text: words(event?.locale).copied },
        ],
        // 用原始日志整份重算一遍，和面板数字对账；慢活走延后效果。
        verify: (scope, event) => {
          const w = words(event?.locale)
          return {
            pending: { label: w.verify, timeoutMs: 60_000 },
            result: async (signal) => {
              try {
                if (signal?.aborted) return []
                // Fold anything the logs already hold (and drop settled live
                // entries) before recomputing, so the comparison is against the
                // current numbers instead of a scan behind.
                await ledger.refresh()
                if (signal?.aborted) return []
                const recount = await ledger.recount()
                if (signal?.aborted) return []
                const line = verifyLine(ledger, recount, event?.locale)
                ledger.verifyNote = line
                return [
                  { type: 'toast', text: line },
                  { type: 'patch', id: 'usage', data: { lastVerify: line } },
                ]
              } catch {
                return { type: 'toast', text: w.verifyFailGeneric }
              }
            },
          }
        },
      },
    })

    // 状态条尾巴上的峰谷标签；点开是 DeepSeek 峰谷价目表。
    ctx.dshGo.panel('peak', {
      view: (scope, caps) => peakPanelView(caps),
      data: (scope, emit, caps) => {
        const push = () => {
          if (!disposed) emit(peakPanelData(Date.now(), caps?.locale))
        }
        push()
        const timer = setInterval(push, 60_000)
        return () => clearInterval(timer)
      },
    })

    ctx.dshGo.strip('usage-strip', (scope, emit, caps) => {
      const off = feed(scope, emit, (id) => stripData(ledger, id, caps?.locale))
      // 峰谷标签在 09:00 / 12:00 / 14:00 / 18:00 整点换；账本没有新调用时不会自己刷新，
      // 补一个分钟级重推（内容没变就不发，避免无谓的差量）。
      let last = null
      const timer = setInterval(() => {
        if (disposed) return
        const next = stripData(ledger, scope, caps?.locale)
        if (last !== null && last.text === next.text && last.icon === next.icon) return
        last = next
        emit(next)
      }, 60_000)
      return () => {
        off()
        clearInterval(timer)
      }
    })

    // 每轮回复的脚注：这一轮用了多少 token、缓存命中多少。
    ctx.dshGo.turnNote('usage-turn', (scope, emit, caps) =>
      feed(scope, emit, (id) => turnNoteData(ledger, id, caps?.locale)),
    )
  })
}
