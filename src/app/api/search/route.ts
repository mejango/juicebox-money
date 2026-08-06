import { NextRequest, NextResponse } from 'next/server'
import { getSuckerGroupProjects, searchProjects } from '@/lib/bendystraw'

/**
 * Free-text project search, proxied server-side so the bendystraw endpoint and
 * query shape stay in one auditable place. Returns a trimmed payload.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  const normalizedQ = q.replace(/^\$/, '')
  if (normalizedQ.length < 1 || q.length > 64) {
    return NextResponse.json({ projects: [] })
  }
  try {
    const all = await searchProjects(q)
    // One result per omnichain project (highest-volume member represents it).
    const byGroup = new Map<
      string,
      { representative: (typeof all)[number]; members: typeof all }
    >()
    for (const p of all) {
      const key = p.suckerGroupId ?? `${p.chainId}-${p.projectId}`
      const existing = byGroup.get(key)
      if (!existing) {
        byGroup.set(key, { representative: p, members: [p] })
      } else {
        existing.members.push(p)
        if (BigInt(p.volume) > BigInt(existing.representative.volume)) {
          existing.representative = p
        }
      }
    }
    const projects = await Promise.all(
      Array.from(byGroup.values()).map(async group => ({
        ...group,
        members: group.representative.suckerGroupId
          ? await getSuckerGroupProjects(
              group.representative.suckerGroupId,
            )
              .then(members =>
                members.map(member => ({
                  ...member,
                  searchTicker: null,
                })),
              )
              .catch(() => group.members)
          : group.members,
      })),
    )
    return NextResponse.json({
      projects: projects.map(({ representative: p, members }) => ({
        projectId: p.projectId,
        chainId: p.chainId,
        name: p.name,
        logoUri: p.logoUri,
        projectTagline: p.projectTagline,
        ticker:
          p.searchTicker ??
          members.find(member => member.searchTicker)?.searchTicker ??
          null,
        chainIds: Array.from(new Set(members.map(member => member.chainId))),
      })),
    })
  } catch {
    // An indexer outage is not "no results". Returning 200 with an empty list tells the user
    // their search matched nothing, which is indistinguishable from the project not existing.
    return NextResponse.json(
      { projects: [], error: 'Search is unavailable right now.' },
      { status: 503 },
    )
  }
}
