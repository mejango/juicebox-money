import { NextResponse } from 'next/server'
import { getLoans } from '@/lib/loans-queries'

export const dynamic = 'force-dynamic'

/** Loan history for the Owners tab's Loans subtab (both "Your loans" and "All
 *  loans" read this — the caller filters by owner for the connected view). */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const projectId = Number(searchParams.get('projectId'))
  const chainIds = (searchParams.get('chainIds') ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0)

  if (!Number.isInteger(projectId) || projectId <= 0 || chainIds.length === 0) {
    return NextResponse.json(
      { error: 'projectId and chainIds required' },
      { status: 400 },
    )
  }

  try {
    return NextResponse.json(await getLoans(projectId, chainIds))
  } catch {
    return NextResponse.json({ items: [], totalCount: 0 }, { status: 502 })
  }
}
