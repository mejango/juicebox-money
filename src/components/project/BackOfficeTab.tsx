'use client'

import { type JBChainId } from '@bananapus/nana-sdk-core'
import { usePreloadTransactionAnimation } from '@/components/TransactionInProgress'
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

/**
 * The back-office cards on the Owner/Operator tab: who controls the project
 * across every deployment, the chain-aware metadata editor, owner/operator
 * powers, and the buyback-router controls. Every write follows the same
 * pattern as FundsTab: review freezes the exact args from LIVE re-reads, the
 * connected account is re-checked at confirm, and the signed call goes
 * through useSafeTx (simulate-first).
 */
export function BackOfficeTab({
  chainId,
  projectId,
  isRevnet,
  deployments,
  revnetOperatorCandidates,
  profile,
}: {
  chainId: JBChainId
  projectId: number
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
  usePreloadTransactionAnimation()
  const currentDeployment = deployments.find(
    deployment =>
      deployment.chainId === chainId && deployment.projectId === projectId,
  )
  return (
    <div className="space-y-5">
      <AuthorityOverview
        deployments={deployments}
        isRevnet={isRevnet}
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
              deployments={deployments}
              isRevnet={isRevnet}
              profile={profile}
            />
            {!isRevnet ? (
              <AuthorityPowersCard deployments={deployments} />
            ) : null}
            <MultiChainBuybackRouterCard
              deployments={deployments}
              isRevnet={isRevnet}
            />
          </>
        }
      />
    </div>
  )
}
