// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewedResult } from '@bananapus/nana-sdk-core/review'
import type { ReviewedRun } from '@/hooks/useReviewedAction'
import '../dialog-shim'

const SUCKER = '0x5555555555555555555555555555555555555555'
const PROJECT_TOKEN = '0x6666666666666666666666666666666666666666'
const NATIVE = '0x000000000000000000000000000000000000EEEe'
const HASH = `0x${'ab'.repeat(32)}` as Hex

const m = vi.hoisted(() => ({
  runs: [] as ReviewedRun[],
  /** How each run ends, in order; a run past the list confirms. */
  ends: [] as (ReviewedResult | null)[],
  allowance: 0n,
  /** Settles the step a run left with a Safe, as its hold does. */
  settle: () => {},
}))

vi.mock('@bananapus/nana-sdk-core', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core')>(),
  resolveSuckers: async () => [{ peerChainId: 1, projectId: 17n }, { peerChainId: 8453, projectId: 303n }],
}))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getV6SuckerPairs: async () => [{ local: SUCKER, remoteChainId: 8453n }],
  getTokenAddress: async () => PROJECT_TOKEN,
  getAccountingContexts: async () => [{ token: NATIVE, decimals: 18, currency: 61166 }],
}))
vi.mock('@/components/project/SettlementSection', async original => ({
  ...await original<typeof import('@/components/project/SettlementSection')>(),
  classifyInfra: async () => 'native',
  findToRemoteValue: async () => 7n,
  unpackAddress: () => NATIVE,
}))
vi.mock('@/lib/token-symbol', () => ({ tokenSymbol: async () => 'ETH' }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ isConnected: true, address: '0x1111111111111111111111111111111111111111', openSignIn: vi.fn() }) }))
vi.mock('wagmi', () => ({ useConfig: () => ({}) }))
vi.mock('wagmi/actions', () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => ({
      projectId: 17n,
      remoteTokenFor: { enabled: true, emergencyHatch: false, minGas: 0, addr: `0x${'00'.repeat(31)}01` },
      balanceOf: 10n ** 19n,
      previewCashOutFrom: [0, 10n ** 18n, 0n, []],
      allowance: m.allowance,
    })[functionName],
  }),
}))
vi.mock('@/lib/reviewed-send', () => ({
  SAVED_SEQUENCE_LINE: 'saved',
  planShown: (saved: boolean, shown: object) => (saved ? { description: 'saved' } : shown),
  sequenceCalls: async (scope: string, _account: string, calls: unknown[]) => ({ calls, saved: false, ...(calls.length > 1 ? { scope } : {}) }),
}))
/** The engine: each run is recorded and ends as the test says, its phase following. */
vi.mock('@/hooks/useReviewedAction', async () => {
  const { useState } = await import('react')
  return {
    ...(await import('@/lib/reviewed-call')),
    txPhaseLabel: () => '',
    useReviewedAction: () => {
      const [phase, setPhase] = useState('idle')
      m.settle = () => setPhase('success')
      return {
        phase, busy: false, step: 0, error: null, notice: null, failure: null, hash: phase === 'success' ? HASH : null,
        reset: () => setPhase('idle'), dismiss: () => setPhase('idle'),
        run: async (action: ReviewedRun) => {
          m.runs.push(action)
          const end = m.ends.length ? m.ends.shift()! : { status: 'done' as const, hashes: [HASH], receipts: [] }
          setPhase(end?.status === 'done' ? 'success' : end?.status === 'proposed' ? 'submitted' : 'error')
          return end
        },
      }
    },
  }
})

import { MoveCard } from '@/components/project/MoveFlow'
import { clearSuckerGroups } from '@/lib/sucker-group'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  clearSuckerGroups()
  m.runs = []
  m.ends = []
  m.allowance = 0n
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

async function startMove() {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => root.render(<QueryClientProvider client={queries}><MoveCard chainId={1} projectId={17} chains={[[1, 17], [8453, 303]]} /></QueryClientProvider>))
  for (let attempt = 0; attempt < 20 && !host.querySelector('input[inputmode="decimal"]'); attempt++) await tick()
  const input = host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '1')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  for (let attempt = 0; attempt < 20 && ![...host.querySelectorAll('button')].some(item => item.textContent === 'Move to Base' && !item.disabled); attempt++) await tick()
  await act(async () => [...host.querySelectorAll('button')].find(item => item.textContent === 'Move to Base')!.click())
  for (let attempt = 0; attempt < 20; attempt++) await tick()
}

const names = (run: ReviewedRun) => run.calls.map(call => call.functionName)

describe('moving tokens', () => {
  it('wallet-action:approve-and-prepare-token-move reviews the approval and the prepare once, then the send once the move is queued', async () => {
    await startMove()
    expect(m.runs.map(names)).toEqual([['approve', 'prepare'], ['toRemote']])
    const [prepare, send] = m.runs
    expect(prepare.calls[1].dependsOnPrior).toBe(true)
    expect(prepare.scope).toBeDefined()
    // The review carries the move's own summary.
    expect(prepare.context?.map(row => row.label)).toContain('Beneficiary')
    expect(send.calls[0].value).toBe(7n)
  })

  it('moves on to the send once a lone prepare settles with a Safe, never preparing again', async () => {
    m.allowance = 10n ** 19n
    m.ends = [{ status: 'proposed', step: 0, safeTxHash: HASH }]
    await startMove()
    await act(async () => m.settle())
    for (let attempt = 0; attempt < 20; attempt++) await tick()
    expect(m.runs.map(names)).toEqual([['prepare'], ['toRemote']])
  })

  it('reviews the prepare alone when the bridge already has the allowance', async () => {
    m.allowance = 10n ** 19n
    await startMove()
    expect(m.runs.map(names)).toEqual([['prepare'], ['toRemote']])
    expect(m.runs[0].scope).toBeUndefined()
  })

  it('sends nothing more while the approval waits in a Safe, then runs the same calls again once it executes', async () => {
    m.ends = [{ status: 'proposed', step: 0, safeTxHash: HASH }]
    await startMove()
    expect(m.runs.map(names)).toEqual([['approve', 'prepare']])
    // The Safe executes the approval: core continues the saved run at the prepare, and only a finished run moves on to the send.
    await act(async () => m.settle())
    for (let attempt = 0; attempt < 20; attempt++) await tick()
    expect(m.runs.map(names)).toEqual([['approve', 'prepare'], ['approve', 'prepare'], ['toRemote']])
    expect(m.runs[1].calls).toEqual(m.runs[0].calls)
  })
})
