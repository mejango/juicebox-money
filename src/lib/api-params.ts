/**
 * Shared query-param guard for the chain/project API routes. `ok` is true
 * when both ids are positive integers (`anyChainId` relaxes the chain id to
 * any integer — project-name's historical guard). Callers keep their own
 * error responses.
 */
export function parseChainProject(
  searchParams: URLSearchParams,
  { anyChainId = false }: { anyChainId?: boolean } = {},
): { chainId: number; projectId: number; ok: boolean } {
  const chainId = Number(searchParams.get('chainId'))
  const projectId = Number(searchParams.get('projectId'))
  const ok =
    Number.isInteger(chainId) &&
    (anyChainId || chainId > 0) &&
    Number.isInteger(projectId) &&
    projectId > 0
  return { chainId, projectId, ok }
}
