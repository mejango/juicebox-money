// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NATIVE_TOKEN, USDC_ADDRESSES, revLoansAbi } from '@bananapus/nana-sdk-core'
import { getAccountingContexts } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoansSection, tokenMeta } from '@/components/project/LoansSection'
import { accountingContextsQuery } from '@/lib/project-display-queries'
import { projectTokenQuery } from '@/lib/project-token-query'

const mocks = vi.hoisted(() => ({ client: { readContract: vi.fn() }, run: vi.fn() }))
const HOLDER = '0x1111111111111111111111111111111111111111' as Address
const CUSTOM = '0x2222222222222222222222222222222222222222' as Address
const TERMINAL = '0x3333333333333333333333333333333333333333' as Address

vi.mock('wagmi', () => ({ usePublicClient: () => mocks.client }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: HOLDER }) }))
vi.mock('@/hooks/useViewedAccount', () => ({ useViewedAccount: () => ({ address: HOLDER }) }))
vi.mock('@/hooks/useReviewedAction', async () => ({
  ...await import('@/lib/reviewed-call'),
  useReviewedAction: () => ({ busy: false, phase: 'idle', run: mocks.run, dismiss: vi.fn() }),
  liveStep: () => -1,
  reachedLastStep: () => false,
}))
vi.mock('@/lib/reviewed-send', () => ({
  sequenceCalls: async (scope: string, _account: string, calls: unknown[]) => ({ scope, calls, saved: false }),
  planShown: (_saved: boolean, context: object) => context,
}))
vi.mock('@/components/ui/TxProgress', async original => ({
  ...await original<typeof import('@/components/ui/TxProgress')>(),
  TxProgress: ({ rows, preparing, start, onClose }: { rows: { label: string; value: ReactNode }[]; preparing: boolean; start: () => void; onClose: () => void }) => <section data-review>
    {rows.map((row, index) => <p key={index} data-label={row.label}>{row.value}</p>)}
    {!preparing && <button onClick={start}>Confirm repayment</button>}
    <button onClick={onClose}>Close review</button>
  </section>,
}))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getAccountingContexts: vi.fn(),
}))

let client: QueryClient, host: HTMLDivElement, root: Root
const loan = { id: '7', token: CUSTOM, borrowAmount: '10000000000', collateral: '1000000000000000000', owner: HOLDER, beneficiary: HOLDER, createdAt: 1, chainId: 1, prepaidFeePercent: 25, prepaidDuration: 0, sourceFeeAmount: '0' }
const project = { chainId: 1, projectId: 42n } as const
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }
async function until(ready: () => boolean) {
  for (let attempt = 0; attempt < 50 && !ready(); attempt++) await flush()
  expect(ready()).toBe(true)
}
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={client}><LoansSection chainId={1} projectId={42} /></QueryClientProvider>))
  await flush()
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(button => button.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
  await flush()
}
function review(label: string) { return host.querySelector(`[data-review] [data-label="${label}"]`)?.textContent }
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  client.setQueryData(['loans', 1, 42], { items: [loan], totalCount: 1 })
  client.setQueryData(projectTokenQuery(mocks.client as never, 1, 42).queryKey, { address: CUSTOM, symbol: 'REV' })
  vi.mocked(getAccountingContexts).mockRejectedValue(new Error('Context RPC unavailable'))
  mocks.client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'loanOf') return { amount: 10000000000n, collateral: 10n ** 18n, createdAt: 1, prepaidDuration: 0, prepaidFeePercent: 25, sourceToken: CUSTOM }
    if (functionName === 'TERMINAL') return TERMINAL
    if (functionName === 'revnetIdOfLoanWith') return 42n
    if (functionName === 'accountingContextForTokenOf') return { token: CUSTOM, decimals: 8, currency: 123 }
    if (functionName === 'symbol') return 'COIN'
    if (functionName === 'determineSourceFeeAmount') return 100000000n
    if (functionName === 'allowance') return 10n ** 30n
    throw new Error(`Unexpected read ${functionName}`)
  })
  mocks.run.mockResolvedValue(null)
})
afterEach(() => { act(() => root.unmount()); host.remove(); client.clear() })

describe('loan token units', () => {
  it('keeps unknown custom units unavailable and recovers through the existing context query', async () => {
    await mount()
    expect(host.textContent).toContain('Some loan amounts are unavailable')
    expect(host.textContent).toContain('Unavailable')
    expect(host.textContent).not.toContain('0.00000001')
    await until(() => [...host.querySelectorAll('button')].some(button => button.textContent === 'Retry token data' && !button.disabled))
    vi.mocked(getAccountingContexts).mockResolvedValue([{ token: CUSTOM, decimals: 8, currency: 123 }])
    await click('Retry token data')
    await until(() => host.textContent?.includes('100 COIN') === true)
    expect(host.textContent).toContain('100 COIN')
    expect(host.textContent).not.toContain('Unavailable')
  })

  it('recognizes only chain-authenticated canonical token units without a context read', () => {
    expect(tokenMeta([], NATIVE_TOKEN, 1)).toMatchObject({ decimals: 18, symbol: 'ETH' })
    expect(tokenMeta([], USDC_ADDRESSES[1], 1)).toMatchObject({ decimals: 6, symbol: 'USDC' })
    expect(tokenMeta([], USDC_ADDRESSES[8453], 1)).toBeNull()
    expect(tokenMeta([], CUSTOM, 1)).toBeNull()
  })

  it('freezes review units from the fresh source, even when the indexed source and later metadata disagree', async () => {
    const original = mocks.client.readContract.getMockImplementation()!
    mocks.client.readContract.mockImplementation(async args => args.functionName === 'loanOf'
      ? { amount: 100000000n, collateral: 10n ** 18n, createdAt: 1, prepaidDuration: 0, prepaidFeePercent: 25, sourceToken: USDC_ADDRESSES[1] }
      : args.functionName === 'determineSourceFeeAmount' ? 1000000n : original(args))
    await mount()
    await click('Repay')
    expect(review('Loan')).toBe('100 USDC')
    expect(review('Repay up to')).toBe('101.02 USDC')
    // A late independent book read must not rewrite the frozen repayment review.
    await act(async () => client.setQueryData(accountingContextsQuery(mocks.client as never, project).queryKey, [{ token: CUSTOM, decimals: 0, currency: 123 }]))
    expect(review('Loan')).toBe('100 USDC')
    await click('Confirm repayment')
    const calls = mocks.run.mock.calls[0][0].calls
    const encoded = decodeFunctionData({ abi: revLoansAbi, data: calls[0].data })
    expect(encoded.functionName).toBe('repayLoan')
    expect(encoded.args?.slice(0, 3)).toEqual([7n, 101020000n, 10n ** 18n])
    expect(mocks.client.readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: 'accountingContextForTokenOf' }))
  })

  it('reads the fresh custom source context and leaves raw repayment units unchanged', async () => {
    await mount()
    await click('Repay')
    expect(review('Loan')).toBe('100 COIN')
    expect(review('Repay up to')).toBe('101.02 COIN')
    expect(mocks.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: TERMINAL, functionName: 'accountingContextForTokenOf', args: [42n, CUSTOM] }))
    await click('Confirm repayment')
    expect(mocks.run.mock.calls[0][0].calls[0].args.slice(0, 3)).toEqual([7n, 10102000000n, 10n ** 18n])
  })

  it.each(['failed read', 'token mismatch'])('allows retry after a custom source %s without opening a misleading review', async failure => {
    const original = mocks.client.readContract.getMockImplementation()!
    mocks.client.readContract.mockImplementation(async args => {
      if (args.functionName !== 'accountingContextForTokenOf') return original(args)
      if (failure === 'failed read') throw new Error('RPC unavailable')
      return { token: NATIVE_TOKEN, decimals: 18, currency: 61166 }
    })
    await mount()
    await click('Repay')
    expect(host.textContent).toContain("Couldn't read this loan's token units. Try Repay again.")
    expect([...host.querySelectorAll('button')].some(button => button.textContent === 'Confirm repayment')).toBe(false)
    expect(review('Loan')).toBeUndefined()
    expect(mocks.run).not.toHaveBeenCalled()
    mocks.client.readContract.mockImplementation(original)
    await click('Repay')
    expect(review('Loan')).toBe('100 COIN')
    expect(host.textContent).not.toContain("Couldn't read this loan's token units")
  })
})
