import type { MetadataRoute } from 'next'
import { getHomepageBalanceGroups } from '@/lib/top-projects'
import { toUrn } from '@/lib/urn'

// Project pages are reached through client-side search and links, so a crawler has
// no path to them. The sitemap is that path.
export const revalidate = 3600

const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'
const STATIC_PATHS = ['/', '/learn', '/build', '/create', '/audit']

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = STATIC_PATHS.map(path => ({
    url: new URL(path, siteOrigin).href,
    changeFrequency: path === '/' ? 'daily' : 'monthly',
    priority: path === '/' ? 1 : 0.6,
  }))

  // Every V6 sucker group, not just the treasury-ranked ones the homepage shows: a
  // project denominated in something other than ETH or USDC still deserves indexing.
  // An indexer outage must not 500 the sitemap — the static routes still index.
  const groups = await getHomepageBalanceGroups().catch(() => [])
  const seen = new Set<string>()
  for (const group of groups) {
    // One entry per sucker group. The same project on four chains renders four
    // near-identical pages; listing them all would be asking for a duplicate-content
    // penalty. The named deployment is the one the rest of the site links to.
    const project =
      group.projects.items.find(item => item.name) ?? group.projects.items[0]
    if (!project) continue
    const urn = toUrn(project.chainId, project.projectId)
    if (seen.has(urn)) continue
    seen.add(urn)
    entries.push({
      url: new URL(`/${urn}`, siteOrigin).href,
      changeFrequency: 'daily',
      priority: 0.8,
    })
  }
  return entries
}
