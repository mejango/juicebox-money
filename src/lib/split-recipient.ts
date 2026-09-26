import { zeroAddress, type Address } from 'viem'
import type { DraftSplit } from '@/components/create/SplitsEditor'
import { resolvedAddress } from '@/lib/ens'
import { requireLpSplitHook } from '@/lib/launch'
import { requireStickyDistributor, stickyDraftGroupId } from '@/lib/sticky'

/** A split's on-chain recipient fields: everything but its percent. */
export type SplitRecipientFields = {
  projectId: bigint
  beneficiary: Address
  preferAddToBalance: boolean
  lockedUntil: number
  hook: Address
}

/**
 * The recipient tail of a split row on one chain: an address (per-chain
 * override, then the default; ENS already resolved into the sync cache), a
 * project id plus token beneficiary, a split hook, or Sticky holders. Assumes
 * the row passed `splitOk`, so every referenced address resolves.
 */
export function draftSplitRecipient(
  row: DraftSplit,
  chainId: number,
): SplitRecipientFields {
  const override = row.perChain[chainId]?.trim() || ''
  const lockedUntil = row.lockedUntil
    ? Math.floor(new Date(row.lockedUntil).getTime() / 1000)
    : 0
  if (row.kind === 'sticky') {
    return {
      projectId: stickyDraftGroupId(row),
      beneficiary: resolvedAddress(row.beneficiary)!,
      preferAddToBalance: false,
      lockedUntil,
      hook: requireStickyDistributor(chainId),
    }
  }
  if (row.kind === 'hook') {
    const optionalId = row.projectId.trim().replace('#', '')
    return {
      projectId: optionalId ? BigInt(optionalId) : 0n,
      beneficiary: resolvedAddress(row.beneficiary) ?? zeroAddress,
      preferAddToBalance: false,
      lockedUntil,
      hook:
        row.hookKind === 'fundmarket'
          ? requireLpSplitHook(chainId)
          : resolvedAddress(row.hookAddress)!,
    }
  }
  if (row.kind === 'project') {
    const id = (override || row.projectId).trim().replace('#', '')
    const beneficiary =
      row.perChainBeneficiary[chainId]?.trim() || row.beneficiary
    return {
      projectId: BigInt(id),
      beneficiary: row.preferAddToBalance
        ? (resolvedAddress(beneficiary) ?? zeroAddress)
        : resolvedAddress(beneficiary)!,
      preferAddToBalance: row.preferAddToBalance,
      lockedUntil,
      hook: zeroAddress,
    }
  }
  return {
    projectId: 0n,
    beneficiary: resolvedAddress(override || row.recipient)!,
    preferAddToBalance: false,
    lockedUntil,
    hook: zeroAddress,
  }
}
