import { NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, erc20Abi, isAddress, isAddressEqual, keccak256, parseAbi, parseAbiParameters, zeroHash, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { bendystraw } from '@/lib/bendystraw'
import { clientFor } from '@/lib/authority'
import type { ProjectBatchCall } from '@/lib/project-batch'
import { rolloutChain, rolloutContractName } from '@/lib/protocol-rollout'
import { routerGatewayAbi } from '@/lib/router-gateway-abi'
import { tokenSymbol } from '@/lib/token-symbol'

export type PendingPayment = {
  chainId: JBChainId; version: number; gateway: Address; pendingCallId: Hex
  projectId: number; sourceProjectId: number; token: Address; amount: string; retainedAmount: string
  preferAddToBalance: boolean; shouldReturnHeldFees: boolean; beneficiary: Address; refundTo: Address
  memo: string; metadata: Hex; callCommitment: Hex; status: 'queued' | 'retried'
}
export type ReviewedPayment = {
  payment: PendingPayment; functionName: 'processPendingCall' | 'finalizePendingCall'
  failure: { errorHash: Hex; count: number; lastFailureAt: number; highestGasLimit: bigint }
  readyAt: bigint; ready: boolean; gas: bigint; decimals: number | null; symbol: string
}

const PENDING_PAYMENTS_QUERY = `query PendingPayments($chainId: Int!, $sourceProjectId: Int!, $gateway: String!, $limit: Int!, $offset: Int!) {
  routerPendingCalls(
    where: { AND: [{ chainId: $chainId }, { sourceProjectId: $sourceProjectId }, { gateway: $gateway }, { version: 6 }, { retainedAmount_gt: "0" }, { status_in: [queued, retried] }] }
    orderBy: "pendingCallId", orderDirection: "asc", limit: $limit, offset: $offset
  ) {
    totalCount
    items { chainId version gateway pendingCallId projectId sourceProjectId token amount retainedAmount preferAddToBalance shouldReturnHeldFees beneficiary refundTo memo metadata callCommitment status }
  }
}`
const PARAMETERS = parseAbiParameters('(uint256 amount, bool preferAddToBalance, bool shouldReturnHeldFees, address beneficiary, uint256 projectId, address refundTo, uint256 sourceProjectId, address token), string, bytes')
const POLICY_ABI = parseAbi([
  'function RETRY_DELAY() view returns (uint256)',
  'function FINALIZATION_FAILURE_COUNT() view returns (uint256)',
])
const word = (value: unknown): value is Hex => typeof value === 'string' && /^0x[\da-f]{64}$/iu.test(value)
const bytes = (value: unknown): value is Hex => typeof value === 'string' && /^0x(?:[\da-f]{2})*$/iu.test(value)
const uint = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/u.test(value) && BigInt(value) < 2n ** 256n
export const pendingPaymentId = (payment: PendingPayment) => `${payment.chainId}:${payment.gateway.toLowerCase()}:${payment.pendingCallId.toLowerCase()}`

function callTuple(payment: PendingPayment) {
  return { amount: BigInt(payment.amount), preferAddToBalance: payment.preferAddToBalance,
    shouldReturnHeldFees: payment.shouldReturnHeldFees, beneficiary: payment.beneficiary,
    projectId: BigInt(payment.projectId), refundTo: payment.refundTo,
    sourceProjectId: BigInt(payment.sourceProjectId), token: payment.token }
}

export function paymentCommitment(payment: PendingPayment): Hex {
  return keccak256(encodeAbiParameters(PARAMETERS, [callTuple(payment), payment.memo, payment.metadata]))
}

function validatePayment(payment: PendingPayment, chainId: number, sourceProjectId: number): void {
  if (!payment || payment.chainId !== chainId || payment.sourceProjectId !== sourceProjectId || payment.version !== 6 ||
    !Number.isSafeInteger(payment.projectId) || payment.projectId <= 0 || !Number.isSafeInteger(sourceProjectId) || sourceProjectId <= 0 ||
    !['queued', 'retried'].includes(payment.status) || ![payment.gateway, payment.token, payment.beneficiary, payment.refundTo].every(address => isAddress(address, { strict: false })) ||
    !word(payment.pendingCallId) || !word(payment.callCommitment) || !bytes(payment.metadata) || typeof payment.memo !== 'string' ||
    typeof payment.preferAddToBalance !== 'boolean' || typeof payment.shouldReturnHeldFees !== 'boolean' ||
    !uint(payment.amount) || BigInt(payment.amount) === 0n || payment.retainedAmount !== payment.amount ||
    !rolloutContractName(chainId, payment.gateway)?.startsWith('JBRouterTerminalGateway (') ||
    paymentCommitment(payment).toLowerCase() !== payment.callCommitment.toLowerCase()) {
    throw new Error('The indexed pending payment could not be verified. Refresh before retrying.')
  }
}

/** Complete source-project inventory, independent of its current terminal selection. */
export async function fetchPendingPayments(chainId: JBChainId, sourceProjectId: number): Promise<PendingPayment[]> {
  const chain = rolloutChain(chainId)
  const gateways = [...new Set([chain?.contracts.JBRouterTerminalGateway, ...Object.values(chain?.history.JBRouterTerminalGateway ?? {})]
    .filter((address): address is string => !!address).map(address => address.toLowerCase()))]
  return (await Promise.all(gateways.map(gateway => fetchGatewayPayments(chainId, sourceProjectId, gateway)))).flat()
}

// Pending IDs are monotonic within one gateway; gateway-scoped pagination also
// stays deterministic when a previous generation still holds payments.
async function fetchGatewayPayments(chainId: JBChainId, sourceProjectId: number, gateway: string): Promise<PendingPayment[]> {
  const items: PendingPayment[] = []
  const seen = new Set<string>()
  let total: number | undefined
  do {
    const { routerPendingCalls: page } = await bendystraw<{ routerPendingCalls: { items: PendingPayment[]; totalCount: number } }>(
      PENDING_PAYMENTS_QUERY, { chainId, sourceProjectId, gateway, limit: 100, offset: items.length }, { policy: 'live' })
    if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.totalCount) || page.totalCount < 0 ||
      (total !== undefined && total !== page.totalCount) || page.items.length > 100 ||
      (page.items.length === 0 && items.length !== page.totalCount)) {
      throw new Error('The pending payment list changed or is incomplete. Refresh to load all payments.')
    }
    total = page.totalCount
    for (const payment of page.items) {
      validatePayment(payment, chainId, sourceProjectId)
      if (payment.gateway.toLowerCase() !== gateway) throw new Error('The indexed payment belongs to another gateway.')
      const id = pendingPaymentId(payment)
      if (seen.has(id)) throw new Error('The pending payment list contains duplicate records. Refresh to load all payments.')
      seen.add(id); items.push(payment)
    }
    if (items.length > total) throw new Error('The pending payment list is inconsistent. Refresh to load all payments.')
  } while (items.length < total)
  return items
}

/** One block snapshot authenticates custody and determines the permitted next action. */
export async function reviewPendingPayment(payment: PendingPayment, client: PublicClient = clientFor(payment.chainId)): Promise<ReviewedPayment | null> {
  validatePayment(payment, payment.chainId, payment.sourceProjectId)
  const block = await client.getBlock()
  const shared = { address: payment.gateway, blockNumber: block.number }
  const [commitment, failure, delay, finalizationCount] = await Promise.all([
    client.readContract({ ...shared, abi: routerGatewayAbi, functionName: 'pendingCallCommitmentOf', args: [payment.pendingCallId] }),
    client.readContract({ ...shared, abi: routerGatewayAbi, functionName: 'pendingCallFailureOf', args: [payment.pendingCallId] }),
    client.readContract({ ...shared, abi: POLICY_ABI, functionName: 'RETRY_DELAY' }),
    client.readContract({ ...shared, abi: POLICY_ABI, functionName: 'FINALIZATION_FAILURE_COUNT' }),
  ])
  if (commitment === zeroHash) return null
  if (commitment.toLowerCase() !== paymentCommitment(payment).toLowerCase()) throw new Error('The gateway commitment differs from the indexed payment. Refresh before retrying.')
  const readyAt = failure.count === 0 ? 0n : BigInt(failure.lastFailureAt) + delay
  const native = isAddressEqual(payment.token, NATIVE_TOKEN)
  const [decimals, symbol] = await Promise.all([
    native ? Promise.resolve(18) : client.readContract({ address: payment.token, abi: erc20Abi, functionName: 'decimals' }).catch(() => null),
    tokenSymbol(client, payment.token, { chainId: payment.chainId }),
  ])
  // A later gas-exhaustion retry can forward 15M gas. The standard 10M preflight
  // ceiling is too low. Standard simulation/estimation still has to succeed
  // inside the live block limit and EIP-7825 transaction cap before signing.
  const gas = 16_777_216n
  return { payment, failure, readyAt, ready: block.timestamp >= readyAt, gas: gas < block.gasLimit ? gas : block.gasLimit,
    functionName: BigInt(failure.count) >= finalizationCount ? 'finalizePendingCall' : 'processPendingCall', decimals, symbol }
}

export function pendingPaymentCall(review: ReviewedPayment, account: Address): ProjectBatchCall {
  if (!review.ready) throw new Error('This payment is still waiting for its next retry time.')
  const { payment, functionName } = review
  const args = [payment.pendingCallId, callTuple(payment), payment.memo, payment.metadata] as const
  return { id: pendingPaymentId(payment), chainId: payment.chainId, projectId: payment.sourceProjectId,
    authority: account, target: payment.gateway, value: 0n, gas: review.gas, relayr: false,
    abi: routerGatewayAbi, functionName, args, contractName: 'JBRouterTerminalGateway',
    data: encodeFunctionData({ abi: routerGatewayAbi, functionName, args }),
    label: functionName === 'finalizePendingCall' ? 'Route or return pending payment' : 'Retry pending payment', context: review }
}

export async function reverifyPendingPayment(call: ProjectBatchCall): Promise<void> {
  const reviewed = call.context as ReviewedPayment
  const fresh = await reviewPendingPayment(reviewed.payment)
  if (!fresh) throw new Error('This payment has already resolved. Refresh the pending payments.')
  const expected = pendingPaymentCall(fresh, call.authority)
  if (expected.data !== call.data || expected.target.toLowerCase() !== call.target.toLowerCase() || expected.chainId !== call.chainId ||
    expected.projectId !== call.projectId || expected.id !== call.id || call.value !== 0n ||
    fresh.failure.errorHash !== reviewed.failure.errorHash || fresh.failure.count !== reviewed.failure.count ||
    fresh.failure.lastFailureAt !== reviewed.failure.lastFailureAt || fresh.failure.highestGasLimit !== reviewed.failure.highestGasLimit) {
    throw new Error('The pending payment changed since review. Refresh before retrying.')
  }
}

/** A permissionless third-party attempt cannot strand the unsent rest of a saved batch. */
export async function reconcilePendingPayment(call: ProjectBatchCall): Promise<string | null> {
  const reviewed = call.context as ReviewedPayment
  const fresh = await reviewPendingPayment(reviewed.payment)
  if (!fresh) return 'This payment resolved through another transaction.'
  if (fresh.failure.errorHash !== reviewed.failure.errorHash || fresh.failure.count !== reviewed.failure.count ||
    fresh.failure.lastFailureAt !== reviewed.failure.lastFailureAt || fresh.failure.highestGasLimit !== reviewed.failure.highestGasLimit) {
    return 'Another attempt changed this payment. Refresh and review its next available action.'
  }
  return null
}

export function pendingPaymentOutcome(call: ProjectBatchCall, receipt: Pick<TransactionReceipt, 'logs'>): 'routed' | 'returned' | 'pending' {
  const payment = (call.context as ReviewedPayment).payment
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, payment.gateway)) continue
    try {
      const event = decodeEventLog({ abi: routerGatewayAbi, data: log.data, topics: log.topics })
      if (!('id' in event.args) || event.args.id.toLowerCase() !== payment.pendingCallId.toLowerCase()) continue
      if (event.eventName === 'JBRouterTerminalGateway_RecordTerminalCallFailure') return 'pending'
      if (event.eventName === 'JBRouterTerminalGateway_ProcessPendingCall' || event.eventName === 'JBRouterTerminalGateway_RefundPendingCall') {
        const commitment = keccak256(encodeAbiParameters(PARAMETERS, [event.args.call, payment.memo, payment.metadata]))
        if (commitment.toLowerCase() !== payment.callCommitment.toLowerCase()) continue
        return event.eventName === 'JBRouterTerminalGateway_ProcessPendingCall' ? 'routed' : 'returned'
      }
    } catch { /* Other gateway events do not prove the outcome of this call. */ }
  }
  throw new Error('The receipt does not prove this payment’s outcome. Keep the saved action and check it again.')
}
