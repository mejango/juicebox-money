'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useProjectNftProtocol } from '@/hooks/useProjectNftProtocol'

/** Native flavor follows the same verified SDK identity used by payment guards. */
export function ProjectFlavor({ chainId, projectId, isRevnet }: { chainId: JBChainId; projectId: number; isRevnet: boolean }) {
  const identity = useProjectNftProtocol(chainId, projectId, isRevnet)
  if (isRevnet) return <>Revnet</>
  if (identity.isSuccess) return <>{identity.data?.protocol === 'defifa' ? 'Defifa' : 'Project'}</>
  if (identity.isError) return <button type="button" className="underline" onClick={() => void identity.refetch()}>Unavailable · Retry</button>
  return <span role="status">Checking…</span>
}
