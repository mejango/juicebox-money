import { NextResponse } from 'next/server'
import { parseChainProject } from '@/lib/api-params'
import { getLoans } from '@/lib/loans-queries'

export const dynamic = 'force-dynamic'

/** Loan history for the Owners tab's Loans subtab (both "Your loans" and "All
 *  loans" read this — the caller filters by owner for the connected view). */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const { chainId, projectId, ok } = parseChainProject(searchParams)

  if (!ok) {
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
