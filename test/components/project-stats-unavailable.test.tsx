import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ participants: { data: undefined as unknown, isLoading: false, isError: false, isFetching: false }, trusted: true as boolean | undefined }))
vi.mock('wagmi', () => ({ useConfig: () => ({}) }))
vi.mock('@/hooks/useIndexedAmountsTrusted', () => ({ useIndexedAmountsTrusted: () => mocks.trusted }))
vi.mock('@tanstack/react-query', async original => ({
  ...await original<typeof import('@tanstack/react-query')>(),
  useQueryClient: () => ({}),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => queryKey[0] === 'participants' ? mocks.participants : { data: undefined, isLoading: false },
}))
import { ProjectStats } from '@/components/project/ProjectStats'

const render = (totalRaisedUsd = '0') => renderToStaticMarkup(<ProjectStats totalRaisedUsd={totalRaisedUsd} raisedByChain={[]} paymentsCount={0} suckerGroupId={null} chains={[]} isRevnet />)
describe('holder availability', () => {
  beforeEach(() => {
    mocks.participants = { data: undefined, isLoading: false, isError: false, isFetching: false }
    mocks.trusted = true
  })

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

  // TEMPORARY: remove with useIndexedAmountsTrusted once Bendystraw records each event's token.
  it('hides an indexed raised figure that cannot be trusted', () => {
    const inflated = '99984159000000000000000000'
    expect(render(inflated)).toContain('$99,984,159')
    mocks.trusted = false
    expect(render(inflated)).not.toContain('$99')
    expect(render(inflated)).toMatch(/>—<\/span>[\s\S]*raised/)
    mocks.trusted = undefined
    expect(render(inflated)).not.toContain('$99')
  })
})
