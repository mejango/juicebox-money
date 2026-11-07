import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { proxy } from '@/proxy'

const request = (path: string) =>
  new NextRequest(`https://juicebox.money${path}`)

describe('proxy', () => {
  it('leaves a project route to the app', () => {
    expect(proxy(request('/eth:1'))).toBeUndefined()
    expect(proxy(request('/eth%3A1'))).toBeUndefined()
  })

  it('sends a slash tab path to the project tab hash', () => {
    const location = (path: string) => proxy(request(path))?.headers.get('location')
    expect(location('/eth:3/terms')).toBe('https://juicebox.money/eth:3#terms')
    expect(location('/eth:3/owners/market')).toBe('https://juicebox.money/eth:3#owners/market')
    expect(location('/eth:3/owners/market?a=1')).toBe('https://juicebox.money/eth:3?a=1#owners/market')
    expect(location('/@rev/shop')).toBe('https://juicebox.money/@rev#shop')
  })

  it('does not treat other deep paths as tabs', () => {
    expect(proxy(request('/v3/terms'))?.headers.get('location')).toContain('old.juicebox.money')
    expect(proxy(request('/eth:3/nope'))?.headers.get('location')).toContain('old.juicebox.money')
    expect(proxy(request('/eth:3/owners/market/extra'))?.headers.get('location')).toContain('old.juicebox.money')
  })

  it('hands a path holding a literal % to the legacy site instead of failing', () => {
    // `/%25` decodes to `%`, which is not a route and must not throw.
    const response = proxy(request('/%25'))
    expect(response?.status).toBe(307)
    expect(response?.headers.get('location')).toBe(
      'https://old.juicebox.money/%25',
    )
  })
})
