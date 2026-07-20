import type { Address } from 'viem'

/** A live split as returned by JBSplits.splitsOf. */
export type RawSplit = {
  percent: number
  projectId: bigint
  beneficiary: Address
  preferAddToBalance: boolean
  lockedUntil: number
  hook: Address
}
