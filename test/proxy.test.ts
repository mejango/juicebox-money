import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'
import { proxy } from '@/proxy'

const request = (path: string) =>
  new NextRequest(`https://juicebox.money${path}`)

describe('proxy', () => {
  it('leaves a project route to the app', () => {
    expect(proxy(request('/eth:1'))).toBeUndefined()
    expect(proxy(request('/eth%3A1'))).toBeUndefined()
  })

  it.each(['true', 'false', undefined])('reserves the image proof page and source only in the deterministic build: %s', async enabled => {
    vi.stubEnv('NEXT_PUBLIC_DETERMINISTIC_BROWSER', enabled)
    vi.resetModules()
    const { proxy: configuredProxy } = await import('@/proxy')
    for (const path of ['/image-proof', '/image-proof/source?asset=raster']) {
      const response = configuredProxy(request(path))
      if (enabled === 'true') expect(response).toBeUndefined()
      else {
        expect(response?.status).toBe(307)
        expect(response?.headers.get('location')).toBe(`https://old.juicebox.money${path}`)
      }
    }
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
