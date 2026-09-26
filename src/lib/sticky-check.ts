import { jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { getTokenAddress, validateStickyGroupId } from '@bananapus/nana-sdk-core/v6'
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  erc20Abi,
  isAddressEqual,
  type Address,
  type PublicClient,
} from 'viem'
import { truncateAddress } from '@/lib/format'
import { stickyNoErc20Reason } from '@/lib/sticky'
import { chainName } from '@/lib/urn'

/**
 * The onchain Sticky checks, kept apart from the display helpers in
 * `@/lib/sticky` so pages that only render Sticky splits stay light.
 */

// Only the two views the distributor itself uses; the full Sticky ABIs are large.
const stickyTokenAbi = [
  {
    type: 'function',
    name: 'PROJECT_ID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const
const stickyHookAbi = [
  {
    type: 'function',
    name: 'tokenOf',
    stateMutability: 'view',
    inputs: [{ name: 'projectId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
] as const

export type StickyTokenCheck =
  | { ok: true; symbol: string }
  | { ok: false; reason: string }

function reverted(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    !!error.walk(
      cause =>
        cause instanceof ContractFunctionRevertedError ||
        cause instanceof ContractFunctionZeroDataError,
    )
  )
}

/**
 * Whether `token` is a Sticky token the Sticky hook tracks on `chainId`: the
 * same test the distributor runs, `StickyHook.tokenOf(token.PROJECT_ID()) == token`.
 */
export async function checkStickyToken(
  client: PublicClient,
  chainId: number,
  token: Address,
): Promise<StickyTokenCheck> {
  const where = chainName(chainId)
  const hook = (jbContractAddress['6'].StickyHook as Partial<Record<number, Address>>)[chainId]
  if (!hook) return { ok: false, reason: `Sticky is not deployed on ${where}.` }
  let projectId: bigint
  try {
    projectId = await client.readContract({
      address: token,
      abi: stickyTokenAbi,
      functionName: 'PROJECT_ID',
    })
  } catch (error) {
    return reverted(error)
      ? { ok: false, reason: `${truncateAddress(token)} is not a Sticky token on ${where}.` }
      : { ok: false, reason: `Could not check the Sticky token on ${where}.` }
  }
  let tracked: Address
  try {
    tracked = await client.readContract({
      address: hook,
      abi: stickyHookAbi,
      functionName: 'tokenOf',
      args: [projectId],
    })
  } catch {
    return { ok: false, reason: `Could not check the Sticky token on ${where}.` }
  }
  if (!isAddressEqual(tracked, token)) {
    return { ok: false, reason: `${truncateAddress(token)} is not a Sticky token on ${where}.` }
  }
  const symbol = await client
    .readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
    .catch(() => '')
  return { ok: true, symbol }
}

/**
 * The first reason any Sticky split can't be submitted on `chainIds`, or null.
 * Checks each distinct token once per chain, and every group ID.
 */
export async function stickySplitsProblem(
  splits: readonly { beneficiary: Address; projectId: bigint }[],
  chainIds: readonly number[],
  clientFor: (chainId: number) => PublicClient,
): Promise<string | null> {
  for (const split of splits) {
    const reason = validateStickyGroupId(split.projectId)
    if (reason) return reason
  }
  const tokens = [...new Set(splits.map(split => split.beneficiary.toLowerCase()))] as Address[]
  const checks = await Promise.all(
    chainIds.flatMap(chainId =>
      tokens.map(token => checkStickyToken(clientFor(chainId), chainId, token)),
    ),
  )
  const failed = checks.find(check => !check.ok)
  return failed && !failed.ok ? failed.reason : null
}

/**
 * Why an edited split group can't be saved on one chain because of its Sticky
 * splits, or null. Reserved tokens also need the project's ERC-20 there.
 */
export async function stickyDestinationProblem({
  client,
  chainId,
  projectId,
  reserved,
  splits,
}: {
  client: PublicClient
  chainId: number
  projectId: number
  reserved: boolean
  splits: readonly { beneficiary: Address; projectId: bigint }[]
}): Promise<string | null> {
  if (splits.length === 0) return null
  if (
    reserved &&
    !(await getTokenAddress(client, {
      chainId: chainId as JBChainId,
      projectId: BigInt(projectId),
    }))
  ) {
    return stickyNoErc20Reason(chainId)
  }
  return stickySplitsProblem(splits, [chainId], () => client)
}
