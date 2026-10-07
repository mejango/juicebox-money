import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { BsProject } from '@/lib/bendystraw'

const capture = vi.hoisted(() => ({ treasury: vi.fn(), overview: vi.fn(), extras: vi.fn(), backOffice: vi.fn() }))
vi.mock('@/components/TreasuryCard', () => ({ TreasuryCard: (props: unknown) => { capture.treasury(props); return null } }))
vi.mock('@/components/project/OverviewTab', () => ({ OverviewTab: (props: unknown) => { capture.overview(props); return null } }))
vi.mock('@/components/project/LazyProjectTabs', () => ({
  ExtrasTab: (props: unknown) => { capture.extras(props); return null },
  BackOfficeTab: (props: unknown) => { capture.backOffice(props); return null },
}))
vi.mock('@/components/ProjectLogoWithFallback', () => ({ ProjectLogoWithFallback: () => null }))
vi.mock('@/components/ProjectLink', () => ({ ProjectLink: () => null }))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))
vi.mock('@/components/ui/AddressLink', () => ({ AddressLink: () => null }))
vi.mock('@/components/project/ProjectStats', () => ({ ProjectStats: () => null }))

import { ProjectTreasury, ProjectOverview, ProjectExtras, ProjectBackOffice, ProjectHeader } from '@/app/[urn]/ProjectMetadataSections'
const project = { chainId: 1, projectId: 7, name: 'Indexed name', projectTagline: 'Indexed tagline', logoUri: null, suckerGroupId: null } as BsProject
const base = { project, chainId: 1 as const, projectId: 7, isRevnet: false, chains: [[1, 7]] as [number, number][] }
const metadata = { name: ' Current name ', projectTagline: ' Current tagline ', description: '<p>One &amp; two</p><p>Three</p>', payDisclosure: 'Read this before paying', infoUri: 'example.com', twitter: '@juicebox', discord: 'javascript:alert(1)' }

describe('project metadata section extraction', () => {
  it('preserves current metadata, safe description/links and required disclosure in each owning section', async () => {
    renderToStaticMarkup(await ProjectTreasury({ ...base, metadata }))
    expect(capture.treasury).toHaveBeenLastCalledWith(expect.objectContaining({ projectName: 'Current name', payDisclosure: metadata.payDisclosure }))
    renderToStaticMarkup(await ProjectOverview({ ...base, metadata, authority: null, authorities: [], suckerGroupId: null }))
    expect(capture.overview).toHaveBeenLastCalledWith(expect.objectContaining({ description: metadata.description, descriptionFallback: ['One & two', 'Three'], socialLinks: [['Website', 'https://example.com/'], ['X', 'https://x.com/juicebox'], ['Discord', null], ['Telegram', null], ['WhatsApp', null], ['Instagram', null]] }))
    renderToStaticMarkup(await ProjectExtras({ ...base, metadata, authorities: [] }))
    expect(capture.extras).toHaveBeenLastCalledWith(expect.objectContaining({ profile: expect.objectContaining({ name: metadata.name, tagline: metadata.projectTagline, payNotice: metadata.payDisclosure }) }))
    renderToStaticMarkup(await ProjectBackOffice({ ...base, metadata, deployments: [], owner: null, operator: null }))
    expect(capture.backOffice).toHaveBeenLastCalledWith(expect.objectContaining({ profile: expect.objectContaining({ name: metadata.name, description: metadata.description, payDisclosure: metadata.payDisclosure }) }))
  })

  it('preserves indexed display fallback when metadata is unavailable and safely escapes structured identity', async () => {
    renderToStaticMarkup(await ProjectTreasury({ ...base, metadata: null }))
    expect(capture.treasury).toHaveBeenLastCalledWith(expect.objectContaining({ projectName: 'Indexed name', payDisclosure: undefined }))
    const urn = { chainId: 1, projectId: 7, handle: null, verifiedAuthority: null, verifiedIsRevnet: null } as ComponentProps<typeof ProjectHeader>['urn']
    const html = renderToStaticMarkup(await ProjectHeader({ project, metadata: { name: '</script>Current' }, urn, chains: [project], chainPairs: [[1, 7]], isRevnet: false, authority: null, totalRaisedUsd: '0', paymentsCount: 0 }))
    expect(html).toContain('\\u003c/script>Current')
    expect(html).not.toContain('"name":"</script>')
    expect(html).toContain('&lt;/script&gt;Current')
  })
})
