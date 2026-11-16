import { describe, expect, it, vi } from 'vitest'
import registry from '@/lib/bendystraw-operation-registry.json'
import { POST } from '@/app/api/bendystraw/[net]/query/route'
import { bendystraw, getProject } from '@/lib/bendystraw'

const [operation, query] = Object.entries(registry).find(([, document]) =>
  document.includes('project(chainId:'),
)!

const answer = () =>
  new Response(JSON.stringify({ data: { project: null } }), {
    headers: { 'content-type': 'application/json' },
  })

function relay(
  net: 'mainnet' | 'testnet',
  variables: Record<string, unknown>,
) {
  return POST(
    new Request(`https://juicebox.money/api/bendystraw/${net}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation, variables }),
    }),
    { params: Promise.resolve({ net }) },
  )
}

function indexerAnswers() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => answer())
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('the relay keeps indexer answers out of Next’s fetch cache', () => {
  it.each([
    ['mainnet', 1],
    ['testnet', 84532],
  ] as const)(
    'asks for the %s answer with no-store and no revalidate window',
    async (net, chainId) => {
      const fetcher = indexerAnswers()

      const response = await relay(net, { chainId, projectId: 11 })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: { project: null } })
      expect(fetcher).toHaveBeenCalledOnce()
      const init = fetcher.mock.calls[0][1]
      expect(init).toMatchObject({ cache: 'no-store' })
      expect(init).not.toHaveProperty('next')
    },
  )

  it('stays uncached in the deterministic browser build', async () => {
    vi.stubEnv('NEXT_PUBLIC_DETERMINISTIC_BROWSER', 'true')
    vi.resetModules()
    const fetcher = indexerAnswers()
    const deterministic = await import('@/lib/bendystraw')
    const route = await import('@/app/api/bendystraw/[net]/query/route')

    await route.POST(
      new Request('https://juicebox.money/api/bendystraw/mainnet/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation,
          variables: { chainId: 1, projectId: 11 },
        }),
      }),
      { params: Promise.resolve({ net: 'mainnet' }) },
    )
    await deterministic.bendystraw(query, { chainId: 1, projectId: 11 })

    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: 'no-store' })
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('next')
    expect(fetcher.mock.calls[1][1]).toMatchObject({ next: { revalidate: 1 } })
  })
})

describe('server-side reads keep their revalidate window', () => {
  it.each([
    ['live', 15],
    ['standard', 30],
    ['stable', 60],
    [undefined, 60],
  ] as const)(
    'a read with policy %s revalidates every %s seconds',
    async (policy, seconds) => {
      const fetcher = indexerAnswers()

      await bendystraw(query, { chainId: 1, projectId: 11 }, { policy })

      const init = fetcher.mock.calls[0][1]
      expect(init).toMatchObject({ next: { revalidate: seconds } })
      expect(init).not.toHaveProperty('cache')
    },
  )

  it('keeps getProject on the standard window', async () => {
    const fetcher = indexerAnswers()

    await getProject(1, 11)

    const init = fetcher.mock.calls[0][1]
    expect(init).toMatchObject({ next: { revalidate: 30 } })
    expect(init).not.toHaveProperty('cache')
  })

  it('skips the cache only for a read that asks for no-store', async () => {
    const fetcher = indexerAnswers()

    await bendystraw(
      query,
      { chainId: 1, projectId: 11 },
      { policy: 'no-store' },
    )

    const init = fetcher.mock.calls[0][1]
    expect(init).toMatchObject({ cache: 'no-store' })
    expect(init).not.toHaveProperty('next')
  })
})

describe("the relay's indexer read ends with the browser's request", () => {
  it('stops it when the browser leaves, does not retry it, and logs nothing', async () => {
    const fetcher = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const browser = new AbortController()

    const relayed = POST(
      new Request('https://juicebox.money/api/bendystraw/mainnet/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation, variables: { chainId: 1, projectId: 11 } }),
        signal: browser.signal,
      }),
      { params: Promise.resolve({ net: 'mainnet' }) },
    )
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    browser.abort()

    expect((await relayed).status).toBe(502)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(logged).not.toHaveBeenCalled()
  })
})

describe('the relay spends the shared indexer budget once', () => {
  const limited = (retryAfter?: string) =>
    new Response('slow down', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} })

  it.each([
    ['7', '7'],
    [undefined, '30'],
    ['Wed, 21 Oct 2026 07:28:00 GMT', '30'],
  ] as const)('answers an indexer 429 as a 429 without asking again (Retry-After %s)', async (upstream, relayed) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => limited(upstream))
    vi.stubGlobal('fetch', fetcher)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await relay('mainnet', { chainId: 1, projectId: 11 })

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe(relayed)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('reads the indexer once for identical requests that overlap, and again once that read has settled', async () => {
    const answers: ((response: Response) => void)[] = []
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { answers.push(resolve) }))
    vi.stubGlobal('fetch', fetcher)

    const first = relay('mainnet', { chainId: 1, projectId: 11 })
    const second = relay('mainnet', { chainId: 1, projectId: 11 })
    const other = relay('mainnet', { chainId: 1, projectId: 12 })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    answers.forEach(resolve => resolve(answer()))

    for (const response of await Promise.all([first, second, other])) {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: { project: null } })
    }
    expect(fetcher).toHaveBeenCalledTimes(2)

    // Nothing is kept: the next request reads the indexer again.
    fetcher.mockImplementation(async () => answer())
    await relay('mainnet', { chainId: 1, projectId: 11 })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('keeps a shared read going for the browser still waiting when another leaves', async () => {
    let finish!: (response: Response) => void
    let upstream: AbortSignal | undefined
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise<Response>(resolve => {
      upstream = init?.signal ?? undefined
      finish = resolve
    }))
    vi.stubGlobal('fetch', fetcher)
    const leaving = new AbortController()
    const request = (signal?: AbortSignal) => POST(
      new Request('https://juicebox.money/api/bendystraw/mainnet/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation, variables: { chainId: 1, projectId: 11 } }),
        signal,
      }),
      { params: Promise.resolve({ net: 'mainnet' }) },
    )

    const left = request(leaving.signal)
    const stayed = request()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    leaving.abort()
    expect((await left).status).toBe(502)
    expect(upstream?.aborted).toBe(false)
    finish(answer())

    expect((await stayed).status).toBe(200)
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe('the browser after the relay answers 429', () => {
  it('sends no indexer read during the pause, a retry included, then reads again', async () => {
    // The relay request's own tries wait on real time; the pause is stepped through.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.resetModules()
    vi.stubGlobal('window', {})
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'Bendystraw rate limited' }), { status: 429, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    const browser = await import('@/lib/bendystraw')

    const refused = browser.bendystraw(query, { chainId: 1, projectId: 11 }).catch((error: unknown) => error)
    expect(await refused).toMatchObject({ status: 429 })
    const sent = fetcher.mock.calls.length

    // What a query's own retry does a second later: answered here, with no request.
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(browser.bendystraw(query, { chainId: 1, projectId: 11 })).rejects.toMatchObject({ status: 429 })
    await expect(browser.bendystraw(query, { chainId: 1, projectId: 12 })).rejects.toBeInstanceOf(browser.BendystrawRateLimited)
    expect(fetcher).toHaveBeenCalledTimes(sent)

    await vi.advanceTimersByTimeAsync(4_000)
    fetcher.mockImplementation(async () => answer())
    await expect(browser.bendystraw(query, { chainId: 1, projectId: 11 })).resolves.toEqual({ project: null })
    expect(fetcher).toHaveBeenCalledTimes(sent + 1)
    vi.useRealTimers()
  })
})
