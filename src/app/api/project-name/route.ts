import { NextRequest, NextResponse } from 'next/server'
import { getProject } from '@/lib/bendystraw'

/** Resolve a project id to its name (for the create flow's split rows). */
export async function GET(req: NextRequest) {
  const chainId = Number(req.nextUrl.searchParams.get('chainId'))
  const projectId = Number(req.nextUrl.searchParams.get('projectId'))
  if (
    !Number.isInteger(chainId) ||
    !Number.isInteger(projectId) ||
    projectId < 1
  ) {
    return NextResponse.json({ error: 'Bad params' }, { status: 400 })
  }
  try {
    const project = await getProject(chainId, projectId)
    return NextResponse.json({ name: project?.name ?? null })
  } catch {
    return NextResponse.json({ name: null })
  }
}
