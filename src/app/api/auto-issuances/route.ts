import { NextResponse } from 'next/server'
import { getAutoIssuances } from '@/lib/loans-queries'

export const dynamic = 'force-dynamic'

/** Auto-issuance candidates for the Owners tab's Auto Issuance subtab, on one
 *  chain (auto-issuances and their Distribute tx are per-chain). */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const projectId = Number(searchParams.get('projectId'))
  const chainId = Number(searchParams.get('chainId'))

  if (
    !Number.isInteger(projectId) ||
    projectId <= 0 ||
    !Number.isInteger(chainId) ||
    chainId <= 0
  ) {
    return NextResponse.json(
      { error: 'projectId and chainId required' },
      { status: 400 },
    )
  }

  try {
    return NextResponse.json(await getAutoIssuances(projectId, chainId))
  } catch {
    return NextResponse.json({ stored: [], issued: [] }, { status: 502 })
  }
}
