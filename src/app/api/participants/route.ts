import { NextResponse } from 'next/server'
import { publicReadHeaders } from '@/lib/api-cache'
import { parseChainProject } from '@/lib/api-params'
import { getParticipants, getParticipantsForRefs } from '@/lib/bendystraw'

export const dynamic = 'force-dynamic'

/** `refs=1:5,8453:9` → the deployments to union. Malformed entries are dropped. */
function parseRefs(value: string | null): { chainId: number; projectId: number }[] {
  if (!value) return []
  return value
    .split(',')
    .map(entry => entry.split(':').map(Number))
    .filter(
      ([chainId, projectId]) =>
        Number.isInteger(chainId) &&
        chainId > 0 &&
        Number.isInteger(projectId) &&
        projectId > 0,
    )
    .map(([chainId, projectId]) => ({ chainId, projectId }))
}

/** Holder-distribution data for the Owners/Tokens tab's ALL card. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const suckerGroupId = searchParams.get('suckerGroupId')
  const refs = parseRefs(searchParams.get('refs'))
  const { chainId, projectId, ok } = parseChainProject(searchParams)

  try {
    // Per-chain union first: a group-keyed read silently drops every holder stamped
    // with a group id that a sucker-group extension superseded.
    if (refs.length) {
      return NextResponse.json(
        await getParticipantsForRefs(refs, suckerGroupId),
        { headers: publicReadHeaders },
      )
    }
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
      { error: 'refs, suckerGroupId, or chainId + projectId required' },
      { status: 400 },
    )
  } catch {
    return NextResponse.json({ items: [], totalCount: 0 }, { status: 502 })
  }
}
