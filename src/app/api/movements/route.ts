import { NextResponse } from 'next/server'
import { parseChainProject } from '@/lib/api-params'
import { getBridgeMovements } from '@/lib/suckers-queries'

export const dynamic = 'force-dynamic'

/** Queued cross-chain movements for the Settlement section's movements table. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const suckerGroupId = searchParams.get('suckerGroupId') ?? undefined
  const { chainId, projectId, ok } = parseChainProject(searchParams)

  try {
    if (suckerGroupId) {
      // chainId (when sent) is only an endpoint-routing hint — testnet
      // sucker groups live on the testnet indexer.
      return NextResponse.json({
        items: await getBridgeMovements({
          suckerGroupId,
          chainId: Number.isInteger(chainId) && chainId > 0 ? chainId : undefined,
        }),
      })
    }
    if (ok) {
      return NextResponse.json({
        items: await getBridgeMovements({ chainId, projectId }),
      })
    }
    return NextResponse.json(
      { error: 'suckerGroupId or chainId + projectId required' },
      { status: 400 },
    )
  } catch {
    return NextResponse.json({ items: [] }, { status: 502 })
  }
}
