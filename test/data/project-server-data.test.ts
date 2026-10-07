import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BsProject } from '@/lib/bendystraw'

const reads = vi.hoisted(() => ({
  project: vi.fn(), shell: vi.fn(), siblings: vi.fn(), activity: vi.fn(), projectActivity: vi.fn(),
}))
vi.mock('@/lib/bendystraw', async original => ({
  ...await original<typeof import('@/lib/bendystraw')>(),
  getProject: reads.project,
  getSuckerGroupProjects: reads.siblings,
  getProjectActivity: reads.activity,
  getProjectActivityByProject: reads.projectActivity,
}))
vi.mock('@/lib/project-fallback', async original => ({
  ...await original<typeof import('@/lib/project-fallback')>(),
  readOnChainProject: reads.shell,
}))

const owner = '0x1111111111111111111111111111111111111111'
function project(chainId = 1, projectId = 7): BsProject {
  return {
    chainId, projectId, version: 6, name: 'Project', owner,
    suckerGroupId: 'group', logoUri: null, projectTagline: null, metadataUri: null,
    volume: '0', volumeUsd: '0', balance: '0', paymentsCount: 0, contributorsCount: 0,
    createdAt: 1, token: null, tokenSymbol: 'ETH', decimals: 18, currency: 1, isRevnet: false,
  }
}
const shell = { owner, metadataUri: null, metadataUriResolved: true }
let data: typeof import('@/lib/project-server-data')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
  for (const read of Object.values(reads)) read.mockReset()
  reads.project.mockImplementation(async (chainId: number, projectId: number) => project(chainId, projectId))
  reads.shell.mockResolvedValue(shell)
  reads.siblings.mockResolvedValue([project()])
  reads.activity.mockResolvedValue({ items: [], totalCount: 0 })
  reads.projectActivity.mockResolvedValue({ items: [], totalCount: 0 })
  data = await import('@/lib/project-server-data')
})

describe('bounded server project display reads', () => {
  it('shares concurrent body and preview identity reads and expires successful evidence after 30 seconds', async () => {
    const preview = await import('@/lib/project-link-preview')
    await Promise.all([data.getProjectPageData(1, 7), preview.getProjectLinkPreview(1, 7)])
    expect(reads.project).toHaveBeenCalledTimes(1)
    expect(reads.shell).toHaveBeenCalledTimes(1)
    expect(reads.project).toHaveBeenCalledWith(1, 7, { policy: 'no-store' })
    vi.setSystemTime(Date.now() + 29_999)
    await data.getProjectPageData(1, 7)
    expect(reads.project).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 1)
    await data.getProjectPageData(1, 7)
    expect(reads.project).toHaveBeenCalledTimes(2)
    expect(reads.shell).toHaveBeenCalledTimes(2)
  })

  it('isolates chain and project keys', async () => {
    await Promise.all([data.getProjectPageData(1, 7), data.getProjectPageData(10, 7), data.getProjectPageData(1, 8)])
    expect(reads.project).toHaveBeenCalledTimes(3)
    expect(reads.shell).toHaveBeenCalledTimes(3)
  })

  it('does not persist a missing project or an unresolved metadata pointer', async () => {
    reads.project.mockResolvedValueOnce(null)
    reads.shell.mockResolvedValueOnce({ ...shell, metadataUriResolved: false })
    expect(await data.getProjectPageData(1, 7)).toMatchObject({ degraded: true, reason: 'not-indexed' })
    expect(await data.getProjectPageData(1, 7)).toMatchObject({ degraded: false })
    expect(reads.project).toHaveBeenCalledTimes(2)
    expect(reads.shell).toHaveBeenCalledTimes(2)
  })

  it('returns a 404 candidate only on a current negative read and immediately retries it', async () => {
    reads.project.mockResolvedValueOnce(null)
    reads.shell.mockResolvedValueOnce(null)
    expect(await data.getProjectPageData(1, 7)).toBeNull()
    expect(await data.getProjectPageData(1, 7)).toMatchObject({ degraded: false })
    expect(reads.project).toHaveBeenCalledTimes(2)
    expect(reads.shell).toHaveBeenCalledTimes(2)
  })

  it('does not extend an expired success when both sources fail and recovers on the next read', async () => {
    await data.getProjectPageData(1, 7)
    vi.setSystemTime(Date.now() + 30_000)
    reads.project.mockRejectedValueOnce(new Error('indexer down'))
    reads.shell.mockRejectedValueOnce(new Error('RPC down'))
    await expect(data.getProjectPageData(1, 7)).rejects.toThrow('temporarily unavailable')
    expect(await data.getProjectPageData(1, 7)).toMatchObject({ degraded: false })
    expect(reads.project).toHaveBeenCalledTimes(3)
    expect(reads.shell).toHaveBeenCalledTimes(3)
  })

  it('preserves incomplete sibling rows without caching them as a complete group', async () => {
    reads.siblings.mockResolvedValueOnce([project(10, 8)])
    expect(await data.getProjectSiblings(1, 7, 'group')).toEqual([project(10, 8)])
    expect(await data.getProjectSiblings(1, 7, 'group')).toEqual([project()])
    await data.getProjectSiblings(1, 7, 'group')
    expect(reads.siblings).toHaveBeenCalledTimes(2)
  })

  it('invalidates only the changed project and sibling snapshots containing it', async () => {
    reads.siblings.mockResolvedValue([project(), project(10, 8)])
    await Promise.all([
      data.getProjectPageData(1, 7), data.getProjectPageData(10, 8),
      data.getProjectSiblings(1, 7, 'group'),
    ])
    await data.invalidateProjectDisplay(10, 8)
    await Promise.all([
      data.getProjectPageData(1, 7), data.getProjectPageData(10, 8),
      data.getProjectSiblings(1, 7, 'group'),
    ])
    expect(reads.project).toHaveBeenCalledTimes(3)
    expect(reads.shell).toHaveBeenCalledTimes(3)
    expect(reads.siblings).toHaveBeenCalledTimes(2)
  })

  it('cancels an invalidated in-flight result so late completion cannot repopulate the cache', async () => {
    let finish!: (value: BsProject) => void
    reads.project.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const original = data.getIndexedProjectDisplay(1, 7).catch(() => null)
    await data.invalidateProjectDisplay(1, 7)
    const changed = { ...project(), name: 'New name' }
    reads.project.mockResolvedValue(changed)
    expect(await data.getIndexedProjectDisplay(1, 7)).toEqual(changed)
    finish(project())
    await original
    expect(await data.getIndexedProjectDisplay(1, 7)).toEqual(changed)
    expect(reads.project).toHaveBeenCalledTimes(2)
  })

  it('retains actual activity completion age and refetches only after its 15 second window', async () => {
    const first = await data.getProjectActivityDisplay(1, 7, 'group')
    expect(first.value).toEqual({ items: [], totalCount: 0 })
    expect(reads.activity).toHaveBeenCalledWith('group', 250, 1, 0, { policy: 'no-store' })
    vi.setSystemTime(Date.now() + 10_000)
    expect(await data.getProjectActivityDisplay(1, 7, 'group')).toEqual(first)
    expect(reads.activity).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 5_000)
    expect((await data.getProjectActivityDisplay(1, 7, 'group')).updatedAt).toBe(first.updatedAt + 15_000)
    expect(reads.activity).toHaveBeenCalledTimes(2)
  })

  it('evicts a known in-flight group after a peer deployment changes', async () => {
    let finish!: (projects: BsProject[]) => void
    reads.siblings.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const original = data.getProjectSiblings(1, 7, 'group').catch(() => null)
    await data.invalidateProjectDisplay(10, 8, 'group')
    const changed = [project(), { ...project(10, 8), name: 'New peer' }]
    reads.siblings.mockResolvedValue(changed)
    expect(await data.getProjectSiblings(1, 7, 'group')).toEqual(changed)
    finish([project(), project(10, 8)])
    await original
    expect(await data.getProjectSiblings(1, 7, 'group')).toEqual(changed)
    expect(reads.siblings).toHaveBeenCalledTimes(2)
  })

  it('leaves unrelated pending groups and unknown peers alone, with the regular 30s freshness bound', async () => {
    let finish!: (projects: BsProject[]) => void
    reads.siblings.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const original = data.getProjectSiblings(1, 7, 'group')
    await data.invalidateProjectDisplay(10, 8, 'other-group')
    finish([project(), project(10, 8)])
    expect(await original).toEqual([project(), project(10, 8)])
    await data.getProjectSiblings(1, 7, 'group')
    expect(reads.siblings).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 30_000)
    await data.getProjectSiblings(1, 7, 'group')
    expect(reads.siblings).toHaveBeenCalledTimes(2)
  })

  it('does not cache failed activity as an empty successful feed', async () => {
    reads.projectActivity.mockRejectedValueOnce(new Error('feed unavailable'))
    await expect(data.getProjectActivityDisplay(1, 7, null)).rejects.toThrow('feed unavailable')
    expect((await data.getProjectActivityDisplay(1, 7, null)).value.items).toEqual([])
    expect(reads.projectActivity).toHaveBeenCalledTimes(2)
  })
})
