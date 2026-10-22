import { encodeFunctionData, type Abi } from 'viem'
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

/** One reviewed step from a contract write request: its exact bytes, decoded for the review, under its hold keys. */
export function reviewedCall(
  request: TxRequest,
  step: Pick<ReviewedCall, 'intent' | 'legacy' | 'dependsOnPrior' | 'simulationBlockNumber'> = {},
): ReviewedCall {
  return {
    chainId: request.chainId,
    to: request.address,
    data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args as unknown[] }),
    value: request.value ?? 0n,
    abi: request.abi,
    functionName: request.functionName,
    args: request.args,
    ...(request.label ? { label: request.label } : {}),
    ...step,
  }
}

/** The hash a run ended on: its last transaction, or its Safe proposal. Null when it didn't finish. */
export const hashOf = (result: ReviewedResult | null) =>
  !result ? null : result.status === 'done' ? result.hashes.at(-1) ?? null : result.safeTxHash
