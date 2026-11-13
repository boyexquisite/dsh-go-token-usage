# Changelog / 更新日志

## 0.3.0

### 中文

- 状态条尾部跟 DeepSeek 峰谷价：`本对话 8.8M · 今日 245M · 谷价`，图标随状态换成金币 / 警示。峰时只算工作日 09:00–12:00、14:00–18:00（北京时间），其余时段含整个周末和法定节假日一律半价。
- 新增「峰谷价」面板：当前计费、下次切换时刻，flash / pro 两张卡片按「输入 / 缓存命中 / 输出」列出谷价与峰价；中文界面用官方中文页的人民币价，英文界面用美元价（均为每百万 tokens）。
- 节假日内置国办 2026、2027 两年安排；调休上班的周末仍按低谷算。2028 年安排发布后需要补表。
- 状态条每 60 秒自检一次峰谷标签：整点切换时即使账本没有新调用，胶囊也会跟着变。
- 分隔符间距统一；24 字预算先保完整写法，再压分隔符，最后才退成只报今日。

### English

- The status strip ends with DeepSeek's peak/off-peak tag (`Chat 8.8M · today 245M · off-peak`) and the icon swaps between coin and warning. Peak is weekdays 09:00–12:00 and 14:00–18:00 (UTC+8); everything else — weekends and public holidays included — is half price.
- New "Peak rate" panel: current tier, next switch, and two cards per model listing input / cache hit / output with the off-peak and peak price. The zh UI shows the CNY prices from the Chinese pricing page and the en UI shows USD, both per 1M tokens.
- Holidays cover China's 2026 and 2027 schedules; make-up working weekends still count as off-peak. The 2028 table has to be added once it is published.
- The strip re-checks the peak tag every 60 s, so it flips at a boundary even when no new model call arrives.
- Even separator spacing; the 24-character budget keeps the full form first, then tightens separators, and only then drops the per-chat number.

## 0.2.8

### 中文

- 「核对」不再误报：会话还在写入、或某个目录暂时读不了时，不再显示「差 N tokens」，改为说明「N 处读不了」；面板会提示读不了的目录和损坏的缓存记录，历史数字继续保留。
- 修复出图失败与卡死：模型名含换行/控制字符不再让出图必挂；临时目录落在异常 `TMPDIR`（如 `/proc`）时不再卡住宿主；没有中文字体时自动改用英文标签；PNG 次要文字对比度提高。
- 极端数值与超长名称不再撑破界面：超大 token 数、超长模型名不会让状态条/回合脚注/面板数据超限或被硬截断；复制统计与面板统一显示 6 个模型。
- 统计口径与健壮性：零用量重结算、失败/重试调用、缓存损坏、保存与卸载竞态、不可读日志等边缘场景与引擎对齐；196 份真实日志按引擎记账口径逐会话对账一致。
- 安装器与发版更安全：不再修改 `$DSH_HOME` 外的文件权限；`--from` 指向自身副本不再自毁；`--force` 重装桥接前先备份并列出本地改动，手机内置桥接不被替换；`--dry-run` 零写入；拒绝 `/proc` 等伪文件系统上的 `DSH_HOME`。发布脚本预检分支/版本/CHANGELOG/tag 并 atomic push，`publish` 只由 tag 触发，另加 main/PR 的 Node 22/24 测试。

### English

- Verify no longer reports a false diff while a chat is still being written or a directory
  cannot be read for a moment; it names the unreadable paths instead, and the panel points
  out unreadable directories and damaged cache records while keeping the cached history.
- Image export is fixed: newlines/control characters in model names no longer break drawing,
  a hostile `TMPDIR` (e.g. `/proc`) can no longer wedge the host, hosts without a CJK font
  draw the English labels instead of tofu, and secondary PNG text got more contrast.
- Absurd totals and very long model names can no longer overflow the strip, turn notes, panel
  data or copied summary; the copy summary lists the same six models as the panel.
- Accounting is aligned with the engine on zero-token re-settlements, failed/retried calls,
  cache damage, save/dispose races and unreadable logs; all 196 real logs match the engine's
  accounting rule session by session.
- Safer installer and releases: it no longer changes permissions outside `$DSH_HOME`,
  `--from` pointed at its own copy no longer self-destructs, `--force` backs up the old bridge
  and lists local modifications first, the app's built-in bridge is never replaced, `--dry-run`
  writes nothing, and `$DSH_HOME` under pseudo filesystems is refused. The release script now
  preflights branch/version/CHANGELOG/tags and pushes atomically; publish runs from tags only,
  with new Node 22/24 CI for main and pull requests.

## 0.2.7

### 中文

- 面板每段卡片的标题行字号从 `subtitle` 缩到 `body`：窄屏下「本对话 29.3M tokens」原来会折成两行，和累计/今日不齐；现在五段标题都能一行放下。

### English

- The per-section headline now uses the `body` size instead of `subtitle`: on narrow screens
  "This chat 29.3M tokens" used to wrap onto a second line while the other sections did not.

## 0.2.6

### 中文

- 修复「核对」误报：一笔调用已经写进会话日志、插件还没来得及扫描时，面板和核对会各算一次、再减一次，显示「差 N tokens / N 次」。现在核对前先补扫日志，并且只把超出重算快照的调用算作未解释差额。
- 顺带修 `text` 风格的错误消息与两处内部清理，无行为变化。

### English

- Fix a false mismatch in Verify: when a call was already written to the session logs but the
  ledger had not scanned it yet, the panel and the recount counted it twice and then subtracted
  it again, reporting "N tokens / N calls off". Verify now refreshes the scan first and only
  counts pending calls beyond the recount snapshot as unexplained.
- Internal cleanup in the text-style error message and two small helpers; no behaviour change.

## 0.2.5

### 中文

- 命中率口径修正（0.2.4 的回归）：只有部分调用上报缓存计数时显示 `≈xx%`，不再整段变「—」。
- root 与 App 用户混用时，不再覆盖对方的缓存，并提示历史可能不全。
- 安卓 app 用户没有 HOME 时插件照常挂载，安装器不再崩溃。
- ADB / 本地目录安装改为先复制再安装，不再留下失效链接。
- 安全加固：异常/超大文件、受限权限、无 `/tmp`、可疑 PATH 一律安全处理（细节见 README「特殊环境」）。

### English

- Hit-rate fix (a 0.2.4 regression): when only some calls report cache counters it shows `≈xx%` instead of blanking every window.
- Root and app users no longer overwrite each other's cache; an owner mismatch is reported instead.
- The plugin now mounts when an Android app user has no HOME, and the installer no longer crashes.
- ADB / local-directory installs copy before installing, leaving no dangling links.
- Hardening for hostile files, restricted permissions, hosts without `/tmp` and untrusted PATH entries (see README "Special environments").

## 0.2.4

### 中文

- 修复安卓 proot 下所有日志被误判、面板只剩安装后一次调用的扫描问题。
- 日志不完整或被替换时历史不再归零/腰斩，按最完整可用的一代统计；缓存损坏回退 `.bak`。
- 修复移动/复制 `$DSH_HOME` 后历史翻倍（按会话 id 去重），并按引擎口径补计重试/失败调用。
- 日志解析改为流式，内存与耗时明显下降，兼容 Node 22/24 的 zstd 帧。
- 面板、出图、安装器与发布流程的一系列修复与加固（细节见提交记录）。

### English

- Fixed scanning on Android proot, where every log was misread as a symlink and the panel only showed the call made after install.
- An incomplete or replaced log no longer zeroes or halves history: the most complete usable generation is counted, and a damaged cache falls back to `.bak`.
- Fixed doubled history after moving or copying `$DSH_HOME` (de-duplicated by session id); retried/failed calls are now counted like the engine does.
- Log parsing is streamed, cutting memory and time, and works across Node 22/24 zstd frames.
- Various panel, image, installer and release fixes (see the commit history).

## 0.2.3

### 中文

- 会话日志被删后历史不再归零，从本地缓存保留；实时调用也写入缓存，重启不丢。
- 「核对」把已丢失日志排除在外并注明数量。
- 每个会话只计当前一代日志，避免格式迁移重复计数；支持未压缩日志。
- 修复「复制统计」的模型名与 tokens 显示错误。

### English

- History no longer resets when session logs are deleted: it is kept from the local cache, and live calls are persisted across restarts.
- Verify excludes lost logs and names how many are missing.
- Only the current generation per session is counted, so migrations cannot double count; uncompressed logs are supported.
- Fixed the model name and token display in "copy summary".

## 0.2.2

### 中文

- README 顶部换成 App 侧栏「插件」页签的真实截图，示例用量卡保留。
- 市场条目更新到 0.2.2（市场 PR #42）。

### English

- The README now shows a real screenshot of the app's Plugins tab; the sample card stays.
- The market entry was updated to 0.2.2 (market PR #42).

## 0.2.1

### 中文

- 按钮「导出图片」改名为「生成图片」，占位图提示同步更新。

### English

- The "Export image" button was renamed to "Generate image", with matching placeholder text.

## 0.2.0

### 中文

- 合并为一个面板（「Token 用量」），生成的图片直接显示在面板底部；未生成时用占位图。
- 移除「用量图」页签。

### English

- Merged into a single "Token usage" panel with the generated card at the bottom (placeholder until generated).
- Removed the separate "Usage image" tab.

## 0.1.2

### 中文

- README 增加「注意事项」（桥接、重读、导出、统计范围）。

### English

- README gained a Notes section (bridge, re-reading, export, counting scope).

## 0.1.1

### 中文

- 精简 README，加示例图；仓库描述与 topics。

### English

- Simplified the README, added a sample image, repository description and topics.

## 0.1.0

### 中文

- 首个公开版本：状态条、面板、回合脚注、导出用量卡、核对、复制统计。

### English

- First public release: status strip, panel, per-turn notes, usage card export, Verify and copy summary.
