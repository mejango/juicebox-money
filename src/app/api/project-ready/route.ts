import { NextRequest, NextResponse } from 'next/server'
import { bendystraw } from '@/lib/bendystraw'

export const dynamic = 'force-dynamic'

/**
 * Has bendystraw indexed a freshly launched project yet? Same lookup as
 * getProject but uncached (revalidate 0) — the create flow polls this every
 * 5s, and caching the pre-index null would stall the "it's live" flip.
 */
export async function GET(req: NextRequest) {
  const chainId = Number(req.nextUrl.searchParams.get('chainId'))
  const projectId = Number(req.nextUrl.searchParams.get('projectId'))
  if (
    !Number.isInteger(chainId) ||
    !Number.isInteger(projectId) ||
    chainId <= 0 ||
    projectId <= 0
  ) {
    return NextResponse.json({ found: false }, { status: 400 })
  }

  try {
    const data = await bendystraw<{ project: { projectId: number } | null }>(
      `query($chainId: Float!, $projectId: Float!) {
        project(chainId: $chainId, projectId: $projectId, version: 6) { projectId }
      }`,
      { chainId, projectId },
      { revalidate: 0 },
    )
    return NextResponse.json({ found: !!data.project })
  } catch {
    return NextResponse.json({ found: false })
  }
}
