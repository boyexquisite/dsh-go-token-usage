# dsh-go-token-usage

[English](README.en.md) | 中文

给 [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) 手机 App 的原生 Token 用量插件：
输入框上方一条状态条、一整页原生面板、每条回复的回合脚注。数字全部来自当前主机自己的会话记录，只读、不联网、不估算。

## 显示什么

| 位置 | 内容 |
|---|---|
| 状态条（输入框上方） | `本对话 19.8M · 今日 155M`，点按打开面板 |
| 回合脚注（每条回复末尾） | 这一轮的 tokens 与缓存命中，如 `315k · 缓存86%` |
| 面板（对话详情「插件」页签 /「全部功能」/ 聊天页「插件」弹层） | 五段彩色卡片，顺序为 **累计 → 本对话 → 今日 → 近 7 天 → 近 30 天**（蓝 / 绿 / 橙 / 青 / 紫）。每段同一套骨架：标题 + 总量 + tokens 一行，下面左右对齐的行依次是命中率、调用（次）、输入合计、输出；近 7 天与近 30 天再加日均、覆盖天数（天），近 30 天最后列未缓存输入、缓存读取、缓存写入、其中推理。今日卡底部是「今日模型」列表（模型名 + 来源 + tokens），近 7 天带柱状图。五段上下对齐，行距留白按正常密度；底部是复制统计、导出图片、核对与刷新 |

口径与引擎记账一致：

- `tokens = 未缓存输入 + 缓存读取 + 缓存写入 + 输出`；
- 缓存命中率 = 缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入）；
- 「本对话」只算当前会话自己的模型调用；「今日 / 近 7 天 / 近 30 天 / 累计」算这台主机上所有会话（含子智能体）；
- 按主机本地日期滚动，跨零点自动翻页；
- 数字统一三位有效数字（`8.82k` / `1.25M` / `3.59B`），单位写在各段指标下方（tokens / 次）；
- 字号：标题 20、明细 16、说明 13；数字与单位写在同一行；
- 五段卡片同一套骨架，行左对齐、数值右对齐，长标签（如覆盖天数）也不会把数字挤走；
- 今日模型按 provider/模型分别累计，同一模型名来自官方和中转会分开显示来源；
- 「日均」按**有数据的天数**平均，并显示覆盖天数——不按 30 天摊薄，免得和覆盖天数对不上；
- 引擎没上报推理 tokens 时显示「—」，不显示 0；
- 缓存命中率保留一位小数，99.7% 不会显示成 100%；
- 今日模型按「来源」标注：`官方 · 账号`（deepseek-account）、`官方 · API Key`、`订阅 · command-code`、`中转 · <名字>`（custom-*）、其他 provider 原样标为 `第三方 · <provider>`；改映射在 `lib/view.js` 的 `sourceLabel` 里。

## 安装

```sh
npx dsh-go-token-usage install
```

它会做两件事：

1. 检查这台主机有没有 **dsh-go 桥接**。手机 App 的本机引擎自带；远程主机（服务器、电脑）第一次需要装，脚本会从上游 dsh-Go 仓库的固定提交下载 `dsh-go-bridge`（不转存、不修改），再 `dsh plugin add`。
2. 把本插件装进默认的 `web` profile。

要求：Node.js ≥ 22.19、`dsh` 在 PATH 里、`pnpm` 可用（`dsh plugin` 靠它装包）。

其它用法：

```sh
npx dsh-go-token-usage status                 # 看看桥接/插件装没装
npx dsh-go-token-usage bridge                 # 只装桥接
npx dsh-go-token-usage plugin --profile web   # 只装插件
npx dsh-go-token-usage install --from ./dist.tgz
npx dsh-go-token-usage install --dry-run
```

也可以不走 npm（直接从 GitHub 装）：

```sh
dsh plugin --profile web add https://github.com/boyexquisite/dsh-go-token-usage/archive/refs/tags/v0.1.0.tar.gz
# 桥接：本机引擎自带，远程主机用刚装进来的安装器补一次（装过会跳过）
node "$DSH_HOME/profiles/web/node_modules/dsh-go-token-usage/bin/install.mjs" bridge
```

装完在 App 里**切一下主机（或重开 App）**让它重读插件清单：

- 输入框上方出现状态条；
- 对话详情「插件」页签 /「全部功能」里出现「Token 用量」面板；
- 每条回复末尾出现回合脚注（需要较新版本的 App，旧版本自动不显示）。

改动 `package.json` 的清单会自动重读；`lib/` 里的代码改了要**重启引擎**才生效。

## 兼容

| 项 | 要求 |
|---|---|
| DSH | `0.2.1-rc.2` ~ `0.2.x`（`engines.dsh` 已声明上限） |
| dsh-go App | 支持原生插件协议 v1 的版本（面板 / 状态条）；回合尾注需要支持 `turn.note` 的较新版本 |
| 主机 | 本机引擎（桥接自带）或装了桥接的远程主机 |

> 经 **DSH Remote** 连接的主机不显示原生界面，这是 App 自身限制；用 SSH 托管的那台主机即可。

## 数据与隐私

- 只读 `$DSH_HOME/sessions/**/session.v*.jsonl.zstd` 里的 `assistant/message.usage`；
- 不发起网络请求、不上传任何内容、不读凭据；
- 首次运行扫一遍历史会话（约 5 秒，取决于数量），之后只读变化的文件；索引缓存放在 `$DSH_HOME/cache/dsh-go-token-usage/index.json`（约 100–200 KB）；
- 全部代码就在本仓库里，没有构建步骤、没有依赖。

## 准确性

数字不估算、不抽样，直接来自引擎自己记账的事件：每条 `assistant/message` 里的 `usage`（未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 推理），与引擎扣费口径一致。

已经做过的核对：

- 独立重算：用 `zstd` 解开 `$DSH_HOME/sessions` 下的原始日志、另写一份 Python 汇总，与面板数字逐项对上（今日 tokens、调用次数、累计 tokens、累计调用次数全部一致）；
- 分流（fork / seed）会话的日志开头会带着父会话的历史事件，这些事件已经算在父会话的账上，插件按 `session/end-seed` 的 `inherited` 标记跳过继承前缀，不重复计；有对应单测；
- 实时记账与文件对账：模型调用发生时先记一笔临时账，文件写入后用事件 `seq` 让位给文件数据，同一个 seq 只计一次；
- 「导出图片」：在主机侧用 Python + Pillow 画一张竖版统计卡（PNG，1080 宽），存进插件包 `assets/`，App 里自动跳到「用量图」面板显示，截图即可保存/分享；图片由桥接的 `/dsh-go/v1/assets/<包名>/<文件>` 提供。主机需要 `python3` + Pillow，没有时按钮会提示，不影响其他功能。生成过的图只保留最近 3 张；
- 面板底部有「核对」按钮：点一下会把本机所有原始会话日志重新解析一遍（不走索引缓存），和面板数字对账，结果显示在下方一行，例如「核对：一致 · 3.46B · 18.1k 次」；有还没落盘的调用时显示「核对：差 N 次」，不会误报；
- 测试里覆盖了翻页、实时去重、文件补扫、fork 前缀、缓存字段缺失等边界情况（`npm test`）。

已知边界（不是错误，但要知道）：

- 只统计**本机**这个 `$DSH_HOME` 的主机；换主机各算各的，不跨主机汇总；
- 「本对话」只算当前会话自身，子智能体（subagent）的调用计入时间窗口和累计，不计入「本对话」；
- 某些中转 / 自定义 provider 不返回 cache 计数，命中率显示「—」而不是 0%；
- 日期按主机本地时区归属；跨零点按本地日历翻页；
- 历史完全依赖本机会话日志：日志被删或换了 `DSH_HOME`，历史就没了；
- 「核对」结果只存在内存里，重启引擎后回到「未核对」。

## 图片导出需要什么

- 主机上有 `python3`，并且 `python3 -c "import PIL"` 能通过（`pip install pillow`）；
- 中文字体：脚本会自动找 Noto Sans CJK / 文泉驿 / 苹方 / 微软雅黑，找不到时文字可能变方块，但图仍会生成；
- 生成的 PNG 写在插件包内 `assets/`，走桥接的 assets 路由给 App，不联网、不上传；
- App 的插件图片视图目前只能显示、不能长按保存，所以「导出图片」= 生成一张图给你截图用。

## 卸载

```sh
dsh plugin --profile web remove dsh-go-token-usage
rm -rf "$DSH_HOME/cache/dsh-go-token-usage"
```

桥接如果不需要了：`dsh plugin --profile web remove dsh-go-bridge`，再删掉 `$DSH_HOME/dsh-go/plugins/dsh-go-bridge`。

## 隐私：它不需要任何私人信息

- **不要账号、不要密钥、不要手机号**：插件不读 `~/.dsh/.credentials.yaml`、不读环境变量里的 token、不做任何登录；
- **运行时不联网**：`lib/` 和 `scripts/` 里没有 `fetch` / `http` / `https` 调用；唯一的网络请求在安装器里——从上游 dsh-Go 仓库的固定 commit 下载桥接，不上传任何东西；
- **只读本机会话日志里的数字**：从 `$DSH_HOME/sessions` 里每条 `assistant/message` 取 `usage` 计数，以及 provider / 模型名；**不保存对话正文**；缓存 `index.json` 里只有日期、token 数、调用次数、会话 UUID、模型名，以及扫描用的本机会话文件路径——这些路径只存在本机缓存里，不参与任何上报；
- **导出的图片只存在本机**：PNG 写在插件包 `assets/`，由本机桥接的带凭据路由给 App，内容只有 token 数字、模型/来源名和时间，没有主机名、用户名、路径或对话内容；
- **发布包不带本机数据**：仓库 `.gitignore` 忽略生成图，`prepack` 会在打包前删掉 `assets/usage-*.png`（已验证 `npm pack` 内容里只有 `.gitkeep`）。

可以自己复核：

```sh
grep -rnE "fetch\(|https?://|password|secret|bearer|api[_-]?key" lib/ scripts/
grep -rnE "credentials|DSH_HOME|sessions" lib/ scripts/
```

## 开发

```sh
npm test                                     # 14 个单测：记账、实时去重、视图预算
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" "$PWD" --load   # 官方原生插件检查器
```

目录：

| 文件 | 作用 |
|---|---|
| `package.json` 的 `dshGo` | 声明状态条 / 面板 / 回合尾注 |
| `lib/index.js` | 引擎里的宿主半侧：监听调用、喂数据、处理点按 |
| `lib/ledger.js` | 冷历史扫描 + 实时记账 + 按 seq 去重的增量索引 |
| `lib/tally.js` | 纯函数：usage 折叠、格式化、日期 |
| `lib/view.js` | 面板视图（JSON 组件树 + `{ "$": "data.x" }` 绑定）与数据模型 |
| `bin/install.mjs` | 安装器：桥接 + 插件 |

## 许可

本仓库代码 MIT。安装器会按需从上游 [ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) 下载 `dsh-go-bridge`（其 `package.json` 声明 MIT，仓库另有 AGPL-3.0 许可），本仓库不转存该代码，请以[上游](https://github.com/ccch1mneyyy/dsh-Go)为准。
