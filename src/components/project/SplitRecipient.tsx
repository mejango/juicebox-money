import type { JBChainId } from '@bananapus/nana-sdk-core'
import Link from 'next/link'
import { zeroAddress, type Address } from 'viem'
import { AddressLink } from '@/components/ui/AddressLink'
import { toUrn } from '@/lib/urn'

/** The reserved-split sentinel that burns the tokens instead of sending them. */
const BURN_ADDRESS = '0x000000000000000000000000000000000000dead'

/** The JBSplits.splitsOf tuple shape. */
export type Split = {
  percent: number
  projectId: bigint
  beneficiary: Address
  preferAddToBalance: boolean
  lockedUntil: number
  hook: Address
}

/**
 * A split's recipient cell: the hook when one is set, a project link when the
 * split pays a project, otherwise the beneficiary address. `showBurn` renders
 * the reserved-split burn sentinel as "Burn". Pass `host` when the explorer
 * hostname is already resolved; otherwise it's looked up from `chainId`.
 */
export function SplitRecipient({
  split,
  chainId,
  host,
  showBurn = false,
}: {
  split: Pick<Split, 'projectId' | 'beneficiary' | 'hook'>
  chainId: JBChainId
  host?: string
  showBurn?: boolean
}) {
  if (split.hook !== zeroAddress) {
    return (
      <AddressLink
        address={split.hook}
        chainId={chainId}
        host={host}
        note="hook"
      />
    )
  }
  if (split.projectId > 0n) {
    return (
      <Link
        href={`/${toUrn(chainId, Number(split.projectId))}`}
        className="text-ink hover:underline"
      >
        Project #{split.projectId.toString()}
      </Link>
    )
  }
  if (showBurn && split.beneficiary.toLowerCase() === BURN_ADDRESS) {
    return <span className="text-ink">Burn</span>
  }
  return <AddressLink address={split.beneficiary} chainId={chainId} host={host} />
}
