import { NextRequest, NextResponse } from 'next/server'
import { searchProjects } from '@/lib/bendystraw'

/**
 * Free-text project search, proxied server-side so the bendystraw endpoint and
 * query shape stay in one auditable place. Returns a trimmed payload.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2 || q.length > 64) return NextResponse.json({ projects: [] })
  try {
    const all = await searchProjects(q)
    // One result per omnichain project (highest-volume member wins).
    const byGroup = new Map<string, (typeof all)[number]>()
    for (const p of all) {
      const key = p.suckerGroupId ?? `${p.chainId}-${p.projectId}`
      const existing = byGroup.get(key)
      if (!existing || BigInt(p.volume) > BigInt(existing.volume)) {
        byGroup.set(key, p)
      }
    }
    const projects = Array.from(byGroup.values())
    return NextResponse.json({
      projects: projects.map(p => ({
        projectId: p.projectId,
        chainId: p.chainId,
        name: p.name,
        logoUri: p.logoUri,
        projectTagline: p.projectTagline,
      })),
    })
  } catch {
    return NextResponse.json({ projects: [] })
  }
}
