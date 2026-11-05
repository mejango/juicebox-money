import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ participants: { data: undefined as unknown, isLoading: false, isError: false, isFetching: false } }))
vi.mock('wagmi', () => ({ useConfig: () => ({}) }))
vi.mock('@tanstack/react-query', async original => ({
  ...await original<typeof import('@tanstack/react-query')>(),
  useQueryClient: () => ({}),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => queryKey[0] === 'participants' ? mocks.participants : { data: undefined, isLoading: false },
}))
import { ProjectStats } from '@/components/project/ProjectStats'

const render = () => renderToStaticMarkup(<ProjectStats totalRaisedUsd="0" raisedByChain={[]} paymentsCount={0} suckerGroupId={null} chains={[]} isRevnet />)
describe('holder availability', () => {
  beforeEach(() => { mocks.participants = { data: undefined, isLoading: false, isError: false, isFetching: false } })

  it.each([false, true])('shows an unknown holder count instead of zero (query error=%s)', isError => {
    mocks.participants.isError = isError
    const html = render()
    expect(html).toContain('>—</span>')
    expect(html).not.toContain('0+')
    expect(html).toMatch(/—[\s\S]*owners/)
  })

  it('shows zero only after a successful empty participant response', () => {
    mocks.participants.data = { items: [], totalCount: 0 }
    expect(render()).toMatch(/>0<\/span>[\s\S]*owners/)
  })
})

describe('raised by chain', () => {
  it('shows the accounting-token amount above the USD when the indexer knows the token', () => {
    const html = renderToStaticMarkup(
      <ProjectStats
        totalRaisedUsd="1200000000000000000000"
        raisedByChain={[
          { chainId: 8453, usd: '1188740000000000000000', volume: '460670000000000000', symbol: 'ETH', decimals: 18 },
          { chainId: 1, usd: '12180000000000000000' },
        ]}
        paymentsCount={0}
        suckerGroupId={null}
        chains={[]}
        isRevnet
      />,
    )
    expect(html).toContain('0.4607 ETH')
    expect(html).toContain('$1,188.74')
    expect(html).toContain('$12.18')
  })
})
