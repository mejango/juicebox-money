import type { JBChainId } from '@bananapus/nana-sdk-core'
import {
  STICKY_CRITERIA_BASE,
  STICKY_DEFAULT_GROUP_ID,
  STICKY_MAX_CRITERIA_WEEKS,
  describeStickySplit,
  isStickySplit,
  stickyDistributorAddress,
  stickyGroupId,
  validateStickyGroupId,
} from '@bananapus/nana-sdk-core/v6'
import type { Address } from 'viem'
import { truncateAddress } from '@/lib/format'
import { chainName } from '@/lib/urn'

/**
 * A Sticky split pays the holders of a Sticky project's token. Its hook is the
 * chain's StickyDistributor, its beneficiary is the Sticky token, and its
 * projectId is the reward group: 0 for every holder by voting power, or a
 * tenure group of holders stuck a range of weeks.
 *
 * The distributor never reverts: an invalid group, or a tenure group whose
 * token the Sticky hook does not track, silently funds group 0. So the app
 * checks the token and the group on every target chain before it submits.
 */

export { STICKY_MAX_CRITERIA_WEEKS }

/**
 * Without an ERC-20 the controller hands the distributor credits it can't
 * pull, so reserved tokens sent to Sticky holders would be stuck there.
 */
export const STICKY_RESERVED_NEEDS_ERC20 =
  'Sticky holders can get reserved tokens only once this project has an ERC-20. A new project has none at launch, so add this split after you create the ERC-20.'

/** The edit-time version: the project exists, but has no ERC-20 on this chain yet. */
export function stickyNoErc20Reason(chainId: number): string {
  return `This project has no ERC-20 on ${chainName(chainId)} yet, so Sticky holders can't get its reserved tokens. Create the ERC-20 first.`
}

/** Whether `hook` is the StickyDistributor on `chainId` (false where Sticky is not deployed). */
export function isStickyHook(hook: string, chainId: number): boolean {
  try {
    return isStickySplit({ hook: hook as Address }, chainId as JBChainId)
  } catch {
    return false
  }
}

/** The chains in `chainIds` with no StickyDistributor, where Sticky splits can't be encoded. */
export function chainsWithoutSticky(chainIds: readonly number[]): number[] {
  return chainIds.filter(chainId => {
    try {
      stickyDistributorAddress(chainId as JBChainId)
      return false
    } catch {
      return true
    }
  })
}

/** The StickyDistributor to encode on `chainId`, throwing where Sticky is not deployed. */
export function requireStickyDistributor(chainId: number): Address {
  try {
    return stickyDistributorAddress(chainId as JBChainId)
  } catch {
    throw new Error(`Sticky is not deployed on ${chainName(chainId)}.`)
  }
}

/** The editable group fields of a Sticky split row. */
export type StickyGroupDraft = {
  stickyGroup: 'all' | 'tenure'
  stickyMinWeeks: string
  stickyMaxWeeks: string
}

const WHOLE = /^\d{1,3}$/

/** Why the group fields can't be encoded, or null when they can. */
export function stickyGroupDraftError(draft: StickyGroupDraft): string | null {
  if (draft.stickyGroup === 'all') return null
  const min = draft.stickyMinWeeks.trim()
  const max = draft.stickyMaxWeeks.trim()
  if (!WHOLE.test(min)) return 'Enter the minimum weeks'
  if (max !== '' && !WHOLE.test(max)) return 'Enter whole weeks'
  // Checked before encoding: a larger maximum would carry into the minimum.
  if (max !== '' && Number(max) > STICKY_MAX_CRITERIA_WEEKS) {
    return `Maximum weeks can't be more than ${STICKY_MAX_CRITERIA_WEEKS}.`
  }
  return validateStickyGroupId(
    BigInt(min) * STICKY_CRITERIA_BASE + (max === '' ? 0n : BigInt(max)),
  )
}

/** The split `projectId` the group fields encode. Assumes `stickyGroupDraftError` passed. */
export function stickyDraftGroupId(draft: StickyGroupDraft): bigint {
  if (draft.stickyGroup === 'all') return STICKY_DEFAULT_GROUP_ID
  const max = draft.stickyMaxWeeks.trim()
  return stickyGroupId({
    minWeeks: Number(draft.stickyMinWeeks.trim()),
    maxWeeks: max === '' ? 0 : Number(max),
  })
}

/** The group fields for an encoded group ID (an invalid ID reads as group 0, where it pays). */
export function stickyGroupDraft(groupId: bigint): StickyGroupDraft {
  if (groupId === STICKY_DEFAULT_GROUP_ID || validateStickyGroupId(groupId)) {
    return { stickyGroup: 'all', stickyMinWeeks: '', stickyMaxWeeks: '' }
  }
  const max = groupId % STICKY_CRITERIA_BASE
  return {
    stickyGroup: 'tenure',
    stickyMinWeeks: String(groupId / STICKY_CRITERIA_BASE),
    stickyMaxWeeks: max === 0n ? '' : String(max),
  }
}

/** "Sticky holders stuck 4 to 52 weeks → STICKY"; the token address stands in for a missing symbol. */
export function stickyRecipientLabel(
  split: { projectId: bigint; beneficiary: string },
  symbol?: string | null,
): string {
  return `${describeStickySplit({ projectId: split.projectId })} → ${
    symbol ? symbol : truncateAddress(split.beneficiary)
  }`
}
