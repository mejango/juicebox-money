import { NextResponse } from 'next/server'
import { getBridgeMovements } from '@/lib/suckers-queries'

export const dynamic = 'force-dynamic'

/** Queued cross-chain movements for the Settlement section's movements table. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const suckerGroupId = searchParams.get('suckerGroupId') ?? undefined
  const chainId = Number(searchParams.get('chainId'))
  const projectId = Number(searchParams.get('projectId'))

  try {
    if (suckerGroupId) {
      return NextResponse.json({ items: await getBridgeMovements({ suckerGroupId }) })
    }
    if (
      Number.isInteger(chainId) &&
      chainId > 0 &&
      Number.isInteger(projectId) &&
      projectId > 0
    ) {
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
