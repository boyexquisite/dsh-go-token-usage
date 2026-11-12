// prepack：清掉本机生成的用量图，避免它们被带进发布包。
// 仓库里的 assets/ 只留 .gitkeep；图片是运行时在主机上生成的本地数据。
import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const assets = join(dirname(dirname(fileURLToPath(import.meta.url))), 'assets')
let removed = 0
try {
  for (const name of readdirSync(assets)) {
    if (/^usage-\d{8}-\d{6}(-[a-z0-9]+)?\.png$/.test(name)) {
      rmSync(join(assets, name), { force: true })
      removed += 1
    }
  }
} catch {
  // 没有 assets 目录也没关系
}
if (removed > 0) console.log(`dsh-go-token-usage: removed ${removed} local usage image(s) from the package`)
