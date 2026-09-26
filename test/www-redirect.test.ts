import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const createConfig = require('../next.config.js') as () => {
  redirects: () => Promise<
    {
      source: string
      has?: { type: string; value: string }[]
      destination: string
      permanent: boolean
    }[]
  >
}

describe('www redirect', () => {
  it('sends every www.juicebox.money path to the same path on juicebox.money', async () => {
    expect(await createConfig().redirects()).toEqual([
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www.juicebox.money' }],
        destination: 'https://juicebox.money/:path*',
        permanent: true,
      },
    ])
  })
})
