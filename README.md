# dsh-go-token-usage

[English](README.en.md) | 中文

给 [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) 手机 App 的原生 Token 用量插件：
输入框上方一条状态条、一整页原生面板、每条回复的回合脚注。数字全部来自当前主机自己的会话记录，只读、不联网、不估算。

## 显示什么

| 位置 | 内容 |
|---|---|
| 状态条（输入框上方） | `本对话 19.8M · 今日 155M`，点按打开面板 |
| 回合脚注（每条回复末尾） | 这一轮的 tokens 与缓存命中，如 `315k · 缓存86%` |
| 面板（对话详情「插件」页签 /「全部功能」/ 聊天页「插件」弹层） | 五段彩色卡片，顺序为 **累计 → 本对话 → 今日 → 近 7 天 → 近 30 天**（累计蓝、本对话绿、今日橙、7 天青、30 天紫）。每段一行「标题 + 总量」，下面「命中率 / 调用」并排，再用一行小字并排「输入合计 · 输出」；今日多一行当日模型；近 7 天带柱状图和日均、覆盖天数；近 30 天带日均、覆盖天数，明细两列并排（未缓存输入 / 缓存读取 / 缓存写入 与 输入合计 / 输出 / 推理）。内容随页面滑动，底部是复制统计与刷新 |

口径与引擎记账一致：

- `tokens = 未缓存输入 + 缓存读取 + 缓存写入 + 输出`；
- 缓存命中率 = 缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入）；
- 「本对话」只算当前会话自己的模型调用；「今日 / 近 7 天 / 近 30 天 / 累计」算这台主机上所有会话（含子智能体）；
- 按主机本地日期滚动，跨零点自动翻页；
- 数字统一三位有效数字（`8.82k` / `1.25M` / `3.59B`），单位写在各段指标下方（tokens / 次）；
- 字号整体小一档（标题与数字 16、说明 13），指标两列并排、明细两列并排，尽量少占屏；
- 「日均」按**有数据的天数**平均，并显示覆盖天数——不按 30 天摊薄，免得和覆盖天数对不上；
- 引擎没上报推理 tokens 时显示「—」，不显示 0；
- 缓存命中率保留一位小数，99.7% 不会显示成 100%。

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
dsh plugin --profile web add https://github.com/REPLACE_OWNER/dsh-go-token-usage/archive/refs/tags/v0.1.0.tar.gz
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

## 卸载

```sh
dsh plugin --profile web remove dsh-go-token-usage
rm -rf "$DSH_HOME/cache/dsh-go-token-usage"
```

桥接如果不需要了：`dsh plugin --profile web remove dsh-go-bridge`，再删掉 `$DSH_HOME/dsh-go/plugins/dsh-go-bridge`。

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
