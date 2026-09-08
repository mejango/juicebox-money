import { JBCoreContracts, NATIVE_TOKEN, USDC_ADDRESSES, jbContractAddress, jbControllerAbi, jbDirectoryAbi, jbFundAccessLimitsAbi, jbMultiTerminalAbi, jbProjectsAbi, jbSplitsAbi, jbTerminalStoreAbi, jbTokensAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { JBPermissionIdsV6, RESERVED_TOKEN_SPLIT_GROUP_ID, getAccountingContexts, getCurrentRuleset, getTokenAddress, hasPermissions, payoutSplitGroupId, type JBAccountingContext } from '@bananapus/nana-sdk-core/v6'
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, isAddressEqual, zeroAddress, type Address, type TransactionReceipt } from 'viem'
import { clientFor, type AuthorityCall } from '@/lib/authority'
import { readAuthorityIdentity } from '@/lib/cross-chain-authority'
import { tokenSymbol } from '@/lib/token-symbol'
import { simulateStateChangingTransaction } from '@/lib/transaction-simulation'
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

/** A successful EVM receipt can still contain individual payout/hook failures. */
export function verifyDistributionCompletion(snapshot: Distribution, receipt: TransactionReceipt): void {
  const target = snapshot.kind === 'payouts' ? snapshot.terminal : snapshot.controller
  let confirmed = false, burned = 0n
  for (const log of receipt.logs) {
    if (snapshot.kind === 'reserved' && isAddressEqual(log.address, jbContractAddress['6'][JBCoreContracts.JBTokens][snapshot.chainId])) {
      try {
        const event = decodeEventLog({ abi: jbTokensAbi, data: log.data, topics: log.topics })
        if (event.eventName === 'Burn' && event.args.projectId === BigInt(snapshot.projectId) && isAddressEqual(event.args.holder, snapshot.controller)) burned += event.args.count
      } catch { /* Other token events do not describe this distribution. */ }
    }
    if (!isAddressEqual(log.address, target)) continue
    let event: { eventName: string; args: unknown }
    try { event = decodeEventLog({ abi: snapshot.kind === 'payouts' ? jbMultiTerminalAbi : jbControllerAbi, data: log.data, topics: log.topics }) }
    catch { continue }
    const args = event.args as { projectId?: bigint; rulesetId?: bigint; rulesetCycleNumber?: bigint; caller?: Address; amount?: bigint; amountPaidOut?: bigint; netAmount?: bigint; tokenCount?: bigint; split?: { hook: Address } }
    if (args.projectId !== BigInt(snapshot.projectId)) continue
    if (['PayoutReverted', 'PayoutTransferReverted', 'ReservedDistributionReverted', 'SplitHookReverted'].includes(event.eventName)) {
      throw new Error(`${chainName(snapshot.chainId)} confirmed the transaction, but a recipient or hook failed. Keep this saved result; distributing again could pay successful recipients twice.`)
    }
    if (snapshot.kind === 'payouts' && event.eventName === 'SendPayoutToSplit' && typeof args.amount === 'bigint' && typeof args.netAmount === 'bigint') {
      const feeless = args.split && snapshot.hookFeeless[args.split.hook.toLowerCase()] === true
      const minimumNet = args.amount - (feeless ? 0n : args.amount / 40n)
      if (args.netAmount < minimumNet) throw new Error(`${chainName(snapshot.chainId)} confirmed a partial payout to a recipient. Keep this saved result and inspect the transaction before another distribution.`)
    }
    const successName = snapshot.kind === 'payouts' ? 'SendPayouts' : 'SendReservedTokensToSplits'
    if (event.eventName !== successName) continue
    if (args.rulesetId !== BigInt(snapshot.current.ruleset.id) || args.rulesetCycleNumber !== BigInt(snapshot.current.ruleset.cycleNumber) || !args.caller || !isAddressEqual(args.caller, snapshot.authority)) {
      throw new Error(`${chainName(snapshot.chainId)} executed with a different ruleset or caller. Keep the original transaction saved and inspect its recipients.`)
    }
    if (snapshot.kind === 'payouts' ? typeof args.amountPaidOut !== 'bigint' || args.amountPaidOut < snapshot.min : args.tokenCount !== snapshot.pending) {
      throw new Error(`${chainName(snapshot.chainId)} did not emit the reviewed distribution amount. Keep the original transaction saved.`)
    }
    confirmed = true
  }
  if (snapshot.kind === 'reserved') {
    const intentionalBurn = snapshot.splits.filter(split => split.projectId === 0n && isAddressEqual(split.hook, zeroAddress) && isAddressEqual(split.beneficiary, '0x000000000000000000000000000000000000dEaD')).reduce((total, split) => total + snapshot.pending * BigInt(split.percent) / 1_000_000_000n, 0n)
    if (burned > intentionalBurn) throw new Error(`${chainName(snapshot.chainId)} burned reserved tokens that a hook did not consume. Keep this saved transaction; do not distribute the same batch again.`)
  }
  if (!confirmed) throw new Error(`${chainName(snapshot.chainId)} has no matching distribution event. Keep checking the saved transaction.`)
}
