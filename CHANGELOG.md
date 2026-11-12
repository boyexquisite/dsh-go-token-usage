# Changelog / 更新日志

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
