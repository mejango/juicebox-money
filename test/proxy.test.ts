import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { proxy } from '@/proxy'

const request = (path: string) =>
  new NextRequest(`https://juicebox.money${path}`)

const legacyAnswers = (status: number, matchedPath?: string) =>
  vi.fn().mockResolvedValue(
    new Response(null, {
      status,
      headers: matchedPath ? { 'x-matched-path': matchedPath } : {},
    }),
  )

describe('proxy', () => {
  const rendersNotFound = (response?: Response) =>
    response?.headers.get('x-middleware-rewrite')?.endsWith('/_/not-found')

  beforeEach(() => vi.stubGlobal('fetch', legacyAnswers(404)))
  afterEach(() => vi.unstubAllGlobals())

  it('leaves a project route to the app', async () => {
    expect(await proxy(request('/eth:1'))).toBeUndefined()
    expect(await proxy(request('/eth%3A1'))).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends a slash tab path to the project tab hash', async () => {
    const location = async (path: string) => (await proxy(request(path)))?.headers.get('location')
    expect(await location('/eth:3/terms')).toBe('https://juicebox.money/eth:3#terms')
    expect(await location('/eth:3/owners/market')).toBe('https://juicebox.money/eth:3#owners/market')
    expect(await location('/eth:3/owners/market?a=1')).toBe('https://juicebox.money/eth:3?a=1#owners/market')
    expect(await location('/@rev/shop')).toBe('https://juicebox.money/@rev#shop')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('gives other deep paths the not-found page', async () => {
    expect(rendersNotFound(await proxy(request('/v3/terms')))).toBe(true)
    expect(rendersNotFound(await proxy(request('/eth:3/nope')))).toBe(true)
    expect(rendersNotFound(await proxy(request('/eth:3/owners/market/extra')))).toBe(true)
  })

  it('leaves app routes, and paths under them, to the app', async () => {
    expect(await proxy(request('/learn'))).toBeUndefined()
    expect(await proxy(request('/learn/foo'))).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hands over a page the legacy site serves, with its path and query', async () => {
    vi.stubGlobal('fetch', legacyAnswers(200, '/en/v5/[jbUrn]'))
    const response = await proxy(request('/v5/eth:1?tab=activity'))
    expect(response?.status).toBe(307)
    expect(response?.headers.get('location')).toBe(
      'https://old.juicebox.money/v5/eth:1?tab=activity',
    )
    expect(fetch).toHaveBeenCalledWith(
      'https://old.juicebox.money/v5/eth:1?tab=activity',
      expect.objectContaining({ method: 'HEAD' }),
    )
  })

  it.each(['/not-a-project', '/eth:abc', '/foo:3', '/v5/eth:999999', '/%25', '/%E0%A4%A'])(
    'renders the not-found page for %s, which the legacy site does not serve',
    async path => {
      const response = await proxy(request(path))
      expect(response?.headers.get('location')).toBeNull()
      expect(rendersNotFound(response)).toBe(true)
    },
  )

  it('treats a 200 from the legacy 404 page as a miss', async () => {
    vi.stubGlobal('fetch', legacyAnswers(200, '/en/404'))
    expect(rendersNotFound(await proxy(request('/somewhere/else')))).toBe(true)
  })

  it('stays here when the legacy site cannot answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    expect(rendersNotFound(await proxy(request('/v5/eth:1')))).toBe(true)
  })
})
