import { encodeFunctionData, type Abi, type TransactionReceipt } from 'viem'
import type { ReviewedCall, ReviewedResult } from '@bananapus/nana-sdk-core/review'

/** A contract write, as the SDK's builders return it. */
export type TxRequest = {
  chainId: number
  address: `0x${string}`
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value?: bigint
  label?: string
}

/** Arguments a retry stamps afresh: a Safe's queued proposal that differs only in these is the same action. */
const RESTAMPED_ARGS = new Set(['deadline', 'expiration'])

/** The restamped arguments' positions in `functionName`'s inputs (a liquidity mint's deadline, a Permit2 approval's expiration). */
function restampedArgs(abi: Abi, functionName: string, count: number): number[] {
  const item = abi.find(entry => entry.type === 'function' && entry.name === functionName && entry.inputs.length === count)
  return item?.type === 'function'
    ? item.inputs.flatMap((input, index) => (input.name && RESTAMPED_ARGS.has(input.name) ? [index] : []))
    : []
}

/** One reviewed step from a contract write request: its exact bytes, decoded for the review, under its hold keys. */
export function reviewedCall(
  request: TxRequest,
  step: Pick<ReviewedCall, 'intent' | 'legacy' | 'dependsOnPrior' | 'simulationBlockNumber'> = {},
): ReviewedCall {
  const restamped = restampedArgs(request.abi, request.functionName, request.args.length)
  return {
    chainId: request.chainId,
    to: request.address,
    data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args as unknown[] }),
    value: request.value ?? 0n,
    abi: request.abi,
    functionName: request.functionName,
    args: request.args,
    ...(request.label ? { label: request.label } : {}),
    ...(restamped.length ? { adoptIgnoringArgs: restamped } : {}),
    ...step,
  }
}

/** The hash a run ended on: its last transaction, or its Safe proposal. Null when it didn't finish. */
export const hashOf = (result: ReviewedResult | null) =>
  !result ? null : result.status === 'done' ? result.hashes.at(-1) ?? null : result.safeTxHash

/**
 * The receipt of a step that mined and reverted (core's ReviewedCallRevertedError),
 * read by name so a page doesn't load the send engine to recognize it. Null for any other failure.
 */
export function revertedReceipt(failure: unknown): TransactionReceipt | null {
  return failure instanceof Error && failure.name === 'ReviewedCallRevertedError'
    ? (failure as Error & { receipt?: TransactionReceipt }).receipt ?? null
    : null
}

/**
 * The run reached its last step: every step went through (a step resumed
 * from a saved run included, which no `onSubmitted` reports), or the last one
 * is with a Safe.
 */
export function reachedLastStep(result: ReviewedResult | null, calls: number): boolean {
  return result?.status === 'done' || (result?.status === 'proposed' && result.step === calls - 1)
}

/** The flow's step for the one core is on while a run is in flight (`shown[i]` is call `i`'s), else `fallback`. */
export function liveStep(tx: { busy: boolean; step: number }, shown: readonly number[] | null, fallback: number): number {
  return tx.busy && shown ? shown[tx.step] ?? fallback : fallback
}
