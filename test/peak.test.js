import test from 'node:test'
import assert from 'node:assert/strict'
import { isPeakAt, peakPanelData, peakPanelView, stripIcon, stripSuffix } from '../lib/peak.js'

// 构造北京时间对应的 UTC 毫秒（中国标准时间固定 UTC+8）。
const cst = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h - 8, mi)

test('peak is weekdays 09:00-12:00 and 14:00-18:00 in UTC+8', () => {
  assert.equal(isPeakAt(cst(2026, 11, 13, 8, 59)), false)
  assert.equal(isPeakAt(cst(2026, 11, 13, 9, 0)), true)
  assert.equal(isPeakAt(cst(2026, 11, 13, 11, 59)), true)
  assert.equal(isPeakAt(cst(2026, 11, 13, 12, 0)), false)
  assert.equal(isPeakAt(cst(2026, 11, 13, 14, 0)), true)
  assert.equal(isPeakAt(cst(2026, 11, 13, 17, 59)), true)
  assert.equal(isPeakAt(cst(2026, 11, 13, 18, 0)), false)
  // 周六整天低谷。
  assert.equal(isPeakAt(cst(2026, 11, 14, 10, 0)), false)
})

test('Chinese public holidays are off-peak all day', () => {
  assert.equal(isPeakAt(cst(2026, 10, 1, 10, 0)), false) // 国庆（周四）
  assert.equal(isPeakAt(cst(2026, 10, 8, 10, 0)), true) // 节后周四
  assert.equal(isPeakAt(cst(2026, 2, 15, 10, 0)), false) // 春节（周日）
  assert.equal(isPeakAt(cst(2026, 2, 24, 10, 0)), true) // 节后周二
})

test('the 2027 schedule is covered too', () => {
  assert.equal(isPeakAt(cst(2027, 1, 1, 10, 0)), false) // 元旦（周五）
  assert.equal(isPeakAt(cst(2027, 1, 4, 10, 0)), true) // 节后周一
  assert.equal(isPeakAt(cst(2027, 2, 5, 10, 0)), false) // 春节（周五）
  assert.equal(isPeakAt(cst(2027, 2, 15, 10, 0)), true) // 节后周一
  assert.equal(isPeakAt(cst(2027, 5, 3, 10, 0)), false) // 劳动节（周一）
  assert.equal(isPeakAt(cst(2027, 10, 1, 10, 0)), false) // 国庆（周五）
  assert.equal(isPeakAt(cst(2027, 10, 8, 10, 0)), true) // 节后周五
})

test('strip suffix is short and localized', () => {
  const peak = cst(2026, 11, 13, 10, 0)
  const off = cst(2026, 11, 13, 20, 0)
  assert.equal(stripSuffix(peak, 'zh-CN'), ' · 峰价')
  assert.equal(stripSuffix(off, 'zh-CN'), ' · 谷价')
  assert.equal(stripSuffix(peak, 'en-US'), ' · peak')
  assert.equal(stripSuffix(off, 'en-US'), ' · off-peak')
  // 尾部标签要给 token 数字留出位置；中文 5 字正好让整条落在 24 字内。
  assert.ok([...stripSuffix(off, 'zh-CN')].length <= 5)
})

test('strip icon differs between peak and off-peak', () => {
  assert.equal(stripIcon(cst(2026, 11, 13, 10, 0)), 'warning')
  assert.equal(stripIcon(cst(2026, 11, 13, 20, 0)), 'coin')
})

test('panel data and view agree on the state', () => {
  const peak = peakPanelData(cst(2026, 11, 13, 10, 0), 'zh-CN')
  assert.equal(peak.tone, 'warn')
  assert.ok(peak.rate.includes('峰价'))
  assert.ok(peak.next.includes('12:00'))

  const off = peakPanelData(cst(2026, 11, 13, 20, 0), 'zh-CN')
  assert.equal(off.tone, 'good')
  assert.ok(off.rate.includes('谷价'))
  assert.ok(off.next.includes('周一 09:00'), off.next)

  // 整点间隔写成 "9h" 而不是 "9h00m"。
  const midnight = peakPanelData(cst(2026, 11, 13, 0, 0), 'zh-CN')
  assert.ok(midnight.next.includes('9h（'), midnight.next)
  assert.ok(!midnight.next.includes('h00m'), midnight.next)

  const view = peakPanelView({ locale: 'zh-CN' })
  assert.equal(view.type, 'stack')
  assert.equal(view.v, 2)
  assert.ok(JSON.stringify(view).length < 8000)
  // 每个模型的卡片：标题 + 单位说明 + 三行键值（输入 / 缓存命中 / 输出）。
  const flash = view.children[1]
  assert.equal(flash.children[0].text, 'flash')
  assert.ok(flash.children[1].text.includes('美元每百万 token'), flash.children[1].text)
  assert.deepEqual(flash.children[2].items, [
    ['输入', '$0.15 / $0.30'],
    ['缓存命中', '$0.003 / $0.006'],
    ['输出', '$0.60 / $1.20'],
  ])
  assert.equal(peakPanelView({ locale: 'en-US' }).type, 'stack')
})
