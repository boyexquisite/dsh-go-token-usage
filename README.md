# dsh-go-token-usage

[English](README.en.md) | 中文

给 [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) 手机 App 的原生 Token 用量插件：输入框上方的状态条、对话「插件」页签里的面板、每条回复的用量脚注，还能生成一张用量卡片。数字全部来自本机会话日志，运行时不联网、不估算。

<p align="center">
  <img src="https://raw.githubusercontent.com/boyexquisite/dsh-go-token-usage/main/docs/panel.jpg" width="300" alt="在 dsh-go App 侧栏「插件」页签里的实际样子">
</p>

生成的用量卡（示例数据）：

<p align="center">
  <img src="https://raw.githubusercontent.com/boyexquisite/dsh-go-token-usage/main/docs/preview.png" width="260" alt="生成的用量卡（示例数据）">
</p>

## 功能

| 位置 | 内容 |
|---|---|
| 状态条 | `本对话 8.8M · 今日 245M`，点开面板 |
| 面板 | 累计 / 本对话 / 今日 / 近 7 天 / 近 30 天；命中率、日均、覆盖天数；今日模型（标注官方 / 中转 / 订阅来源） |
| 回合脚注 | 每条回复这一轮的 tokens 与缓存命中（中转完全不报缓存计数时只显示 tokens） |
| 生成图片 | 主机异步画一张竖版卡片，直接显示在面板底部（未生成时是占位图），截图分享（需要 `python3` + Pillow）；每张卡只显示在生成它的对话里 |
| 核对 | 用原始日志整卷重算，和面板数字对账 |

## 安装

```sh
npx dsh-go-token-usage install
```

或者直接装进 profile：

```sh
dsh plugin --profile web add dsh-go-token-usage
```

远程主机（服务器 / PC）请用上面的安装器，或在直接装插件前先装好 dsh-go 桥接，否则没有原生界面。重新运行安装命令即可升级已装的旧版本；`--force` 强制重装。装完在 App 里切一下主机（或重开 App），让它重读插件清单。

安装器还支持三个子命令：`bridge`（只装桥接）、`plugin`（只装插件）、`status`（查看已装内容）；常用参数有 `--profile <名>`、`--from <npm spec/tarball/目录>`、`--no-bridge`、`--force`、`--dry-run`（只打印计划）。**`--force` 会覆盖已装文件（包括本机对桥接做过的本地加固），非必要不要用**；但重装桥接前会先把旧桥接备份到 `<桥接目录>.bak-<时间戳>` 并列出与 pin 不同的文件，换入失败会还原。手机本机引擎（存在 `/etc/dsh-app/runtime.json`）自带的内置桥接不会被 `--force` 替换。

## 注意事项

- **需要 dsh-go 桥接**：原生界面只在带桥接的主机上显示——手机本机引擎自带；远程主机用 `npx dsh-go-token-usage install` 装（会从上游 GitHub 下载桥接）。经 **DSH Remote** 连接时不显示。
- **装完要重读**：在 App 里切一下主机（或重开 App）；之后改清单（`package.json`）自动生效，改 `lib/` 里的代码要重启引擎。
- **生成图片**：主机需要 `python3` + Pillow 和一个中文字体（Noto CJK / 文泉驿 / 微软雅黑 / PingFang 任一；完全找不到中文字体时会自动改用英文标签出图，不会显示方块）；没有 Python/Pillow 会提示；python 在非常规位置时可用 `DSH_TOKEN_USAGE_PYTHON=<绝对路径>` 指定（PATH 里 world-writable 目录下的同名程序不会被采用）；出图走延后效果，慢一点也不会丢点按。图片只显示在生成它的对话里，文件留在本机插件包 `assets/`（最近 3 张，且不会删掉其它对话正在显示的图），App 里不能长按保存，截图分享。
- **只算本机**：统计范围是本机 `$DSH_HOME` 的会话，换主机各算各的；子智能体计入「窗口 / 累计」，不计入「本对话」。
- **第一次慢几秒**：首次运行要扫一遍历史会话（约 5~10 秒，取决于日志大小），面板数字会稍后出现。首次冷扫会把每个 zstd 日志文件整体读入内存（解压本身是流式的），内存峰值约等于最大单个日志文件大小（默认单文件上限 128MB）。
- **面板会说明数据边界**：目录读不了时提示「N 个目录读不了，新日志可能没计入」；缓存记录损坏时提示「N 条缓存记录损坏，历史可能不全」。
- **命中率口径**：全部调用都上报 cache 计数时显示精确值；只有部分上报（比如个别中转）显示 `≈xx%`（按已上报部分估算，不再整段变「—」）；完全没上报才显示「—」。引擎不报推理 tokens 时推理显示「—」。
- **日志没了也不会静默清零**：扫过的历史留在本地缓存里，日志被引擎清理或手动删掉后照常计入，面板注明「N 个日志已不存在，历史按缓存保留」；插件从没扫到过的日志（比如装插件前就清掉的）无法恢复，面板会写明「本机没有会话日志，只含实时调用」，而不是悄悄显示 0。换 `$DSH_HOME` 等于换一套账本；日期按主机本地时区分天。

## 兼容

- 插件宿主半侧：DSH `0.2.1-rc.2` ~ `0.2.x`（`assistant/attempt`、`message.source`、`session/end-seed` 等字段自 0.2.1-rc.2 起就有）；当前在 DSH 0.2.2-rc.1 实测；
- 原生界面额外需要 dsh-go 桥接（按 `@deepseek-ai/dsh-web-app@0.2.2-rc.1` 适配并验证）：手机本机引擎自带，远程主机用安装器装；
- Node 22.19+（用到 `zlib` 的 zstd 解码；DSH 0.2.2 本身要求 Node 24.9+）；
- 经 DSH Remote 连接时不显示原生界面（App 限制）。

## 特殊环境（安卓 root / proot / 无线调试）

- **proot / 安卓 FUSE**：`readdir` 的 `d_type` 不可靠（普通文件会被报成符号链接），插件一律用 `stat` 判定类型并跟随符号链接，proot 下也能正常统计；`/sdcard` 一类 FUSE 文件系统 mtime/ctime 可能不精确，识别不到 ctime 时退回 mtime + size 判断。
- **root**：插件只读写 `$DSH_HOME` 下的会话日志与缓存，不联网、不读凭据；缓存文件权限 `0600`、目录 `0700`。以 root 跑安装器时会提示：确保 DSH 引擎用同一用户运行，否则它可能读不到刚装的文件。
- **无线调试 / ADB**：用 `adb shell` 或 root shell 装插件时，文件 owner 可能不是 App 引擎用户；请在引擎同一用户下执行 `dsh plugin --profile web add …`。插件不监听端口、不暴露服务。
- **安装器供应链**：桥接按 pinned commit 下载并逐文件校验 SHA-256；`DSH_GO_BRIDGE_REF` 自定义 ref 会跳过校验并明确提示；`dsh`/`pnpm` 也只从安全的 PATH 目录解析（跳过 world-writable 目录）。
- **异常/恶意文件**：会话路径若是 FIFO、设备、超大文件或指向它们的符号链接会被安全跳过（单日志 128MB、单行 32MB、缓存 64MB 上限），不会卡住引擎或吃爆内存；跳过原因会在面板提示。
- **只读文件系统 / 权限不足**：会话读得到就照常统计；缓存写不进去只会变慢（每次重新扫描），面板仍可用。
- **root 与 App uid 混用**：换用户后缓存读写权限不一致时，面板提示「缓存读写用户不一致，历史可能不全」，并且**不会覆盖**对方写的缓存；安装器以 root 运行时会给已装文件修正属主/权限（当 `$DSH_HOME` 属于其他用户）。
- **没有 HOME / 没有 passwd 条目**：`$DSH_HOME` → `HOME` → `USERPROFILE` → `os.homedir()` → 当前目录逐级回退，不会让插件挂不上；安卓建议显式设置 `DSH_HOME`。
- **ADB / 本地目录安装**：`--from <目录>` 会先复制到 `$DSH_HOME/dsh-go/plugins/<包名>` 再安装，不会给引擎留一个指向 npx 缓存/ADB 临时目录/私有目录的 `link:`。
- **没有 /tmp 的安卓**：出图的临时文件会退到缓存目录下的 `tmp/`；20 秒轮询在没有新数据时不重写索引（省电、少碰 FUSE）。
- **Windows**：安装器不支持 Windows（只执行 `.exe`/`.com`，不执行 npm 生成的 `.cmd`/`.bat`/无扩展名 shim，会直接报错退出）。Windows 用户请用 WSL 安装，或手动把包目录放到 `$DSH_HOME/dsh-go/plugins/<包名>` 后执行 `dsh plugin --profile web add <目录>`。
- **`DSH_HOME` 不能指向伪文件系统**：`/proc`、`/sys`、`/dev` 不接受普通 mkdir，Node 的 recursive mkdir 在这些路径上会卡死；安装器检测到会立刻失败并提示，换一个正常目录即可。

## 隐私

不读账号、密钥或任何凭据；运行时不联网（首次安装时安装器会联网下载 dsh-go 桥接）。只读 `$DSH_HOME/sessions` 里的 usage 计数和模型名，不保存对话正文；导出的图片只存在本机。

<details>
<summary>细节与已知边界</summary>

- 口径：`tokens = 未缓存输入 + 缓存读取 + 缓存写入 + 输出`，与引擎的 token 用量投影一致；命中率 = 缓存读取 ÷ 提示词总量；
- 重试/失败的模型调用也计入（引擎同样计入）：取该次 `assistant/attempt` 流里最后一个 usage 样本；同一轮同一步的重复结算按「替换」处理，`llm/retry-started` 之后的结算算新调用；压缩摘要调用不计（引擎也不计）；
- 「本对话」只算当前会话自身，子智能体计入窗口与累计；
- fork/seed 会话的继承前缀按 `session/end-seed` 跳过，不重复计；如果父会话日志已不在本机，这部分用量不会凭空补回来；
- 会话按 id 去重：移动/复制 `$DSH_HOME`、或同一会话出现在两个项目目录，都只会算一次；
- 扫描不信任 `readdir` 的 `d_type`（安卓 proot/FUSE 下会把普通文件报成符号链接），一律用 `stat` 判定类型并跟随链接——proot 环境也能正常统计；
- 日志按 zstd 帧流式解析：解压后内存有界（压缩文件本身按文件大小读入），单个大帧会流式解码；
- 中转不返回 cache 字段时命中率显示「—」，推理未上报时显示「—」；
- 首次运行扫一遍历史会话（约 5~10 秒，取决于日志大小），之后增量更新；缓存 `$DSH_HOME/cache/dsh-go-token-usage/index.json` 只存数字、模型名、本机会话文件路径和还没落盘的实时调用；
- 每个会话优先读最新代际；若最新一代为空、比已统计的旧代际短或读不了，就保留更完整的那份，历史不归零（面板会提示「N 个日志读不了」）；同名 `.jsonl` 与 `.jsonl.zstd` 并存时选较新的文件；旧代际不重复计，`compression: none` 也认；
- 缓存里保存过的历史在日志消失后继续计入，并标记来源已丢失（面板与「核对」都会写出来）；缓存格式 v8，旧版本读到会忽略并重扫，不会双计；主机的时区变了会重读现有日志重新分天；
- 面板「核对」会把原始日志整卷重算、按会话对账：一致显示 `核对：一致 · …`；已丢失日志的部分单独标成 `N 个日志已丢失`，不再误报「差」；完全找不到会话日志目录时显示「核对：跳过」；只有真正算不上的差额才显示 `核对：差 … tokens`。

</details>

## 卸载

```sh
dsh plugin --profile web remove dsh-go-token-usage
```

<details>
<summary>开发 / 发布</summary>

```sh
npm test
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" "$PWD" --load
node scripts/release.mjs <version> --dry-run   # 预检并打印计划，不改文件、不动 git
node scripts/release.mjs <version>             # 改版本 + 打 tag + atomic push；Actions 自动 npm publish 和 Release
```

发版脚本会先校验：cwd 是仓库根、当前分支是 `main`（可用 `--branch` 显式指定）、工作区干净、版本严格递增（拒绝降级/前导零）、`CHANGELOG.md` 有对应非空小节、本地与远端都没有同名 tag、本地分支不落后/分叉。任何失败都会在改动前拒绝并打印回滚指引；push 是 atomic 的，失败不会在远端留下"有 tag 没分支"的半截状态。

</details>

## 许可

MIT。安装器会按需从上游 [ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) 下载 `dsh-go-bridge`，本仓库不转存该代码。
