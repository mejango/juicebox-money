// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { prepareImageOptimizer } from '../scripts/prepare-image-optimizer.mjs'
import { animatedAvifBase64 } from './fixtures/image-optimizer-animated'

const require = createRequire(import.meta.url)
const nextDirectory = dirname(require.resolve('next/package.json'))
const optimizerFiles = ['dist/server/image-optimizer.js', 'dist/esm/server/image-optimizer.js']
const temporaryDirectories: string[] = []

function unpatchedNext() {
  const directory = mkdtempSync(join(tmpdir(), 'image-optimizer-compatibility-'))
  temporaryDirectories.push(directory)
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '16.3.8' }))
  for (const path of optimizerFiles) {
    const target = join(directory, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(join(nextDirectory, path), 'utf8')
      .replace('const BYPASS_TYPES = [\n    AVIF,\n', 'const BYPASS_TYPES = [\n'))
  }
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('pinned AVIF optimizer compatibility', () => {
  it('patches both formats once and checks the actual standalone runtime file', () => {
    const directory = unpatchedNext()
    expect(() => prepareImageOptimizer(directory, { check: true })).toThrow('patch missing')
    expect(prepareImageOptimizer(directory)).toBe(2)
    expect(prepareImageOptimizer(directory)).toBe(0)
    rmSync(join(directory, optimizerFiles[1]))
    expect(prepareImageOptimizer(directory, { check: true, standalone: true })).toBe(0)
    rmSync(join(directory, optimizerFiles[0]))
    expect(() => prepareImageOptimizer(directory, { check: true, standalone: true })).toThrow()
  })

  it('rejects version or second-file drift before changing the first file', () => {
    const directory = unpatchedNext()
    const first = readFileSync(join(directory, optimizerFiles[0]))
    writeFileSync(join(directory, optimizerFiles[1]), 'unexpected framework code')
    expect(() => prepareImageOptimizer(directory)).toThrow('Unexpected Next image optimizer source')
    expect(readFileSync(join(directory, optimizerFiles[0]))).toEqual(first)
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '16.3.9' }))
    expect(() => prepareImageOptimizer(directory)).toThrow('Review the AVIF compatibility patch')
    expect(readFileSync(join(directory, optimizerFiles[0]))).toEqual(first)
  })

  it('preserves every byte of an extensionless AVIF sequence while resizing ordinary rasters', async () => {
    prepareImageOptimizer()
    // Load only after preparation: exercising a cached unpatched module would mask the deployed behavior.
    const { imageOptimizer, ImageOptimizerCache } = await import('next/dist/server/image-optimizer.js')
    const { defaultConfig } = await import('next/dist/server/config-shared.js')
    const sequence = Buffer.from(animatedAvifBase64, 'base64')
    expect(sequence.subarray(8, 12).toString()).toBe('avif')
    const parameters = { href: 'https://example.test/ipfs/opaque-cid', width: 64, quality: 90, mimeType: 'image/webp' }
    expect(ImageOptimizerCache.getCacheKey(parameters)).not.toBe(
      ImageOptimizerCache.getCacheKey({ ...parameters, quality: 75 }),
    )
    const upstream = (buffer: Buffer) => ({ buffer, contentType: 'image/avif', cacheControl: 'public, max-age=60', etag: 'original-etag' })
    const options = { isDev: false, silent: true }
    const animated = await imageOptimizer(upstream(sequence), parameters, defaultConfig, options)
    expect(animated.buffer).toEqual(sequence)
    expect(animated.contentType).toBe('image/avif')
    expect(animated.etag).toBe('original-etag')
    const raster = await sharp({ create: { width: 256, height: 128, channels: 4, background: '#1d4ed8' } }).png().toBuffer()
    const resized = await imageOptimizer(upstream(raster), parameters, defaultConfig, options)
    expect(await sharp(resized.buffer).metadata()).toMatchObject({ width: 64, height: 32, format: 'webp' })
    expect(resized.buffer).not.toEqual(raster)
  })
})
