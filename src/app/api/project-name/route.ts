import { NextRequest, NextResponse } from 'next/server'
import { parseChainProject } from '@/lib/api-params'
import { getProject } from '@/lib/bendystraw'

/** Resolve a project id to its name (for the create flow's split rows). */
export async function GET(req: NextRequest) {
  const { chainId, projectId, ok } = parseChainProject(req.nextUrl.searchParams, {
    anyChainId: true,
  })
  if (!ok) {
    return NextResponse.json({ error: 'Bad params' }, { status: 400 })
  }
  try {
    const project = await getProject(chainId, projectId)
    return NextResponse.json({ name: project?.name ?? null })
  } catch {
    return NextResponse.json({ name: null })
  }
}
