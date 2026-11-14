import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ProjectContractWarning } from '@/components/project/ProjectContractWarning'

const mocks = vi.hoisted(() => ({ query: { data: undefined as unknown, isError: false } }))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => mocks.query }))
vi.mock('@/lib/authority', () => ({ clientFor: () => ({}) }))
vi.mock('@/components/ui/AddressLink', () => ({ AddressLink: ({ address }: { address: string }) => address }))

const row = { chainId: 1, role: 'Payment terminal', address: '0x00000000000000000000000000000000000000A1', note: 'Note.' }
const show = (query: typeof mocks.query) => {
  mocks.query = query
  return renderToStaticMarkup(<ProjectContractWarning chains={[[1, 9], [8453, 9]]} isRevnet={false} />)
}
const clean = (chainId: number) => ({ chainId, unknown: [], failed: false })

describe('the unknown contracts warning', () => {
  it('shows nothing while the check runs or when every contract is known', () => {
    expect(show({ data: undefined, isError: false })).toBe('')
    expect(show({ data: [clean(1), clean(8453)], isError: false })).toBe('')
  })

  it('lists an unknown contract with its chain and role, and names a chain it could not read', () => {
    const html = show({ data: [{ chainId: 1, unknown: [row], failed: false }, { ...clean(8453), failed: true }], isError: false })
    expect(html).toContain('Unknown project contracts')
    expect(html).toContain('Ethereum | Payment terminal')
    expect(html).toContain(row.address)
    expect(html).toContain('also did not finish on Base,')
  })

  it('never reads an unfinished check as a clean one', () => {
    expect(show({ data: [clean(1), { ...clean(8453), failed: true }], isError: false })).toContain('did not finish on Base.')
    const html = show({ data: undefined, isError: true })
    expect(html).toContain('Could not verify this project’s contracts')
    expect(html).toContain('did not finish on Ethereum, Base.')
  })
})
