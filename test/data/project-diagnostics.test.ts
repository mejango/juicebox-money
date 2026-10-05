import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ diagnostics: vi.fn(), project: vi.fn(), members: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getProjectDeploymentDiagnostics: mocks.diagnostics,
}))
vi.mock('@/lib/bendystraw', async original => ({
  ...await original<typeof import('@/lib/bendystraw')>(),
  getProject: mocks.project,
  getSuckerGroupProjects: mocks.members,
}))

import { GET } from '@/app/api/project-diagnostics/route'

const deployment = {
  version: 6, chainId: 84532, projectId: '45', kind: 'juicebox',
  checkedAt: '2026-10-04T12:00:00.000Z', checkedBlock: '1234',
  checks: [{ id: 'hook', category: 'hook', status: 'unsupported', label: 'Custom hook', message: 'This custom hook cannot be verified by this checker.' }],
}

const read = (params = 'chainId=84532&projectId=45&version=6') => GET(new Request(`https://juicebox.money/api/project-diagnostics?${params}`))

describe('deployment diagnostics endpoint', () => {
  beforeEach(() => {
    mocks.diagnostics.mockResolvedValue(deployment)
    mocks.project.mockResolvedValue({ projectId: 45 })
  })

  it('keeps contract results independent of a failed indexer and copies no endpoint details', async () => {
    mocks.project.mockRejectedValue(new Error('https://private.example?key=secret failed'))
    const response = await read()
    const report = await response.json()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(report.deployment).toEqual(deployment)
    expect(report.indexer.status).toBe('unavailable')
    expect(JSON.stringify(report)).not.toMatch(/secret|private\.example/)
    expect(mocks.project).toHaveBeenCalledWith(84532, 45, { policy: 'no-store' })
    expect(mocks.diagnostics).toHaveBeenCalledWith(expect.anything(), { chainId: 84532, projectId: 45n })
  })

  it('reports a missing record without claiming indexing is catching up', async () => {
    mocks.project.mockResolvedValue(null)
    const report = await (await read()).json()
    expect(report.indexer.status).toBe('missing')
    expect(report.indexer.message).not.toMatch(/catching up|just launched/)
    expect(report.deployment.checks[0].status).toBe('unsupported')
  })

  it('keeps a successful indexer read when contract reads fail', async () => {
    mocks.diagnostics.mockRejectedValue(new Error('rpc API_KEY=secret'))
    const report = await (await read()).json()
    expect(report.indexer.status).toBe('available')
    expect(report.deployment.checks[0].status).toBe('unavailable')
    expect(JSON.stringify(report)).not.toMatch(/API_KEY|secret/)
  })

  it.each([
    { members: [] },
    { members: [{ chainId: 1, projectId: 45, version: 6 }] },
    { members: [{ chainId: 84532, projectId: 45, version: 5 }] },
  ])('marks incomplete linked records as unavailable totals', async ({ members }) => {
    mocks.project.mockResolvedValue({ chainId: 84532, projectId: 45, version: 6, suckerGroupId: 'group' })
    mocks.members.mockResolvedValue(members)
    const report = await (await read()).json()
    expect(report.indexer.status).toBe('incomplete')
    expect(report.indexer.linkedProjectsStatus).toBe('incomplete')
    expect(mocks.members).toHaveBeenCalledWith('group', 84532, { policy: 'no-store' })
  })

  it('checks supplied operator powers without treating indexer availability as proof of authority', async () => {
    const operator = '0x1111111111111111111111111111111111111111'
    await read(`chainId=84532&projectId=45&version=6&operator=${operator}`)
    expect(mocks.diagnostics).toHaveBeenCalledWith(expect.anything(), { chainId: 84532, projectId: 45n, operator })
  })

  it('accepts a successful one-project group and distinguishes a failed linked read', async () => {
    const project = { chainId: 84532, projectId: 45, version: 6, suckerGroupId: 'group' }
    mocks.project.mockResolvedValue(project)
    mocks.members.mockResolvedValue([project])
    expect((await (await read()).json()).indexer).toMatchObject({ status: 'available', linkedProjectsStatus: 'available' })
    mocks.members.mockRejectedValue(new Error('Secret endpoint request failed'))
    const failed = await (await read()).json()
    expect(failed.indexer).toMatchObject({ status: 'incomplete', linkedProjectsStatus: 'unavailable' })
    expect(JSON.stringify(failed)).not.toContain('Secret')
  })

  it.each([
    'chainId=999&projectId=45&version=6',
    'chainId=84532&projectId=0&version=6',
    'chainId=84532&projectId=-1&version=6',
    'chainId=84532&projectId=1.5&version=6',
    'chainId=84532&projectId=9007199254740992&version=6',
    'chainId=84532&projectId=45&version=5',
    'chainId=84532&projectId=45',
    'chainId=84532&projectId=45&version=6&operator=invalid',
  ])('does no reads for unsupported or invalid identity %s', async params => {
    expect((await read(params)).status).toBe(400)
    expect(mocks.diagnostics).not.toHaveBeenCalled()
    expect(mocks.project).not.toHaveBeenCalled()
  })
})
