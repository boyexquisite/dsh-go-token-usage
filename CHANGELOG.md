# Changelog

## 0.1.0 — 2026-11-12

首个公开版本。

- 原生状态条：`本对话 … · 今日 …`，点按打开面板；
- 原生面板：今日 / 近 7 天 / 近 30 天 / 累计、缓存命中率、日均、近 7 天柱状图、
  本对话与近 30 天明细、今日模型、复制统计与刷新；
- 回合脚注：每条回复末尾显示本轮 tokens 与缓存命中（需要支持 `turn.note` 的 App）；
- 数据源：`$DSH_HOME/sessions` 里引擎自己的 `assistant/message.usage`，只读、不联网；
- 冷历史增量索引（`$DSH_HOME/cache/dsh-go-token-usage/index.json`）+ 实时记账按事件
  `seq` 去重，不重复计数；
- 安装器 `bin/install.mjs`：自动补装 dsh-go 桥接、装机、状态检查、dry-run。
