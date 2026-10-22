import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ resolveSuckers: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core', async original => ({ ...await original<typeof import('@bananapus/nana-sdk-core')>(), resolveSuckers: m.resolveSuckers }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getV6SuckerPairs: async () => [{ local: '0x5555555555555555555555555555555555555555', remoteChainId: 8453n }],
  getTokenAddress: async () => '0x6666666666666666666666666666666666666666',
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ isConnected: true, address: '0x1111111111111111111111111111111111111111', openSignIn: vi.fn() }) }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ status: 'idle', reset: vi.fn() }), txPhaseLabel: () => '' }))
vi.mock('wagmi', () => ({ useConfig: () => ({}) }))
vi.mock('wagmi/actions', () => ({ getPublicClient: () => ({ readContract: async () => 10n ** 18n }) }))

import { MoveCard } from '@/components/project/MoveFlow'
import { clearSuckerGroups } from '@/lib/sucker-group'

const LINE = "The Base project listed here isn't linked onchain."
let renderer: ReactTestRenderer | undefined

beforeEach(() => {
  clearSuckerGroups()
  m.resolveSuckers.mockReset().mockResolvedValue([{ peerChainId: 1, projectId: 17n }, { peerChainId: 8453, projectId: 303n }])
})
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount())
  renderer = undefined
})

async function renderWithAmount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><MoveCard chainId={1} projectId={17} chains={[[1, 17], [8453, 303]]} /></QueryClientProvider>)
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const input = renderer!.root.findAll(node => node.type === 'input' && node.props.inputMode === 'decimal')[0]
  await act(async () => { input.props.onChange({ target: { value: '1' } }) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return [JSON.stringify(renderer!.toJSON()), ...renderer!.root.findAllByType('button').map(node => node.children.join(''))].join('\n')
}

describe('moving tokens to a deployment the indexer lists', () => {
  it('builds the move when the onchain registry links both ends', async () => {
    const page = await renderWithAmount()
    expect(page).toContain('Move to Base')
    expect(page).not.toContain(LINE)
    expect(page).not.toContain('Checking…')
  })
  it('shows one line and no move when the registry links another Base project', async () => {
    m.resolveSuckers.mockResolvedValue([{ peerChainId: 1, projectId: 17n }, { peerChainId: 8453, projectId: 304n }])
    const page = await renderWithAmount()
    expect(page).toContain(LINE)
    expect(page).not.toContain('Move to Base')
  })
  it('holds the button in its loading state while the registry is read', async () => {
    m.resolveSuckers.mockReturnValue(new Promise(() => {}))
    const page = await renderWithAmount()
    expect(page).toContain('Checking…')
    expect(page).not.toContain(LINE)
    expect(page).not.toContain('Move to Base')
  })
})
