# Changelog / 更新日志

## 0.2.5

### 中文

- **命中率口径修正（0.2.4 的回归）**：全部调用都上报 cache 计数时显示精确值；只有部分上报（例如个别中转）显示 `≈xx%`，不再因为一次没上报就让整个面板变「—」；完全没上报才显示「—」，中转仍不会被读成 0%。
- **root ↔ App uid 切换**：缓存属于其他用户时提示「缓存读写用户不一致，历史可能不全」，绝不覆盖对方缓存；安装器以 root 运行时修正已装文件的属主/权限。
- **安卓 app uid 无 HOME / `os.homedir()` 抛错**：按 `DSH_HOME` → `HOME` → `USERPROFILE` → homedir → cwd 逐级回退，插件不再挂不上；安装器同样不再崩。
- **ADB / 本地目录安装**：`--from <目录>` 先复制到 `$DSH_HOME/dsh-go/plugins/<包名>` 再安装，不留下指向 npx 缓存/ADB 临时目录的 `link:`；`status` 区分「读不到（权限）」与「缺失」。
- **安卓无 `/tmp`**：出图临时文件回退到缓存目录下的 `tmp/`；python 探针加 SIGKILL 与 60 秒负缓存；20 秒轮询在无新数据时不重写索引（1000+ 会话的机型省电/少卡）。
- **安全/健壮性（root、proot、无线调试、异常文件）**：
  - 日志与缓存改用非阻塞 fd + fstat 打开：FIFO、设备文件、指向超大文件的符号链接不会卡住引擎或 OOM；单日志 128MB、单行 32MB、缓存 64MB 上限，被跳过时面板提示原因。
  - 缓存目录 `0700`、缓存文件 `0600`（旧版留下的宽权限会在加载时收紧）；生成的用量图 `0600`；写坏回退 `.bak`；单会话最多检查 16 代日志。
  - 出图前校验 `assets/` 真实路径仍在插件包内，防止符号链接把图写到包外。
  - 扫描完全不依赖 `readdir` 的 `d_type`（proot / 安卓 FUSE 不可靠），项目/会话/文件类型一律 `stat` 并跟随符号链接；ctime 不可用时退回 mtime + size。
  - 外部命令只从安全的 PATH 目录解析（跳过 world-writable 目录；`/data/local/tmp`、`adb shell` 启动的引擎不再有劫持面）；python 可用 `DSH_TOKEN_USAGE_PYTHON` 指定绝对路径。
  - 安装器：桥接按 pinned commit 下载并逐文件校验 SHA-256（自定义 `DSH_GO_BRIDGE_REF` 明确提示跳过）；以 root 运行时提示引擎需同用户；README 增加「特殊环境」章节。

### English

- **Hit-rate accounting fixed (a 0.2.4 regression)**: exact when every call reports cache counters; `≈xx%` when only some do (one relay call no longer blanks every window); `—` only when nothing reports them, and a relay is never read as 0%.
- **Root ↔ app uid switch**: a cache owned by another user is reported as an owner mismatch and never overwritten; a root installer now fixes ownership/permissions of what it installed.
- **Android app uid without HOME / `os.homedir()` throwing**: resolution falls back through `DSH_HOME` → `HOME` → `USERPROFILE` → homedir → cwd, so the plugin always mounts; the installer no longer crashes either.
- **ADB / local-directory installs**: `--from <dir>` is copied to `$DSH_HOME/dsh-go/plugins/<name>` before installing, so no `link:` points at an npx cache or ADB temp directory; `status` distinguishes permission-denied from missing.
- **Android without `/tmp`**: image temp files fall back to a `tmp/` under the cache dir; the python probe uses SIGKILL and a 60s negative cache; the 20s poll no longer rewrites the index when nothing changed (battery/FUSE friendly on 1000+ session hosts).
- **Security/robustness (root, proot, wireless debugging, hostile files)**:
  - Logs and cache are opened through a non-blocking fd + fstat: FIFOs, device nodes and symlinks to huge files cannot hang the engine or exhaust memory; caps are 128MB per log, 32MB per line, 64MB cache, with the reason shown in the panel.
  - Cache directory `0700`, cache files `0600` (older wide modes are tightened on load); generated cards are `0600`; a damaged cache falls back to `.bak`; at most 16 generations are examined per session.
  - Card images refuse to be written when `assets/` resolves outside the package.
  - The scan never trusts `readdir`'s `d_type` (unreliable on proot/Android FUSE): types come from `stat` and links are followed; when ctime is unavailable it falls back to mtime + size.
  - External commands are resolved only from non-world-writable PATH directories (no hijack surface on `/data/local/tmp` or adb-shell engines); `DSH_TOKEN_USAGE_PYTHON` can pin the interpreter.
  - Installer: the bridge is downloaded from a pinned commit and every file is checked against an embedded SHA-256 (skipped with a warning for a custom `DSH_GO_BRIDGE_REF`); running as root prints a reminder that the engine needs the same user; README gains a "special environments" section.

## 0.2.4

### 中文

- 修复安卓 proot 下 `readdir` 的 `d_type` 不可靠（普通文件被报成符号链接）导致一个日志都扫不到、面板长期只显示安装后那一次调用的问题：改用 `stat` 判定目录/文件类型并跟随符号链接，项目/会话目录本身是软链也能扫到；补符号链接回归测试。
- 最新一代日志「能解析但不完整」（只写了 header、空白文件、半截迁移）不再替换完整旧代际：按已统计 seq 的完整性选最完整的一份，历史不再静默归零/腰斩；「核对」同规则；日志消失后以更短内容重建也保留已计历史。旧缓存里 `seq = -1` 的临时账加载时丢弃；同一轮同一步的「完全相同重复结算」会推进日志位置，临时账不再残留双计。
- 缓存写坏回退 `.bak`（面板提示「缓存损坏，已重新扫描」）；会话 header 丢失但继承标记还在的 seeded 日志也能跳过父前缀（不再 ~50 倍重复计）；空日志提示「N 个日志为空」；「核对」只有次数差时显示「差 N 次」。
- 缓存升到 v8：alias 记录不落盘（降级到 0.2.3 会忽略缓存重扫，不双计）；主机时区变化会重读日志重新分天；覆盖度未知只影响它覆盖的时段。
- 修复 `$DSH_HOME` 搬家/复制后同一批会话按两条路径重复计数（历史翻倍）：按会话 id 去重保留最完整的一份，「核对」同规则。
- 修复重试/失败调用（`assistant/attempt`）用量漏计：按引擎 token 用量投影口径计入；同轮同步的重复结算按「替换」处理，`llm/retry-started` 之后算新调用；消息缺 `data.usage` 时回退到流里最后一个 usage 样本。
- 引擎最新一代为空或读不了时退回上一代，历史不归零；文件被改写但 size/mtime 撞车时用 ctime 识别；没有日志位置的实时调用不再进临时账。
- 日志解析改为「按 zstd 帧切分 + 流式折叠」：不再依赖 Node 24.22 才有的多帧解码（旧版只解第一帧=漏账）；12MB 级日志峰值内存从数百 MB 降到几十 MB，117MB 原文实测 707ms → 39ms。
- **面板**：命中率按对话/按天算覆盖度；英文界面漏中文、回合脚注与「核对」提示超长截断修掉；「生成图片」改为延后效果、按对话隔离、文件名防同秒覆盖、清理保护正在显示的图；「核对」按会话对账（丢失只标「N 个日志已丢失」、目录不可用显示「跳过」）；缓存里结构损坏的记录会被忽略。
- **出图**：大帧流式解码；失败删半成品；来源列按宽度裁剪；探测 `python3`/`python`；装好 Pillow 免重启；图片列 6 个模型与面板一致；无账本对话保留「本对话 —」行。
- **安装器**：桥接下载到临时目录、校验完整清单与 package name 后原子替换（半途失败不再误判已装）；旧版自动升级（`--from` 隐含重装，`--force` 强制）；npm 失败时复制到本机插件目录，不再遗留 npx 缓存软链；`--dry-run` 不再下载/写盘；参数解析支持 `--key=value`/`-h`/`--version`，未知选项报错。
- **发布与文档**：prepack 同时清新旧两种图片文件名（避免真实用量图进 npm 包）；发版脚本拒绝脏工作区、workflow 校验 tag 与版本一致；发布包移除 `docs/`（208KB → 48KB）；CI 安装 Pillow 真测出图；README 口径/兼容依据/CJK 字体/Node 版本/升级说明补全；CHANGELOG 补 0.2.2。

### English

- Fixed Android proot scanning: `readdir`'s `d_type` is unreliable there (a regular file can be reported as a symlink), so the old scan skipped every log and the panel only showed the one call made after install. Types now come from `stat` and links are followed, including symlinked project/session directories; regression tests cover symlinks.
- A newest generation that parses but is incomplete (header-only, whitespace, half-done migration) no longer replaces the complete older generation: the most complete usable record wins (the same rule in Verify), so history is not silently zeroed or halved; a log re-created shorter after disappearing keeps the history already counted. Cached pending entries with `seq = -1` are dropped on load; an identical re-settlement advances the log position so provisional entries are released.
- A damaged cache falls back to `.bak` ("cache was damaged — rescanned"); a seeded log whose header is lost but whose inherited marker survives no longer bills the parent prefix (~50x overcount); empty logs say "N log(s) empty"; a call-count-only mismatch shows "Diff N calls".
- Cache v8: aliases are never persisted (downgrading to 0.2.3 rescans instead of double counting); a host timezone change re-reads logs into the right days; unknown cache-counter coverage only affects the windows it covers.
- Fixed double counting after moving or copying `$DSH_HOME` (same sessions under two paths): de-duplicated by session id, keeping the most complete record, and Verify uses the same rule.
- Fixed undercounting of retried/failed calls (`assistant/attempt`): counted exactly like the engine's own token-usage projection; a re-settlement of the same turn+step replaces the previous one, a settlement after `llm/retry-started` is a new call, and a message without `data.usage` falls back to the last usage sample in its stream.
- If the newest generation is empty or unreadable the previous one is used, so history never drops to zero; a rewrite with the same size and mtime is detected through ctime; live calls without a log position stay out of the provisional ledger.
- Log parsing now splits the zstd frame chain and folds it as a stream: no reliance on the multi-frame decoder that only Node 24.22 has (older runtimes decoded just the first frame and undercounted); peak memory for 12MB-class logs dropped from hundreds of MB to tens of MB, and 117MB of raw text now parses in 39ms instead of 707ms.
- **Panel**: hit-rate coverage is computed per chat/period; English leaks (update line, unverified, refresh toast) fixed; English turn notes and Verify text fit the app limits; "Generate image" is a deferred effect, per chat, with collision-proof file names and protected pruning; Verify compares per session (lost logs are named, a missing sessions root says "skipped"); structurally damaged cache records are ignored.
- **Images**: large frames decode as a stream; failed renders leave no partial PNG; the source column is width-fitted; `python3`/`python` are probed; installing Pillow no longer requires an engine restart; the card lists six models like the panel and keeps a "This chat —" row for chats with no ledger record.
- **Installer**: the bridge is staged, completeness/package-name validated and swapped atomically (a half-finished download is never "installed"); older installs auto-upgrade (`--from` implies reinstall, `--force` forces it); a failed npm install copies the package into the host plugin dir instead of leaving an npx-cache link; `--dry-run` no longer downloads or writes; arguments support `--key=value`, `-h`, `--version`, and unknown flags are errors.
- **Release/docs**: prepack cleans both current and legacy image file names (keeping local usage images out of the npm package); the release script refuses a dirty tree and the workflow checks tag/version consistency; `docs/` is out of the package (208KB → 48KB); CI installs Pillow so image tests really run; README covers accounting rules, compatibility basis, CJK fonts, Node requirements and upgrades; CHANGELOG gains the missing 0.2.2 entry.

## 0.2.3

### 中文

- 会话日志被引擎清理或手动删掉后，历史统计不再归零：读过的用量留在本地缓存继续计入，面板注明「N 个日志已不存在，历史按缓存保留」；从没扫到过的历史无法恢复时写明「本机没有会话日志，只含实时调用」，而不是静默显示 0。
- 实时调用也写进缓存，重启引擎不会丢。
- 「核对」把已丢失日志的部分排除在比对之外，并注明丢了几个日志。
- 每个会话只计引擎当前那一代日志，避免格式迁移后重复计数；支持 `compression: none` 的未压缩日志。
- 修复「复制统计」里模型行把来源（provider）当模型名、tokens 显示「—」的问题。
- README 安装命令去掉过时的版本号。

### English

- History no longer resets to zero when session logs are cleaned up or deleted: usage already read stays counted from the local cache and the panel says "N log(s) gone — history kept from cache"; history that was never scanned cannot be recovered, and the panel says "no session logs here — live calls only" instead of silently showing 0.
- Live calls are persisted too, so an engine restart does not lose them.
- Verify leaves cached history whose log is gone out of the comparison and names how many logs are missing.
- Only the engine's current generation per session is counted, so a format migration cannot double count; uncompressed logs (`compression: none`) are supported.
- Fixed "copy summary" listing the provider as the model and showing "—" for its tokens.
- Dropped the stale pinned version from the README install command.

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
