// prepack：清掉本机生成的用量图，避免它们被带进发布包。
// 仓库里的 assets/ 只留 .gitkeep 和 placeholder.png；图片是运行时在主机上生成的本地数据。
//
// 这里必须是 fail-closed：删不掉、或出现白名单之外的残留（未知的新命名变体、软链、临时文件……）
// 就让打包失败，而不是悄悄把它们打进 npm 包。历史上正是"真实用量图差点进包"的高风险点。
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const assets = join(dirname(dirname(fileURLToPath(import.meta.url))), 'assets')
// Repository-controlled assets; everything else in assets/ is local runtime data.
const ALLOWED = new Set(['.gitkeep', 'placeholder.png'])
// Current naming (with random suffix) and the legacy naming without it.
const USAGE_IMAGE = /^usage-\d{8}-\d{6}(-[a-z0-9]+)?\.png$/
/** The repository placeholder is a tiny PNG; a private card is orders of magnitude bigger. */
const PLACEHOLDER_MAX_BYTES = 64 * 1024
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/**
 * 2026-11-28 复审 P3：只验 magic 的话，换成一个「合法的别的 PNG」（藏文字 chunk/二维码）也能
 * 过预检。这里钉住仓库里那张占位图的 SHA-256——换图必须同时改这个常量，否则打包失败。
 */
const PLACEHOLDER_SHA256 = '413afe96ae486fe031edbe8905df16c46868b71034d6946249232a3d3bfc6312'

/**
 * 2026-11-28 审查 P1-1：白名单原来只比名字。把 assets/placeholder.png 换成同名目录、里面
 * 放本地私有文件（或换成软链指向私有用量图），预检照样通过，文件就跟着 npm 包发布出去。
 * 白名单里的每一项都必须是仓库里那个普通文件本身。
 */
function assetProblem(name) {
  const path = join(assets, name)
  let st
  try {
    st = lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined // 允许不存在（比如没有 .gitkeep）
    return `无法读取：${error.message}`
  }
  if (st.isSymbolicLink()) return '是符号链接'
  if (!st.isFile()) return '不是普通文件'
  if (st.size > PLACEHOLDER_MAX_BYTES) return `超过 ${PLACEHOLDER_MAX_BYTES} 字节`
  if (name === 'placeholder.png') {
    let head
    try {
      head = readFileSync(path)
    } catch (error) {
      return `无法读取：${error.message}`
    }
    if (head.length < PNG_MAGIC.length || !head.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return '不是 PNG'
    if (createHash('sha256').update(head).digest('hex') !== PLACEHOLDER_SHA256) return '不是仓库里那张占位图（SHA-256 不符）'
  }
  return undefined
}

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
  // The allow-list has to be the file itself, not just its name.
  const problems = []
  for (const name of ALLOWED) {
    const problem = assetProblem(name)
    if (problem !== undefined) problems.push(`assets/${name}：${problem}`)
  }
  if (problems.length > 0) {
    console.error('dsh-go-token-usage: refusing to pack because an allow-listed asset is not the repository file:')
    for (const line of problems) console.error(`  ${line}`)
    console.error('Restore assets/ from git (only .gitkeep and the placeholder PNG may ship) and retry.')
    process.exit(1)
  }
}
