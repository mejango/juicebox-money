// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ contexts: {} as Record<string, unknown> }))

vi.mock('wagmi', async original => ({ ...(await original<typeof import('wagmi')>()), usePublicClient: () => ({}), useReadContract: () => ({ data: undefined }) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ isConnected: false, openSignIn: () => {} }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useReviewedAction', async original => ({
  ...(await original<typeof import('@/hooks/useReviewedAction')>()),
  useReviewedAction: () => ({ phase: 'idle' }),
}))
vi.mock('@tanstack/react-query', async original => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQuery: (options: { queryKey: unknown[] }) => options.queryKey[0] === 'accountingContexts'
    ? m.contexts
    : { data: undefined, isLoading: false, isError: false, refetch: () => {} },
}))

import { GetLoanFlow } from '@/components/project/GetLoanFlow'

let host: HTMLDivElement
let root: Root
const REFUSAL = 'accept a token to borrow'
const UNREADABLE = "Couldn't read this revnet's loan token."

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const render = () => act(async () => root.render(<GetLoanFlow chainId={8453} projectId={6} />))

it('says the read failed, with a retry, when a project that may accept a token is unread', async () => {
  const refetch = vi.fn()
  m.contexts = { data: undefined, isLoading: false, isFetching: false, isError: true, refetch }
  await render()
  expect(host.textContent).not.toContain(REFUSAL)
  expect(host.textContent).toContain(UNREADABLE)
  await act(async () => [...host.querySelectorAll('button')].find(item => item.textContent === 'Retry')!.click())
  expect(refetch).toHaveBeenCalled()
})

it('keeps the refusal for a project the chain says accepts nothing', async () => {
  m.contexts = { data: [], isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }
  await render()
  expect(host.textContent).toContain(REFUSAL)
  expect(host.textContent).not.toContain(UNREADABLE)
})
