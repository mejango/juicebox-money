import { PassThrough } from 'node:stream'
import { renderToPipeableStream } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { BsProject } from '@/lib/bendystraw'

const reads = vi.hoisted(() => ({ indexed: vi.fn(), project: vi.fn(), activity: vi.fn(), metadata: vi.fn(), siblings: vi.fn(), connection: vi.fn() }))
vi.mock('next/server', () => ({ connection: reads.connection }))
vi.mock('@/lib/project-server-data', () => ({
  getIndexedProjectDisplay: reads.indexed, getProjectPageData: reads.project,
  getProjectActivityDisplay: reads.activity, getProjectMetadata: reads.metadata,
  getProjectSiblings: reads.siblings,
}))
vi.mock('@/lib/project-route.server', () => ({
  resolveProjectRouteCached: async () => ({ chainId: 1, projectId: 7, handle: null, verifiedAuthority: null, verifiedIsRevnet: null }),
  projectRouteSnapshot: (route: unknown) => route,
}))
vi.mock('@/lib/project-link-preview', () => ({ getProjectLinkPreview: vi.fn(), projectPreviewSlogan: vi.fn(), previewVersion: vi.fn() }))
vi.mock('@/lib/bendystraw', async original => ({
  ...await original<typeof import('@/lib/bendystraw')>(),
  getRevnetOperatorCandidates: async () => [],
}))
vi.mock('@/components/LoadingSkeletons', () => ({
  ProjectPageSkeleton: ({ hint }: { hint: { name: string } }) => <h1>{hint.name}</h1>,
  ActivityRows: () => <p>Activity loading</p>,
  ProjectHeaderSkeleton: ({ hint }: { hint: { name: string } }) => <h1>{hint.name}</h1>,
  ProjectPayPanelSkeleton: () => <p>Payment details loading</p>,
  OverviewTabSkeleton: () => <p>Overview loading</p>,
  ActionRowsSkeleton: ({ label }: { label: string }) => <p>{label}</p>,
}))
vi.mock('@/components/ProjectLogoWithFallback', () => ({ ProjectLogoWithFallback: () => null }))
vi.mock('@/components/ProjectLink', () => ({ ProjectLink: ({ children }: { children: ReactNode }) => <span>{children}</span> }))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))
vi.mock('@/components/ui/AddressLink', () => ({ AddressLink: () => null }))
vi.mock('@/components/TreasuryCard', () => ({ TreasuryCard: ({ payDisclosure }: { payDisclosure?: string }) => <p>Payment panel {payDisclosure}</p> }))
vi.mock('@/components/project/ProjectStats', () => ({ ProjectStats: () => null }))
vi.mock('@/components/project/ProjectHandleCard', () => ({ ProjectHandleCard: () => null }))
vi.mock('@/components/project/ProjectDataStatus', () => ({ ProjectDataStatus: () => <p>Some project details are unavailable</p> }))
vi.mock('@/components/project/PendingPayments', () => ({ PendingPayments: () => null }))
vi.mock('@/components/project/OverviewTab', () => ({ OverviewTab: () => <p>Overview ready</p> }))
vi.mock('@/components/project/LazyProjectTabs', () => ({
  BackOfficeTab: () => <p>Metadata editor ready</p>, ExtrasTab: () => null, FundsTab: () => null, OwnersTab: () => <p>Owners ready</p>,
  RulesetsTab: () => <p>Rulesets ready</p>, ShopTab: () => null, TermsTab: () => null,
}))
vi.mock('@/components/project/SafeBatchProvider', () => ({ SafeBatchProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/project/ShopCartProvider', () => ({ ShopCartProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/providers/ProjectRouteContext', () => ({ ProjectRouteBoundary: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/project/Tabs', () => ({ ProjectTabs: ({ activity, sidebar, tabs }: { activity: ReactNode; sidebar: ReactNode; tabs: { label: string; content: ReactNode }[] }) => <main><nav>Project tabs ready</nav>{sidebar}{activity}{tabs.map(tab => <section key={tab.label}>{tab.content}</section>)}</main> }))
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
  reads.connection.mockResolvedValue(undefined)
  reads.activity.mockResolvedValue({ value: { items: [], totalCount: 0 }, updatedAt: 1234 })
  reads.indexed.mockResolvedValue(project)
  reads.project.mockResolvedValue({ project, degraded: false })
  reads.metadata.mockResolvedValue({ name: 'Current identity' })
  reads.siblings.mockResolvedValue([])
})

describe('project server streaming', () => {
  it('rejects a confirmed missing project before returning a streaming boundary', async () => {
    reads.indexed.mockResolvedValue(null)
    reads.project.mockResolvedValue(null)
    await expect(ProjectPage({ params: Promise.resolve({ urn: 'eth:7' }) }))
      .rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404')
  })

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

  it('keeps metadata-independent tabs ready while withholding payment and editors until the actual disclosure resolves', async () => {
    let finishMetadata!: (value: unknown) => void
    reads.metadata.mockReturnValue(new Promise(resolve => { finishMetadata = resolve }))
    const rendered = stream()
    try {
      await vi.waitFor(() => expect(rendered.html()).toContain('Rulesets ready'))
      expect(rendered.html()).toContain('Owners ready')
      expect(rendered.html()).toContain('Overview loading')
      expect(rendered.html()).toContain('Payment details loading')
      expect(rendered.html()).not.toContain('Payment panel')
      expect(rendered.html()).not.toContain('Metadata editor ready')
      expect(reads.connection).toHaveBeenCalled()
      finishMetadata({ name: 'Fresh metadata name', payDisclosure: 'Required payment notice' })
      await vi.waitFor(() => expect(rendered.html()).toContain('Payment panel'))
      expect(rendered.html()).toContain('Fresh metadata name')
      expect(rendered.html()).toContain('Required payment notice')
      expect(rendered.html()).toContain('Metadata editor ready')
      expect(rendered.errors).toEqual([])
    } finally { rendered.abort() }
  })

  it('preserves the existing indexed fallback after a failed metadata read completes', async () => {
    reads.metadata.mockResolvedValue(null)
    const rendered = stream()
    try {
      await vi.waitFor(() => expect(rendered.html()).toContain('Payment panel'))
      expect(rendered.html()).toContain('Indexed identity')
      expect(rendered.html()).toContain('Rulesets ready')
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
