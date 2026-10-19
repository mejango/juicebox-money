import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress } from 'viem'

const m = vi.hoisted(() => ({
  token: { data: '0x0000000000000000000000000000000000000000' as string | undefined, isLoading: false },
  supply: { data: 0n as bigint | undefined, isLoading: false, isSuccess: true },
  ruleset: { data: { ruleset: { weight: 0n } }, isPending: false, isSuccess: true },
  read: vi.fn(),
  rulesetQuery: vi.fn(),
}))
vi.mock('wagmi', () => ({
  usePublicClient: () => ({}),
  useReadContract: (options: { functionName: string }) => {
    m.read(options)
    return options.functionName === 'tokenOf' ? m.token : m.supply
  },
  useReadContracts: () => ({ data: [{ result: 'Project token' }, { result: 'TEST' }] }),
}))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => m.ruleset }))
vi.mock('@/lib/project-display-queries', () => ({
  currentRulesetQuery: (...args: unknown[]) => { m.rulesetQuery(...args); return { queryKey: ['test-ruleset'] } },
}))
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => createElement('img', { alt: props.alt }) }))
vi.mock('@/components/ui/AddressLink', () => ({ AddressLink: ({ address }: { address: string }) => createElement('span', null, address) }))
vi.mock('@/components/project/ConceptTerm', () => ({ ConceptTerm: ({ children }: { children: string }) => children }))
import { TokenPanel } from '@/components/project/TokenPanel'

const panel = () => renderToStaticMarkup(<TokenPanel chainId={1} projectId={12} chainIds={[1]} />)
beforeEach(() => {
  m.token = { data: zeroAddress, isLoading: false }
  m.supply = { data: 0n, isLoading: false, isSuccess: true }
  m.ruleset = { data: { ruleset: { weight: 0n } }, isPending: false, isSuccess: true }
})

describe('project token and credit availability', () => {
  it('states that zero-weight, zero-supply projects offer no tokens or credits on the selected chain', () => {
    const html = panel()
    expect(html).toContain('does not currently offer tokens or credits for payments on Ethereum')
    expect(html).toContain('No tokens or credits are in circulation on this chain.')
    expect(html).not.toContain('holders can claim')
    expect(m.read).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'totalSupplyOf', chainId: 1, args: [12n] }))
    expect(m.rulesetQuery).toHaveBeenCalledWith(expect.anything(), { chainId: 1, projectId: 12n })
  })

  it('preserves existing credits when current issuance has stopped', () => {
    m.supply.data = 10n
    const html = panel()
    expect(html).toContain('do not currently issue new credits')
    expect(html).toContain('Existing credit balances')
    expect(html).not.toContain('No tokens or credits are in circulation')
  })

  it('describes possible credits when issuance is positive, even before the first payment', () => {
    m.ruleset.data.ruleset.weight = 1n
    expect(panel()).toContain('Payments can issue credits recorded within Juicebox.')
  })

  it('keeps deployed ERC-20 metadata and disables credit-only supply reads', () => {
    m.token.data = '0x1111111111111111111111111111111111111111'
    const html = panel()
    expect(html).toContain('Project token')
    expect(html).toContain('$TEST')
    expect(html).not.toContain('does not currently offer')
    expect(m.read).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'totalSupplyOf', query: expect.objectContaining({ enabled: false }) }))
  })

  it.each(['token', 'supply', 'ruleset'] as const)('uses a skeleton while %s evidence is loading', source => {
    if (source === 'ruleset') m.ruleset.isPending = true
    else m[source].isLoading = true
    expect(panel()).toContain('Loading token details')
    expect(panel()).not.toContain('does not currently offer')
  })

  it.each(['token', 'supply', 'ruleset'] as const)('keeps missing %s evidence unknown rather than asserting empty credits', source => {
    if (source === 'token') m.token.data = undefined
    if (source === 'supply') m.supply.isSuccess = false
    if (source === 'ruleset') m.ruleset.isSuccess = false
    const html = panel()
    expect(html).toContain('Token and credit information is temporarily unavailable.')
    expect(html).not.toContain('does not currently offer')
    expect(html).not.toContain('Payments can issue')
  })
})
