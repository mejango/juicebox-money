import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const version = '16.3.8'
const files = [
  {
    path: 'dist/server/image-optimizer.js',
    original: '38b92fde5bc72aa23c999d283052da11a6dfb36be75c2d92683d539551065a3c',
    patched: '33fde6ba5aed0109c92dc86d501c7003ce8edc9e6fee21235a8db335554abe33',
  },
  {
    path: 'dist/esm/server/image-optimizer.js',
    original: 'b5dd6849f39477e7e17f61e3428d53a548f2d83d8837fb03274ab59a4f576f34',
    patched: '8b50274538be1b7fd6712adef4404ab743427b28bede2e45bde53da6791255ba',
  },
]
const digest = contents => createHash('sha256').update(contents).digest('hex')

// Next 16.3.8 flattens AVIF sequences that use the valid `avif` major brand.
// Keep their original bytes until upstream supports an animation-safe path.
// Review this exact patch when upgrading Next; never apply it to unknown code.
export function prepareImageOptimizer(
  nextDirectory = dirname(require.resolve('next/package.json')),
  { check = false, standalone = false } = {},
) {
  const installed = JSON.parse(readFileSync(join(nextDirectory, 'package.json'), 'utf8'))
  if (installed.version !== version) {
    throw new Error(`Review the AVIF compatibility patch for Next ${installed.version}; expected ${version}`)
  }

  // Validate every target before writing either, so dependency drift fails closed.
  const changes = files.flatMap(({ path, original, patched }, index) => {
    const target = join(nextDirectory, path)
    if (standalone && index > 0 && !existsSync(target)) return []
    const source = readFileSync(target, 'utf8')
    const hash = digest(source)
    if (hash === patched) return []
    if (hash !== original) throw new Error(`Unexpected Next image optimizer source: ${path}`)
    if (check) throw new Error(`AVIF compatibility patch missing: ${path}`)
    const updated = source.replace('const BYPASS_TYPES = [\n', 'const BYPASS_TYPES = [\n    AVIF,\n')
    if (digest(updated) !== patched) throw new Error(`Unexpected AVIF patch output: ${path}`)
    return [{ target, updated }]
  })
  for (const { target, updated } of changes) writeFileSync(target, updated)
  return changes.length
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check-standalone')) {
    throw new Error('Usage: node scripts/prepare-image-optimizer.mjs [--check-standalone]')
  }
  const standalone = args[0] === '--check-standalone'
  const changed = prepareImageOptimizer(
    standalone ? resolve('.next/standalone/node_modules/next') : undefined,
    { check: standalone, standalone },
  )
  console.log(standalone
    ? 'Standalone image optimizer preserves AVIF originals.'
    : `Next image optimizer AVIF compatibility verified (${changed} files patched).`)
}
