// local-token-usage：dsh-go 手机原生界面里的 token 用量。
//
// 状态条显示「本对话 xx · 今日 xx」，点开是「Token 用量」面板：
// 今日 / 近 7 天 / 近 30 天 / 累计，缓存命中率，近 7 天柱状图，明细。
//
// 数据源是引擎自己的会话记录（每次模型调用的 assistant/message.usage），
// 不联网、不估算。没有 dsh-go 桥接的主机上，ctx.inject(['dshGo']) 不执行，
// 插件只安静记账，不报错。
import { UsageLedger } from './ledger.js'
import { usageOf } from './tally.js'
import { stripData, summaryText, turnNoteData, usageData, usageView, words } from './view.js'

export const name = 'local-token-usage'

/** 引擎刚产生的调用先记账，随后让文件里的真实数据接管。 */
const SCAN_DEBOUNCE_MS = 1500
/** 面板/状态条有人看的时候，隔一会儿补扫一次（只读变化的文件）。 */
const POLL_MS = 20_000

export function apply(ctx, options = {}) {
  const ledger = new UsageLedger(options)
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
  ctx.on('session/event', (session, event) => {
    const usage = usageOf(event)
    if (usage === undefined) return
    ledger.noteLive(session?.id, event?.seq, event?.time, usage.totals, usage.model, event?.data?.turn, usage.provider)
    scanSoon()
  })

  ctx.effect(() => () => {
    stopPolling()
    if (scanTimer !== undefined) clearTimeout(scanTimer)
    ledger.dispose()
  })

  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('usage', {
      view: (scope, caps) => usageView(scope, caps),
      data: (scope, emit, caps) => feed(scope, emit, (id) => usageData(ledger, id, caps?.locale)),
      actions: {
        refresh: () => {
          void ledger.refresh()
          return { toast: words().refreshed }
        },
        copy: (scope, event) => [
          { type: 'copy', text: summaryText(ledger, scope, event?.locale) },
          { type: 'toast', text: words(event?.locale).copied },
        ],
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
