// local-token-usage：dsh-go 手机原生界面里的 token 用量。
//
// 状态条显示「本对话 xx · 今日 xx」，点开是「Token 用量」面板：
// 今日 / 近 7 天 / 近 30 天 / 累计，缓存命中率，近 7 天柱状图，明细。
//
// 数据源是引擎自己的会话记录（每次模型调用的 assistant/message.usage），
// 不联网、不估算。没有 dsh-go 桥接的主机上，ctx.inject(['dshGo']) 不执行，
// 插件只安静记账，不报错。
import { readFileSync } from 'node:fs'
import { UsageLedger } from './ledger.js'
import { renderUsageImage } from './render.js'
import { settlementOf } from './tally.js'
import { imagePanelData, stripData, summaryText, turnNoteData, usageData, usageView, verifyLine, words } from './view.js'

// 公开包和本机本地包可能不同名（dsh-go-token-usage / local-token-usage），
// 名字以 package.json 为准，两边同步 lib 时不用改代码。
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export const name = PKG.name

/** 引擎刚产生的调用先记账，随后让文件里的真实数据接管。 */
const SCAN_DEBOUNCE_MS = 1500
/** 面板/状态条有人看的时候，隔一会儿补扫一次（只读变化的文件）。 */
const POLL_MS = 20_000

export function apply(ctx, options = {}) {
  const ledger = new UsageLedger(options)
  /** 每个对话最近一次生成的用量图；别的对话的面板不显示这张图。 */
  const lastImages = new Map()
  const feeds = new Set()
  let pollTimer
  let scanTimer

  const scanSoon = () => {
    if (scanTimer !== undefined) return
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
    if (pollTimer !== undefined) return
    pollTimer = setInterval(() => void ledger.refresh(), POLL_MS)
    if (typeof pollTimer.unref === 'function') pollTimer.unref()
  }

  /** Start one feed (panel data or strip data): push now, then on every change. */
  function feed(scope, emit, build) {
    const push = () => emit(build(scope))
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
    stopPolling()
    if (scanTimer !== undefined) clearTimeout(scanTimer)
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
        result: async () => {
          try {
            const protectedFiles = [...lastImages.values()].map((item) => item.file)
            const image = await renderUsageImage({ ledger, scope, locale: event?.locale, outDir: options.imageDir, protectedFiles })
            lastImages.set(sessionId, image)
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
          ...imagePanelData(lastImages.get(typeof active?.sessionId === 'string' ? active.sessionId : '') ?? null, caps?.locale),
        })),
      actions: {
        refresh: (scope, event) => {
          const w = words(event?.locale)
          return {
            pending: { label: w.refresh, timeoutMs: 15_000 },
            result: async () => {
              await ledger.refresh()
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
            result: async () => {
              try {
                const recount = await ledger.recount()
                const line = verifyLine(ledger, recount, event?.locale)
                ledger.verifyNote = line
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

    ctx.dshGo.strip('usage-strip', (scope, emit, caps) =>
      feed(scope, emit, (id) => stripData(ledger, id, caps?.locale)),
    )

    // 每轮回复的脚注：这一轮用了多少 token、缓存命中多少。
    ctx.dshGo.turnNote('usage-turn', (scope, emit, caps) =>
      feed(scope, emit, (id) => turnNoteData(ledger, id, caps?.locale)),
    )
  })
}
