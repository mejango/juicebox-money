import { notFound, redirect } from 'next/navigation'
import { decodeProjectRouteSegment } from '@/lib/project-handle-route'
import { legacyHref, legacyPageExists, parseUrn } from '@/lib/urn'

/**
 * Only `<chain>:<id>` and `@handle` can name a project. The proxy skips paths with a dot
 * (`/learn.md`, `/llms-full.txt`), and the page streams under loading.tsx, so its notFound()
 * arrives after a 200. This layout renders above that boundary and decides before any byte
 * is sent, which gives those paths the same real 404 or legacy redirect the proxy gives the rest.
 */
export default async function ProjectRouteLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ urn: string }>
}) {
  const { urn } = await params
  const segment = decodeProjectRouteSegment(urn)
  if (!segment || (!segment.trim().startsWith('@') && !parseUrn(segment))) {
    const legacy = legacyHref(`/${urn}`)
    if (await legacyPageExists(legacy)) redirect(legacy)
    notFound()
  }
  return children
}
