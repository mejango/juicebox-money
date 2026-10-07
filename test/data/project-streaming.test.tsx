import { PassThrough } from 'node:stream'
import { renderToPipeableStream } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { BsProject } from '@/lib/bendystraw'

const reads = vi.hoisted(() => ({ indexed: vi.fn(), project: vi.fn(), activity: vi.fn(), metadata: vi.fn(), siblings: vi.fn() }))
vi.mock('@/lib/project-server-data', () => ({
  getIndexedProjectDisplay: reads.indexed, getProjectPageData: reads.project,
  getProjectActivityDisplay: reads.activity, getProjectMetadata: reads.metadata,
  getProjectSiblings: reads.siblings,
}))
vi.mock('@/lib/project-route.server', () => ({ resolveProjectRouteCached: async () => ({ chainId: 1, projectId: 7, handle: null, verifiedAuthority: null, verifiedIsRevnet: null }) }))
vi.mock('@/lib/project-link-preview', () => ({ getProjectLinkPreview: vi.fn(), projectPreviewSlogan: vi.fn(), previewVersion: vi.fn() }))
vi.mock('@/lib/bendystraw', async original => ({
  ...await original<typeof import('@/lib/bendystraw')>(),
  getRevnetOperatorCandidates: async () => [],
}))
vi.mock('@/components/LoadingSkeletons', () => ({
  ProjectPageSkeleton: ({ hint }: { hint: { name: string } }) => <h1>{hint.name}</h1>,
  ActivityRows: () => <p>Activity loading</p>,
}))
vi.mock('@/components/ProjectLogoWithFallback', () => ({ ProjectLogoWithFallback: () => null }))
vi.mock('@/components/ProjectLink', () => ({ ProjectLink: ({ children }: { children: ReactNode }) => <span>{children}</span> }))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))
vi.mock('@/components/ui/AddressLink', () => ({ AddressLink: () => null }))
vi.mock('@/components/TreasuryCard', () => ({ TreasuryCard: () => <p>Payment panel</p> }))
vi.mock('@/components/project/ProjectStats', () => ({ ProjectStats: () => null }))
vi.mock('@/components/project/ProjectHandleCard', () => ({ ProjectHandleCard: () => null }))
vi.mock('@/components/project/ProjectDataStatus', () => ({ ProjectDataStatus: () => <p>Some project details are unavailable</p> }))
vi.mock('@/components/project/PendingPayments', () => ({ PendingPayments: () => null }))
vi.mock('@/components/project/OverviewTab', () => ({ OverviewTab: () => <p>Overview ready</p> }))
vi.mock('@/components/project/LazyProjectTabs', () => ({
  BackOfficeTab: () => null, ExtrasTab: () => null, FundsTab: () => null, OwnersTab: () => null,
  RulesetsTab: () => null, ShopTab: () => null, TermsTab: () => null,
}))
vi.mock('@/components/project/SafeBatchProvider', () => ({ SafeBatchProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/project/ShopCartProvider', () => ({ ShopCartProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/providers/ProjectRouteContext', () => ({ ProjectRouteSync: () => null }))
vi.mock('@/components/project/Tabs', () => ({ ProjectTabs: ({ activity, sidebar }: { activity: ReactNode; sidebar: ReactNode }) => <main><nav>Project tabs ready</nav>{sidebar}{activity}</main> }))
vi.mock('@/components/ActivityList', () => ({ ActivityList: ({ error, initialEventsUpdatedAt }: { error: boolean; initialEventsUpdatedAt?: number }) => <p data-updated-at={initialEventsUpdatedAt}>{error ? 'Activity unavailable' : 'Activity ready'}</p> }))

import ProjectPage from '@/app/[urn]/page'
const project = {
  chainId: 1, projectId: 7, version: 6, name: 'Indexed identity', owner: '0x1111111111111111111111111111111111111111',
  suckerGroupId: null, logoUri: null, projectTagline: null, metadataUri: null, volumeUsd: '0', paymentsCount: 0,
  createdAt: 1, tokenSymbol: 'ETH', decimals: 18, isRevnet: false,
} as BsProject

function stream() {
  let html = ''
  const errors: unknown[] = []
  const output = new PassThrough()
  output.on('data', chunk => { html += chunk.toString() })
  const rendered = renderToPipeableStream(<html><body><ProjectPage params={Promise.resolve({ urn: 'eth:7' })} /></body></html>, {
    onShellReady: () => rendered.pipe(output), onError: error => { errors.push(error) },
  })
  return { html: () => html, errors, abort: () => rendered.abort() }
}

beforeEach(() => {
  reads.indexed.mockResolvedValue(project)
  reads.project.mockResolvedValue({ project, degraded: false })
  reads.metadata.mockResolvedValue({ name: 'Current identity' })
  reads.siblings.mockResolvedValue([])
})

describe('project server streaming', () => {
  it('paints indexed identity before onchain reconciliation and makes tabs usable while activity is pending', async () => {
    let completeProject!: (result: { project: BsProject; degraded: false }) => void
    let completeActivity!: (result: unknown) => void
    reads.project.mockReturnValue(new Promise(resolve => { completeProject = resolve }))
    reads.activity.mockReturnValue(new Promise(resolve => { completeActivity = resolve }))
    const rendered = stream()
    try {
      await vi.waitFor(() => expect(rendered.html()).toContain('Indexed identity'))
      expect(rendered.html()).not.toContain('Project tabs ready')
      completeProject({ project, degraded: false })
      await vi.waitFor(() => expect(rendered.html()).toContain('Project tabs ready'))
      expect(rendered.html()).toContain('Activity loading')
      expect(rendered.html()).not.toContain('Activity ready')
      completeActivity({ value: { items: [], totalCount: 0 }, updatedAt: 1234 })
      await vi.waitFor(() => expect(rendered.html()).toContain('Activity ready'))
      expect(rendered.html()).toContain('data-updated-at="1234"')
      expect(rendered.errors).toEqual([])
    } finally { rendered.abort() }
  })

  it('keeps project tabs and payment panel available when activity fails', async () => {
    reads.activity.mockRejectedValue(new Error('feed unavailable'))
    const rendered = stream()
    try {
      await vi.waitFor(() => expect(rendered.html()).toContain('Activity unavailable'))
      expect(rendered.html()).toContain('Project tabs ready')
      expect(rendered.html()).toContain('Payment panel')
      expect(rendered.html()).toContain('Some project details are unavailable')
      expect(rendered.html()).not.toContain('data-updated-at=')
      expect(rendered.errors).toEqual([])
    } finally { rendered.abort() }
  })
})
