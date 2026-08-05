import { NextRequest, NextResponse } from 'next/server'
import { parseChainProject } from '@/lib/api-params'
import { getProjectPageData } from '@/lib/project-fallback'

/** Resolve a project id to its name (for the create flow's split rows). */
export async function GET(req: NextRequest) {
  const { chainId, projectId, ok } = parseChainProject(req.nextUrl.searchParams, {
    anyChainId: true,
  })
  if (!ok) {
    return NextResponse.json({ error: 'Bad params' }, { status: 400 })
  }
  try {
    // A project can be newer than the indexer, temporarily unavailable from
    // it, or simply have no indexed name. The onchain-backed page resolver
    // distinguishes all three from an actually missing project.
    const result = await getProjectPageData(chainId, projectId)
    return NextResponse.json({
      found: result !== null,
      name: result?.project.name ?? null,
      suckerGroupId: result?.project.suckerGroupId ?? null,
    })
  } catch {
    return NextResponse.json({ found: false, name: null, suckerGroupId: null })
  }
}
