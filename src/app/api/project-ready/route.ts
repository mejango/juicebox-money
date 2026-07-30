import { NextRequest, NextResponse } from 'next/server'
import { parseChainProject } from '@/lib/api-params'
import { bendystraw } from '@/lib/bendystraw'

export const dynamic = 'force-dynamic'

/**
 * Has bendystraw indexed a freshly launched project yet? Same lookup as
 * getProject but uncached (revalidate 0) — the create flow polls this every
 * 5s, and caching the pre-index null would stall the "it's live" flip.
 */
export async function GET(req: NextRequest) {
  const { chainId, projectId, ok } = parseChainProject(req.nextUrl.searchParams)
  if (!ok) {
    return NextResponse.json({ found: false }, { status: 400 })
  }

  try {
    const data = await bendystraw<{ project: { projectId: number } | null }>(
      `query($chainId: Float!, $projectId: Float!) {
        project(chainId: $chainId, projectId: $projectId, version: 6) { projectId }
      }`,
      { chainId, projectId },
      { policy: 'live' },
    )
    return NextResponse.json({ found: !!data.project })
  } catch {
    return NextResponse.json({ found: false })
  }
}
