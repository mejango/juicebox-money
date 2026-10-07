import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), invalidate: vi.fn(), copy: vi.fn(), refreshDisplay: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/app/actions/project-display', () => ({ refreshProjectDisplay: mocks.refreshDisplay }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }), useParams: () => ({ urn: 'basesep:45' }) }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }))
vi.mock('@/components/ui/ModalShell', () => ({ ModalShell: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => <section>{children}{footer}</section> }))
vi.mock('next/dynamic', async () => {
  const { default: Dialog } = await import('@/components/project/ProjectDeploymentDialog')
  return { default: () => Dialog }
})

import { ProjectDataStatus } from '@/components/project/ProjectDataStatus'
import ProjectError from '@/app/[urn]/error'
const deployments = [{ chainId: 84532, projectId: 45, version: 6, suckerGroupId: 'known-group' }, { chainId: 1, projectId: 9, version: 6 }]
const report = (id = '45') => ({
  checkedAt: '2026-10-04T12:00:00.000Z',
  deployment: {
    chainId: 84532, projectId: id, version: 6, kind: 'juicebox', checkedBlock: '1234',
    checks: [
      { id: 'exists', category: 'project', label: `Project ${id}`, status: 'passed', message: 'The project exists.' },
      { id: 'hook', category: 'hook', label: 'Hook', status: 'unsupported', message: 'A custom hook requires its own checks.' },
    ],
  },
  indexer: { status: 'unavailable', message: 'The project data request failed.' },
})
let tree: TestRenderer.ReactTestRenderer | null = null
const text = (node: ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('')
const button = (label: string) => tree!.root.findAllByType('button').find(node => text(node) === label)!
async function render(props: Parameters<typeof ProjectDataStatus>[0] = { deployments }) {
  await act(async () => { tree = TestRenderer.create(<ProjectDataStatus {...props} />) })
}
beforeEach(() => {
  mocks.invalidate.mockResolvedValue(undefined)
  mocks.copy.mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText: mocks.copy } })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(report())))
})
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = null })

describe('project data status and deployment checks', () => {
  it('gives unknown identity a retry and opt-in check instead of a not-found claim', async () => {
    const retry = vi.fn()
    await act(async () => { tree = TestRenderer.create(<ProjectError error={new Error('Unavailable')} retry={retry} />) })
    expect(text(tree!.root)).toContain('existence and configuration are unconfirmed')
    expect(text(tree!.root)).not.toMatch(/not found|exists onchain/)
    await act(async () => button('Retry').props.onClick())
    expect(retry).toHaveBeenCalledOnce()
    expect(button('Check deployment')).toBeDefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lets the outer boundary recover a stale client bundle', () => {
    const stale = Object.assign(new Error('old chunk'), { name: 'ChunkLoadError' })
    expect(() => renderToStaticMarkup(<ProjectError error={stale} retry={vi.fn()} />)).toThrow(stale)
  })
  it('does no diagnostics until requested on a healthy project, then separates custom wiring and data availability', async () => {
    await render()
    expect(fetch).not.toHaveBeenCalled()
    await act(async () => button('Check deployment').props.onClick())
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('chainId=84532&projectId=45&version=6'), expect.objectContaining({ cache: 'no-store' }))
    expect(text(tree!.root)).toContain('Custom / unsupported')
    expect(text(tree!.root)).toContain('The project data request failed.')
    expect(text(tree!.root)).toContain('Block 1234')
    expect(text(tree!.root)).not.toContain('Mismatch')
    await act(async () => button('Copy diagnostics').props.onClick())
    expect(JSON.parse(mocks.copy.mock.calls[0][0])).toEqual(report())
  })

  it.each(['not-indexed', 'indexer-error', 'partial'] as const)('shows truthful %s copy and retries server and client data', async notice => {
    await render({ deployments, notice })
    expect(text(tree!.root)).not.toMatch(/catching up|just launched|finished indexing/)
    await act(async () => button('Retry').props.onClick())
    expect(mocks.invalidate).toHaveBeenCalledOnce()
    expect(mocks.refreshDisplay.mock.calls).toEqual([[84532, 45, 'known-group'], [1, 9, undefined]])
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps a copyable manual report when clipboard access is blocked', async () => {
    mocks.copy.mockRejectedValue(new Error('Denied'))
    await render()
    await act(async () => button('Check deployment').props.onClick())
    await act(async () => button('Copy diagnostics').props.onClick())
    expect(JSON.parse(tree!.root.findByType('textarea').props.value)).toEqual(report())
  })

  it('discards an old pending response after switching deployments', async () => {
    let resolveFirst!: (value: Response) => void
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce(Response.json(report('9')))
    vi.stubGlobal('fetch', fetchMock)
    await render()
    await act(async () => button('Check deployment').props.onClick())
    await act(async () => tree!.root.findByType('select').props.onChange({ target: { value: '1' } }))
    await act(async () => resolveFirst(Response.json(report('45'))))
    expect(text(tree!.root)).toContain('Project 9')
    expect(text(tree!.root)).not.toContain('Project 45')
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('resets the read session if refreshed deployments remove the selected chain', async () => {
    await render()
    await act(async () => button('Check deployment').props.onClick())
    vi.mocked(fetch).mockResolvedValue(Response.json(report('9')))
    await act(async () => tree!.root.findByType('select').props.onChange({ target: { value: '1' } }))
    await act(async () => tree!.update(<ProjectDataStatus deployments={[deployments[0]]} />))
    expect(text(tree!.root)).not.toContain('Project 9')
    vi.mocked(fetch).mockResolvedValue(Response.json(report('45')))
    await act(async () => button('Check deployment').props.onClick())
    expect(text(tree!.root)).toContain('Project 45')
    expect(tree!.root.findByType('select').props.value).toBe(0)
  })

  it('does not read V6 contracts for an earlier project version', async () => {
    await render({ deployments: [{ ...deployments[0], version: 5 }] })
    await act(async () => button('Check deployment').props.onClick())
    expect(text(tree!.root)).toContain('supports Juicebox V6')
    expect(fetch).not.toHaveBeenCalled()
  })
})
