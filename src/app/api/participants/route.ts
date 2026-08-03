import { NextResponse } from 'next/server'
import { publicReadHeaders } from '@/lib/api-cache'
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
      // chainId (when sent) is only an endpoint-routing hint — testnet
      // sucker groups live on the testnet indexer.
      return NextResponse.json(
        await getParticipants({
          suckerGroupId,
          chainId: Number.isInteger(chainId) && chainId > 0 ? chainId : undefined,
        }),
      )
    }
    if (ok) {
      return NextResponse.json(await getParticipants({ chainId, projectId }), {
        headers: publicReadHeaders,
      })
    }
    return NextResponse.json(
      { error: 'suckerGroupId or chainId + projectId required' },
      { status: 400 },
    )
  } catch {
    return NextResponse.json({ items: [], totalCount: 0 }, { status: 502 })
  }
}
