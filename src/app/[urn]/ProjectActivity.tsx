import type { JBChainId } from '@bananapus/nana-sdk-core'
import { ActivityList } from '@/components/ActivityList'
import { ProjectDataStatus, type Deployment } from '@/components/project/ProjectDataStatus'
import { getProjectActivityDisplay } from '@/lib/project-server-data'

/** Activity failure must not hold up project identity, tabs or payment controls. */
export async function ProjectActivity({
  chainId,
  projectId,
  suckerGroupId,
  accountingToken,
  isRevnet,
  deployments,
}: {
  chainId: JBChainId
  projectId: number
  suckerGroupId: string | null
  accountingToken: { symbol: string; decimals: number } | null
  isRevnet: boolean
  deployments: Deployment[]
}) {
  const result = await getProjectActivityDisplay(chainId, projectId, suckerGroupId)
    .catch(() => null)
  return (
    <>
      {!result ? <ProjectDataStatus deployments={deployments} notice="partial" /> : null}
      <ActivityList
        events={result?.value.items ?? []}
        total={result?.value.totalCount ?? 0}
        error={!result}
        initialEventsUpdatedAt={result?.updatedAt}
        chainId={chainId}
        projectId={projectId}
        suckerGroupId={suckerGroupId}
        accountingToken={accountingToken}
        isRevnet={isRevnet}
      />
    </>
  )
}
