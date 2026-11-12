// prepack：清掉本机生成的用量图，避免它们被带进发布包。
// 仓库里的 assets/ 只留 .gitkeep 和 placeholder.png；图片是运行时在主机上生成的本地数据。
//
// 这里必须是 fail-closed：删不掉、或出现白名单之外的残留（未知的新命名变体、软链、临时文件……）
// 就让打包失败，而不是悄悄把它们打进 npm 包。历史上正是"真实用量图差点进包"的高风险点。
import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const assets = join(dirname(dirname(fileURLToPath(import.meta.url))), 'assets')
// Repository-controlled assets; everything else in assets/ is local runtime data.
const ALLOWED = new Set(['.gitkeep', 'placeholder.png'])
// Current naming (with random suffix) and the legacy naming without it.
const USAGE_IMAGE = /^usage-\d{8}-\d{6}(-[a-z0-9]+)?\.png$/

function readAssets() {
  try {
    return readdirSync(assets)
  } catch (error) {
    if (error?.code === 'ENOENT') return null // 没有 assets 目录也没关系
    console.error(`dsh-go-token-usage: cannot read assets/: ${error.message}`)
    process.exit(1)
  }
}

const names = readAssets()
if (names !== null) {
  let removed = 0
  for (const name of names) {
    if (!USAGE_IMAGE.test(name)) continue
    try {
      rmSync(join(assets, name), { force: true })
      removed += 1
    } catch (error) {
      // Never swallow this: the leftover check below turns it into a hard failure.
      console.error(`dsh-go-token-usage: cannot remove assets/${name}: ${error.message}`)
    }
  }
  if (removed > 0) console.log(`dsh-go-token-usage: removed ${removed} local usage image(s) from the package`)

  // Fail closed: re-read the directory and refuse to pack if anything remains that
  // is not part of the repository allow-list. This also catches deletion failures,
  // future card filename formats and stray files.
  const unexpected = (readAssets() ?? []).filter((name) => !ALLOWED.has(name))
  if (unexpected.length > 0) {
    console.error('dsh-go-token-usage: refusing to pack because assets/ still contains local or unexpected files:')
    for (const name of unexpected) console.error(`  assets/${name}`)
    console.error('Remove them (or update scripts/clean-assets.mjs if the card filename format changed) and retry.')
    process.exit(1)
  }
}
