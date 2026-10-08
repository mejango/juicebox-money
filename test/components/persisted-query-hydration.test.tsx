// @vitest-environment jsdom

import { dehydrate, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShop721Media, type Shop } from '@/hooks/useShop721'
import { installQueryPersistence, PERSIST, serializeState } from '@/lib/query-persist'

vi.mock('wagmi', () => ({ usePublicClient: () => undefined }))

const shop = {
  hook: `0x${'1'.repeat(40)}`,
  tiers: [{ id: 1, encodedIpfsUri: '0x01', resolvedUri: 'ipfs://item' }],
} as unknown as Shop
const key = ['shop721Media', 1, shop.hook, '1:0x01:ipfs://item']
const metadata = { 1: { name: 'Saved shop item' } }
const withClient = (client: QueryClient, view: ReactNode) => <QueryClientProvider client={client}>{view}</QueryClientProvider>

function ShopItem({ seen }: { seen?: string[] }) {
  const query = useShop721Media(1, shop)
  const label = query.data?.[1]?.name ?? 'Loading item'
  seen?.push(label)
  return <p data-loading={query.isLoading}>{label}</p>
}

let host: HTMLDivElement
let root: Root | undefined
let teardown: (() => void) | undefined
const clients: QueryClient[] = []
function client() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(value)
  return value
}
async function restoredClient() {
  const previous = client()
  await previous.fetchQuery({ queryKey: key, queryFn: async () => metadata, meta: PERSIST })
  const storage = { getItem: () => serializeState(dehydrate(previous)), setItem: vi.fn(), removeItem: vi.fn() } as unknown as Storage
  const browser = client()
  // Providers restores at load; a selective hydration boundary may start after it.
  window.addEventListener('load', () => { teardown = installQueryPersistence(browser, storage) }, { once: true })
  window.dispatchEvent(new Event('load'))
  expect(browser.getQueryData(key)).toEqual(metadata)
  return browser
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  teardown?.()
  teardown = undefined
  for (const value of clients.splice(0)) value.clear()
  host.remove()
})

describe('persisted shop data and component hydration', () => {
  it('preserves server DOM when its component hydrates after cache restoration, then displays the saved item', async () => {
    host.innerHTML = renderToString(withClient(client(), <ShopItem />))
    expect(host.textContent).toBe('Loading item')
    const serverNode = host.firstChild
    const browser = await restoredClient()
    const errors: unknown[] = []
    await act(async () => {
      root = hydrateRoot(host, withClient(browser, <ShopItem />), { onRecoverableError: error => errors.push(error) })
    })
    expect(errors).toEqual([])
    expect(host.firstChild).toBe(serverNode)
    expect(host.textContent).toBe('Saved shop item')
    expect(host.firstElementChild?.getAttribute('data-loading')).toBe('false')
  })

  it('shows restored data on the first render of a later client mount and still follows cache updates', async () => {
    const browser = await restoredClient()
    const seen: string[] = []
    await act(async () => {
      root = createRoot(host)
      root.render(withClient(browser, <ShopItem seen={seen} />))
    })
    expect(seen[0]).toBe('Saved shop item')
    await act(async () => {
      browser.setQueryData(key, { 1: { name: 'Updated shop item' } })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(host.textContent).toBe('Updated shop item')
  })
})
