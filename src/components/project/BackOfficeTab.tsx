'use client'

import { type JBChainId } from '@bananapus/nana-sdk-core'
import {
  AuthorityOverview,
  type AuthorityDeployment,
} from '@/components/project/AuthorityOverview'
import {
  AuthorityEditsCard,
  type AuthorityEditProfile,
} from '@/components/project/AuthorityEditsCard'
import { MultiChainBuybackRouterCard } from '@/components/project/MultiChainBuybackRouterCard'
import { AuthorityPowersCard } from '@/components/project/AuthorityPowersCard'
import { ProjectHandleCard } from '@/components/project/ProjectHandleCard'
import { SafeBatchTray } from '@/components/project/SafeBatchTray'
import { useLinkedDeployments } from '@/lib/sucker-group'

/**
 * The back-office cards on the Owner/Operator tab: who controls the project
 * across every deployment, the chain-aware metadata editor, owner/operator
 * powers, and the buyback-router controls. Every write follows the same
 * pattern as FundsTab: review freezes the exact args from LIVE re-reads, the
 * connected account is re-checked at confirm, and the signed call goes
 * through useReviewedAction (simulate-first).
 */
export function BackOfficeTab({
  chainId,
  projectId,
  isRevnet,
  deployments,
  revnetOperatorCandidates,
  suckerGroupId,
  profile,
}: {
  chainId: JBChainId
  projectId: number
  suckerGroupId?: string | null
  isRevnet: boolean
  /** Owner per bendystraw (custom projects); can lag a transfer. */
  owner: string | null
  /** Operator per bendystraw (revnets). */
  operator: string | null
  /** Every omnichain deployment and its indexed owner/operator. */
  deployments: AuthorityDeployment[]
  /** Indexed candidates; the handle editor live-verifies all of them. */
  revnetOperatorCandidates?: readonly `0x${string}`[]
  /** Current pinned profile used to prefill the chain-aware metadata editor. */
  profile: AuthorityEditProfile
}) {
  // Every card here writes to each listed deployment: only the ones the onchain registry links.
  const { deployments: linked, line } = useLinkedDeployments([chainId, projectId], deployments)
  const currentDeployment = linked.find(
    deployment =>
      deployment.chainId === chainId && deployment.projectId === projectId,
  )
  return (
    <div className="space-y-5">
      {line ? <p role="alert" className="text-xs text-error-500">{line}</p> : null}
      <AuthorityOverview
        deployments={linked}
        isRevnet={isRevnet}
        afterAccount={<SafeBatchTray chainId={chainId} />}
        beforePermissions={
          <>
            {currentDeployment ? (
              <ProjectHandleCard
                deployment={currentDeployment}
                isRevnet={isRevnet}
                revnetOperatorCandidates={revnetOperatorCandidates}
              />
            ) : null}
            <AuthorityEditsCard
              deployments={linked}
              isRevnet={isRevnet}
              profile={profile}
              suckerGroupId={suckerGroupId}
            />
            {!isRevnet ? (
              <AuthorityPowersCard deployments={linked} />
            ) : null}
            <MultiChainBuybackRouterCard
              deployments={linked}
              isRevnet={isRevnet}
            />
          </>
        }
      />
    </div>
  )
}
