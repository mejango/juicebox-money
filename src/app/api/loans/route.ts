import { NextResponse } from 'next/server'
import { getLoans } from '@/lib/loans-queries'

export const dynamic = 'force-dynamic'

/** Loan history for the Owners tab's Loans subtab (both "Your loans" and "All
 *  loans" read this — the caller filters by owner for the connected view). */
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
      { error: 'chainId and projectId required' },
      { status: 400 },
    )
  }

  try {
    return NextResponse.json(await getLoans(projectId, chainId))
  } catch {
    return NextResponse.json({ items: [], totalCount: 0 }, { status: 502 })
  }
}
