import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')
const { dependencies } = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }

describe('example package pins', () => {
  it.each([
    'src/app/build/first-payment/page.tsx',
    'public/examples/read-project.mjs',
    'public/examples/preview-payment.mjs',
    'public/examples/launch-project.mjs',
    'public/examples/README.md',
  ])('%s installs the SDK and viem versions in package.json', file => {
    const text = read(file)
    const pins = (name: string) =>
      [...text.matchAll(new RegExp(`${name}@(\\d+\\.\\d+\\.\\d+)`, 'g'))].map(match => match[1])
    const sdk = pins('@bananapus/nana-sdk-core')
    const viem = pins('viem')
    expect(sdk.length).toBeGreaterThan(0)
    expect(new Set(sdk)).toEqual(new Set([dependencies['@bananapus/nana-sdk-core']]))
    expect(new Set(viem)).toEqual(new Set([dependencies.viem]))
  })

  it('states the checked versions in the tutorial note', () => {
    expect(read('src/app/build/first-payment/page.tsx')).toContain(
      `with the Juicebox SDK ${dependencies['@bananapus/nana-sdk-core']} and viem ${dependencies.viem}.`,
    )
  })
})
