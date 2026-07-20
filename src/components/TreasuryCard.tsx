'use client'

import { type JBChainId } from '@bananapus/nana-sdk-core'
import { PayPanel } from '@/components/project/PayPanel'

/**
 * The project page's pay card — put funds in. Cashing out lives in the
 * Owners → You card (per-chain, alongside the holder's other actions), so
 * this card is pay-only.
 */
export function TreasuryCard({
  chainId,
  projectId,
  projectName,
  isRevnet,
  chains,
  payDisclosure,
}: {
  chainId: JBChainId
  projectId: number
  projectName: string
  isRevnet: boolean
  /** [chainId, projectId] pairs across the sucker group (chain selector). */
  chains: [number, number][]
  /** The project's payment notice, shown before paying. */
  payDisclosure?: string
}) {
  return (
    <div
      id="project-pay-card"
      className="rounded-xl border-2 border-bluebs-500 bg-white p-6 shadow-[0_4px_20px_-4px_rgba(87,119,235,0.25)] ring-4 ring-bluebs-500/10"
    >
      <PayPanel
        chainId={chainId}
        projectId={projectId}
        projectName={projectName}
        isRevnet={isRevnet}
        chains={chains}
        payDisclosure={payDisclosure}
      />
    </div>
  )
}
