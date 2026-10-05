import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ participants: { data: undefined as unknown, isLoading: false, isError: false, isFetching: false } }))
vi.mock('wagmi', () => ({ useConfig: () => ({}) }))
vi.mock('@tanstack/react-query', () => ({ useQuery: ({ queryKey }: { queryKey: unknown[] }) => queryKey[0] === 'participants' ? mocks.participants : { data: undefined, isLoading: false } }))
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
