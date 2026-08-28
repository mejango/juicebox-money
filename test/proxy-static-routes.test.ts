import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { proxy } from '@/proxy'

const run = (path: string) =>
  proxy(new NextRequest(new URL(path, 'https://juicebox.money')))

describe('proxy static-route handling', () => {
  it('serves the dotted files this app actually owns', () => {
    for (const path of [
      '/robots.txt',
      '/sitemap.xml',
      '/llms.txt',
      '/manifest.json',
      '/assets/juicebox-social.png',
      '/fonts/Beatrice-Regular.woff2',
    ]) {
      expect(run(path), path).toBeUndefined()
    }
  })

  it('still serves app routes, urns and handles', () => {
    for (const path of ['/', '/learn', '/build', '/account/0xabc', '/base:6', '/@slopshop']) {
      expect(run(path), path).toBeUndefined()
    }
  })

  // The regression this guards: these used to skip the matcher entirely, fall through to
  // the [urn] route, and stream a 200 shell — an unbounded supply of soft 404s.
  it('redirects unknown dotted paths instead of letting them render', () => {
    for (const path of ['/totally-fake.txt', '/a.b', '/.well-known/ai-plugin.json']) {
      const result = run(path)
      expect(result?.status, path).toBe(307)
      expect(result?.headers.get('location'), path).toContain('old.juicebox.money')
    }
  })

  it('still redirects unknown dotless paths', () => {
    expect(run('/nonsense-xyz')?.status).toBe(307)
  })
})
