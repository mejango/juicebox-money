import { NextResponse } from 'next/server'
import { publicReadHeaders } from '@/lib/api-cache'
import { parseChainProject } from '@/lib/api-params'
import { getAutoIssuances } from '@/lib/loans-queries'

export const dynamic = 'force-dynamic'

/** Auto-issuance candidates for the Owners tab's Auto Issuance subtab, on one
 *  chain (auto-issuances and their Distribute tx are per-chain). */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const { chainId, projectId, ok } = parseChainProject(searchParams)

  if (!ok) {
    return NextResponse.json(
      { error: 'projectId and chainId required' },
      { status: 400 },
    )
  }

  try {
    return NextResponse.json(await getAutoIssuances(projectId, chainId), {
      headers: publicReadHeaders,
    })
  } catch {
    return NextResponse.json({ stored: [], issued: [] }, { status: 502 })
  }
}
