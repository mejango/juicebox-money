import { NextResponse } from 'next/server'
import { parseChainProject } from '@/lib/api-params'
import { getParticipants } from '@/lib/bendystraw'

export const dynamic = 'force-dynamic'

/** Holder-distribution data for the Owners/Tokens tab's ALL card. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const suckerGroupId = searchParams.get('suckerGroupId')
  const { chainId, projectId, ok } = parseChainProject(searchParams)

  try {
    if (suckerGroupId) {
      return NextResponse.json(await getParticipants({ suckerGroupId }))
    }
    if (ok) {
      return NextResponse.json(await getParticipants({ chainId, projectId }))
    }
    return NextResponse.json(
      { error: 'suckerGroupId or chainId + projectId required' },
      { status: 400 },
    )
  } catch {
    return NextResponse.json({ items: [], totalCount: 0 }, { status: 502 })
  }
}
