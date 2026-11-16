// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TabShell, useTabShowing } from '@/components/project/Tabs'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const read = vi.fn(async () => 'price')

function Polling() {
  const { data } = useQuery({
    queryKey: ['polled'],
    queryFn: read,
    staleTime: 20_000,
    refetchInterval: 30_000,
    subscribed: useTabShowing(),
  })
  return <p>{data}</p>
}

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

it('stops a visited tab from polling while it is hidden and reads again when it comes back', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const show = (active: number) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <TabShell
            tabs={[
              { label: 'Market', content: <Polling /> },
              { label: 'Other', content: <p>other</p> },
            ]}
            active={active}
            onSelect={() => {}}
            listClassName=""
            buttonClassName=""
            panelClassName=""
          />
        </QueryClientProvider>,
      ),
    )

  await show(0)
  await advance(0)
  expect(read).toHaveBeenCalledTimes(1)
  await advance(30_000)
  expect(read).toHaveBeenCalledTimes(2)

  await show(1)
  // Still mounted, with its last answer, and silent.
  expect(container.textContent).toContain('price')
  await advance(120_000)
  expect(read).toHaveBeenCalledTimes(2)

  await show(0)
  await advance(0)
  expect(read).toHaveBeenCalledTimes(3)
  await advance(30_000)
  expect(read).toHaveBeenCalledTimes(4)
  client.clear()
})

it('ties every polling read inside a project tab to its tab', () => {
  for (const [file, polls] of [
    ['MarketSection', 1],
    ['MarketPriceChart', 1],
    ['SettlementSection', 1],
    ['RevnetPriceCard', 3],
  ] as const) {
    const source = readFileSync(`src/components/project/${file}.tsx`, 'utf8')
    expect(source.match(/subscribed: showing/g)?.length, file).toBe(polls)
  }
})
