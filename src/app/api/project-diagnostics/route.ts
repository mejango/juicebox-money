import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import { isAddress, type Address } from 'viem'
import { parseChainProject } from '@/lib/api-params'
import { readProjectDiagnostics } from '@/lib/project-diagnostics'

export const dynamic = 'force-dynamic'

/** Explicitly requested, uncached, read-only diagnostics for the selected deployment. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const { chainId, projectId, ok } = parseChainProject(params)
  const headers = { 'Cache-Control': 'no-store' }
  if (!ok || !Number.isSafeInteger(projectId) || !JB_CHAINS[chainId as JBChainId]) {
    return Response.json({ error: 'A supported chain and valid project ID are required.' }, { status: 400, headers })
  }
  if (params.get('version') !== '6') {
    return Response.json({ error: 'This deployment checker supports Juicebox V6 projects.' }, { status: 400, headers })
  }
  const operator = params.get('operator') || undefined
  if (operator && !isAddress(operator)) {
    return Response.json({ error: 'The operator address is invalid.' }, { status: 400, headers })
  }
  try {
    return Response.json(await readProjectDiagnostics(chainId as JBChainId, projectId, operator as Address | undefined), { headers })
  } catch {
    return Response.json({ error: 'Deployment checks are unavailable. Retry shortly.' }, { status: 502, headers })
  }
}
