import { JBCoreContracts, NATIVE_TOKEN, USDC_ADDRESSES, jbContractAddress, jbControllerAbi, jbDirectoryAbi, jbFundAccessLimitsAbi, jbMultiTerminalAbi, jbProjectsAbi, jbSplitsAbi, jbTerminalStoreAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { JBPermissionIdsV6, RESERVED_TOKEN_SPLIT_GROUP_ID, getAccountingContexts, getCurrentRuleset, getTokenAddress, hasPermissions, payoutSplitGroupId, verifyPayoutReceipt, verifyReservedDistributionReceipt, type JBAccountingContext } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionResult, encodeFunctionData, isAddressEqual, zeroAddress, type Address, type TransactionReceipt } from 'viem'
import { clientFor, type AuthorityCall } from '@/lib/authority'
import { readAuthorityIdentity } from '@bananapus/nana-sdk-core/safe'
import { tokenSymbol } from '@/lib/token-symbol'
import { simulateStateChangingTransaction } from '@bananapus/nana-sdk-core/review'
import { isKnownController } from '@/lib/manage'
import { chainName } from '@/lib/urn'
import type { RawSplit } from '@/lib/splits-types'

const FEELESS_ADDRESS_ABI = [{ type: 'function', name: 'FEELESS_ADDRESSES', stateMutability: 'view',
  inputs: [], outputs: [{ type: 'address' }] }] as const
const IS_FEELESS_ABI = [{ type: 'function', name: 'isFeelessFor', stateMutability: 'view',
  inputs: [{ name: 'addr', type: 'address' }, { name: 'projectId', type: 'uint256' }, { name: 'caller', type: 'address' }],
  outputs: [{ type: 'bool' }] }] as const

export type DistributionProject = { chainId: JBChainId; projectId: number }
type PayoutContext = JBAccountingContext & { symbol: string; limits: { amount: bigint; currency: number; used: bigint; remaining: bigint }[]; balance: bigint }
export type PayoutOptions = DistributionProject & { terminal: Address; contexts: PayoutContext[] }
type Current = Awaited<ReturnType<typeof getCurrentRuleset>>
type BaseDistribution = DistributionProject & { owner: Address; controller: Address; current: Current; splits: readonly RawSplit[]; authority: Address; symbol: string }
export type PayoutDistribution = BaseDistribution & {
  kind: 'payouts'; terminal: Address; context: PayoutContext; amount: bigint; currency: number; quote: bigint; min: bigint; hookFeeless: Record<string, boolean>
}
export type ReservedDistribution = BaseDistribution & { kind: 'reserved'; pending: bigint }
export type Distribution = PayoutDistribution | ReservedDistribution

export function distributionProjects(chainId: JBChainId, projectId: number, chains: readonly (readonly [number, number])[]): DistributionProject[] {
  const projects = new Map<number, number>([[chainId, projectId]])
  for (const [id, pid] of chains) {
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid linked project.')
    if (projects.has(id) && projects.get(id) !== pid) throw new Error(`Conflicting project IDs on ${chainName(id)}.`)
    projects.set(id, pid)
  }
  return [...projects].map(([id, pid]) => ({ chainId: id as JBChainId, projectId: pid }))
}

export function matchingPayoutToken(homeToken: Address, homeChain: JBChainId, destinationChain: JBChainId): Address | null {
  if (homeChain === destinationChain || isAddressEqual(homeToken, NATIVE_TOKEN)) return homeToken
  if (USDC_ADDRESSES[homeChain] && isAddressEqual(homeToken, USDC_ADDRESSES[homeChain])) return USDC_ADDRESSES[destinationChain] ?? null
  return null
}

async function readProject(project: DistributionProject) {
  const client = clientFor(project.chainId), addresses = jbContractAddress['6'], pid = BigInt(project.projectId)
  const [owner, controller, current] = await Promise.all([
    client.readContract({ address: addresses[JBCoreContracts.JBProjects][project.chainId], abi: jbProjectsAbi, functionName: 'ownerOf', args: [pid] }),
    client.readContract({ address: addresses[JBCoreContracts.JBDirectory][project.chainId], abi: jbDirectoryAbi, functionName: 'controllerOf', args: [pid] }),
    getCurrentRuleset(client, { chainId: project.chainId, projectId: pid }),
  ])
  if (!isKnownController(project.chainId, controller) || !current.ruleset.id) throw new Error(`${chainName(project.chainId)} has no supported current controller and ruleset.`)
  return { client, owner, controller, current }
}

export async function readPayoutOptions(project: DistributionProject): Promise<PayoutOptions> {
  const { client, current } = await readProject(project)
  const addresses = jbContractAddress['6'], terminal = addresses[JBCoreContracts.JBMultiTerminal][project.chainId], pid = BigInt(project.projectId)
  const terminals = await client.readContract({ address: addresses[JBCoreContracts.JBDirectory][project.chainId], abi: jbDirectoryAbi, functionName: 'terminalsOf', args: [pid] })
  if (!terminals.some(item => isAddressEqual(item, terminal))) throw new Error(`${chainName(project.chainId)} does not use the supported payout terminal.`)
  const contexts = await getAccountingContexts(client, { chainId: project.chainId, projectId: pid })
  return { ...project, terminal, contexts: await Promise.all(contexts.map(async context => {
    const [symbol, balance, limits] = await Promise.all([
      tokenSymbol(client, context.token, { chainId: project.chainId }),
      client.readContract({ address: addresses[JBCoreContracts.JBTerminalStore][project.chainId], abi: jbTerminalStoreAbi, functionName: 'balanceOf', args: [terminal, pid, context.token] }),
      client.readContract({ address: addresses[JBCoreContracts.JBFundAccessLimits][project.chainId], abi: jbFundAccessLimitsAbi, functionName: 'payoutLimitsOf', args: [pid, BigInt(current.ruleset.id), terminal, context.token] }),
    ])
    return { ...context, symbol, balance, limits: await Promise.all(limits.map(async limit => {
      const used = await client.readContract({ address: addresses[JBCoreContracts.JBTerminalStore][project.chainId], abi: jbTerminalStoreAbi, functionName: 'usedPayoutLimitOf', args: [terminal, pid, context.token, BigInt(current.ruleset.cycleNumber), BigInt(limit.currency)] })
      return { ...limit, used, remaining: limit.amount > used ? limit.amount - used : 0n }
    })) }
  })) }
}

async function payoutAuthority(project: DistributionProject, owner: Address, ownerOnly: boolean, account: Address): Promise<Address> {
  if (!ownerOnly || isAddressEqual(owner, account)) return account
  const client = clientFor(project.chainId)
  const identity = await readAuthorityIdentity(client, owner)
  if (identity?.kind === 'safe' && identity.owners.some(signer => isAddressEqual(signer, account))) return owner
  if (await hasPermissions(client, { chainId: project.chainId, account: owner, operator: account, projectId: BigInt(project.projectId), permissionIds: [JBPermissionIdsV6.SEND_PAYOUTS] })) return account
  throw new Error(`${chainName(project.chainId)}: only the owner or an authorized payout operator can distribute.`)
}

function distributionData(distribution: Distribution) {
  return distribution.kind === 'payouts'
    ? encodeFunctionData({ abi: jbMultiTerminalAbi, functionName: 'sendPayoutsOf', args: [BigInt(distribution.projectId), distribution.context.token, distribution.amount, BigInt(distribution.currency), distribution.min] })
    : encodeFunctionData({ abi: jbControllerAbi, functionName: 'sendReservedTokensToSplitsOf', args: [BigInt(distribution.projectId)] })
}

async function payoutQuote(distribution: PayoutDistribution): Promise<bigint> {
  const data = await simulateStateChangingTransaction(clientFor(distribution.chainId), { from: distribution.authority, to: distribution.terminal, data: distributionData(distribution) })
  return decodeFunctionResult({ abi: jbMultiTerminalAbi, functionName: 'sendPayoutsOf', data })
}

export async function reviewPayout(project: DistributionProject, token: Address, amount: bigint, currency: number, account: Address): Promise<PayoutDistribution> {
  const { owner, controller, current, client } = await readProject(project)
  const options = await readPayoutOptions(project)
  const context = options.contexts.find(item => isAddressEqual(item.token, token))
  if (!context) throw new Error(`${chainName(project.chainId)} no longer accepts this accounting token.`)
  const limit = context.limits.find(item => item.currency === currency)
  if (amount <= 0n || !limit || amount > limit.remaining) throw new Error(`${chainName(project.chainId)}: enter an amount within the remaining payout limit.`)
  const authority = await payoutAuthority(project, owner, current.metadata.ownerMustSendPayouts, account)
  const splits = await client.readContract({ address: jbContractAddress['6'][JBCoreContracts.JBSplits][project.chainId], abi: jbSplitsAbi, functionName: 'splitsOf', args: [BigInt(project.projectId), BigInt(current.ruleset.id), payoutSplitGroupId(token)] })
  const hooks = [...new Set(splits.filter(split => !isAddressEqual(split.hook, zeroAddress)).map(split => split.hook.toLowerCase() as Address))]
  const hookFeeless: Record<string, boolean> = {}
  if (hooks.length) {
    const feeless = await client.readContract({ address: options.terminal, abi: FEELESS_ADDRESS_ABI, functionName: 'FEELESS_ADDRESSES' })
    for (const hook of hooks) hookFeeless[hook] = await client.readContract({ address: feeless, abi: IS_FEELESS_ABI, functionName: 'isFeelessFor', args: [hook, BigInt(project.projectId), options.terminal] })
  }
  const snapshot: PayoutDistribution = { ...project, kind: 'payouts', owner, controller, current, authority, terminal: options.terminal, context, splits, amount, currency, quote: 0n, min: 0n, symbol: context.symbol, hookFeeless }
  const quote = await payoutQuote(snapshot)
  if (quote <= 0n || quote > context.balance) throw new Error(`${chainName(project.chainId)} has no funds available for this payout.`)
  return { ...snapshot, quote, min: currency === context.currency ? quote : quote * 99n / 100n }
}

export async function reviewReserved(project: DistributionProject, account: Address): Promise<ReservedDistribution> {
  const { owner, controller, current, client } = await readProject(project)
  const [pending, splits, token] = await Promise.all([
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'pendingReservedTokenBalanceOf', args: [BigInt(project.projectId)] }),
    client.readContract({ address: jbContractAddress['6'][JBCoreContracts.JBSplits][project.chainId], abi: jbSplitsAbi, functionName: 'splitsOf', args: [BigInt(project.projectId), BigInt(current.ruleset.id), RESERVED_TOKEN_SPLIT_GROUP_ID] }),
    getTokenAddress(client, { chainId: project.chainId, projectId: BigInt(project.projectId) }),
  ])
  if (pending <= 0n) throw new Error(`${chainName(project.chainId)} has no pending reserved tokens.`)
  const symbol = token ? await tokenSymbol(client, token, { chainId: project.chainId }) : 'tokens'
  return { ...project, kind: 'reserved', owner, controller, current, authority: account, pending, splits, symbol }
}

function stable(value: unknown): string { return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : typeof item === 'string' && item.startsWith('0x') ? item.toLowerCase() : item) }

export async function reverifyDistribution(snapshot: Distribution, account: Address): Promise<void> {
  const fresh = snapshot.kind === 'payouts'
    ? await reviewPayout(snapshot, snapshot.context.token, snapshot.amount, snapshot.currency, account)
    : await reviewReserved(snapshot, account)
  const config = (item: Distribution) => [item.owner, item.controller, item.authority, item.current, item.splits,
    ...(item.kind === 'payouts' ? [item.terminal, item.context.token, item.context.decimals, item.context.currency, item.context.limits.map(limit => [limit.amount, limit.currency]), item.hookFeeless] : [])]
  if (stable(config(fresh)) !== stable(config(snapshot))) throw new Error(`${chainName(snapshot.chainId)}: the project rules, authority, accounting token, or recipients changed. Review again.`)
  if (snapshot.kind === 'reserved' && fresh.kind === 'reserved' && fresh.pending !== snapshot.pending) throw new Error(`${chainName(snapshot.chainId)}: the pending reserved amount changed. Review again.`)
  if (snapshot.kind === 'payouts' && fresh.kind === 'payouts' && fresh.quote < snapshot.min) throw new Error(`${chainName(snapshot.chainId)}: the payout quote fell below the reviewed minimum.`)
}

export function distributionCall(snapshot: Distribution): AuthorityCall {
  const payout = snapshot.kind === 'payouts'
  return { chainId: snapshot.chainId, authority: snapshot.authority, target: payout ? snapshot.terminal : snapshot.controller,
    data: distributionData(snapshot), gas: 10_000_000n, label: payout ? 'Distribute payouts' : 'Distribute reserved tokens',
    abi: payout ? jbMultiTerminalAbi : jbControllerAbi, functionName: payout ? 'sendPayoutsOf' : 'sendReservedTokensToSplitsOf',
    args: payout ? [BigInt(snapshot.projectId), snapshot.context.token, snapshot.amount, BigInt(snapshot.currency), snapshot.min] : [BigInt(snapshot.projectId)],
    contractName: payout ? 'JBMultiTerminal' : 'JBController' }
}

/**
 * A successful receipt can still hide a recipient or hook that failed or took
 * less than its share: the SDK proves every reviewed split received exactly
 * its share, in the reviewed ruleset, from the reviewed sender.
 */
export function verifyDistributionCompletion(snapshot: Distribution, receipt: TransactionReceipt): void {
  const reviewed = {
    projectId: snapshot.projectId,
    rulesetId: snapshot.current.ruleset.id,
    cycleNumber: snapshot.current.ruleset.cycleNumber,
    owner: snapshot.owner,
    caller: snapshot.authority,
  }
  try {
    if (snapshot.kind === 'payouts') {
      verifyPayoutReceipt(receipt, {
        ...reviewed,
        terminal: snapshot.terminal,
        token: snapshot.context.token,
        amount: snapshot.amount,
        minimum: snapshot.min,
        // A split's hook the terminal pays without its fee must receive its gross.
        splits: snapshot.splits.map(split => ({ ...split, feeless: snapshot.hookFeeless[split.hook.toLowerCase()] === true })),
      })
    } else {
      verifyReservedDistributionReceipt(receipt, {
        ...reviewed,
        controller: snapshot.controller,
        tokens: jbContractAddress['6'][JBCoreContracts.JBTokens][snapshot.chainId],
        tokenCount: snapshot.pending,
        splits: snapshot.splits,
      })
    }
  } catch (error) {
    throw new Error(`${chainName(snapshot.chainId)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
