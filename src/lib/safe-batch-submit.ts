'use client'

import { getAccount } from '@wagmi/core'
import { getAddress, type Address, type Hex, type PublicClient } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { wagmiConfig } from '@/providers/Providers'
import { clientFor, runAuthorityCalls, type AuthorityCall } from '@/lib/authority'
import { readAuthorityIdentity } from '@/lib/cross-chain-authority'
import { runSafeCalls, type SafeCallResult } from '@/lib/safe'
import {
  composeBatch,
  dependsOnPrior,
  encodeMultiSend,
  MULTI_SEND_CALL_ONLY,
  multiSendAbi,
  packMultiSend,
  type BatchCall,
  type BatchStep,
} from '@/lib/safe-batch'
import { proposeSafeBatch } from '@/lib/safe-batch-connector'
import { isSafeConnection } from '@/lib/safe-connector'
import {
  buildBuybackHookAuthorityCall,
  buildInitializeBuybackPoolAuthorityCall,
  buildProjectPowerAuthorityCall,
  buildRevnetOperatorAuthorityCall,
  buildRouterTerminalAuthorityCall,
  buildSetBuybackPoolAuthorityCall,
  buildSetBuybackTwapAuthorityCall,
} from '@/lib/transaction-builders'
import type { TransactionReviewCall } from '@/lib/transaction-review'
import { simulateStateChangingTransaction } from '@/lib/transaction-simulation'
import { chainName } from '@/lib/urn'
import { assertNoViewAs } from '@/lib/viewAs'

/**
 * How a batch reaches the chain, decided from the authority's identity and
 * the connection: one MultiSend proposal from the Safe app, one operation-1
 * SafeTx signed by an owner, or sequential direct writes from the EOA.
 */
export type SafeBatchRoute =
  | { kind: 'safe-app'; authorityKind: 'safe' }
  | { kind: 'safe-owner'; authorityKind: 'safe' }
  | { kind: 'eoa'; authorityKind: 'eoa' }
  | { kind: 'unavailable'; authorityKind: 'safe' | 'eoa' | 'contract' | 'unknown'; reason: string }

export async function resolveSafeBatchRoute({
  chainId,
  authority,
}: {
  chainId: JBChainId
  authority: Address
}): Promise<SafeBatchRoute> {
  const connected = getAccount(wagmiConfig).address
  const identity = await readAuthorityIdentity(clientFor(chainId), authority)
  if (!identity) {
    return {
      kind: 'unavailable',
      authorityKind: 'unknown',
      reason: `Could not verify the authority on ${chainName(chainId)}.`,
    }
  }
  if (identity.kind === 'contract') {
    return {
      kind: 'unavailable',
      authorityKind: 'contract',
      reason: 'The project authority is an unsupported contract. Only an EOA or a canonical Safe is supported.',
    }
  }
  if (!connected) {
    return {
      kind: 'unavailable',
      authorityKind: identity.kind === 'safe' ? 'safe' : 'eoa',
      reason: 'Connect a wallet first.',
    }
  }
  const same = connected.toLowerCase() === authority.toLowerCase()
  if (identity.kind === 'safe') {
    if (isSafeConnection(wagmiConfig) && same) {
      return { kind: 'safe-app', authorityKind: 'safe' }
    }
    if (identity.owners.some(owner => owner.toLowerCase() === connected.toLowerCase())) {
      return { kind: 'safe-owner', authorityKind: 'safe' }
    }
    return {
      kind: 'unavailable',
      authorityKind: 'safe',
      reason: `The connected wallet is not a signer of ${authority}. Switch to a signer of this Safe.`,
    }
  }
  if (same) return { kind: 'eoa', authorityKind: 'eoa' }
  return {
    kind: 'unavailable',
    authorityKind: 'eoa',
    reason: `The connected wallet is not the authority on ${chainName(chainId)}. Switch to ${authority}.`,
  }
}

export function batchActionLabel(route: SafeBatchRoute, count: number): string {
  if (route.kind === 'eoa') {
    return `Send ${count} transaction${count === 1 ? '' : 's'}`
  }
  if (route.kind === 'unavailable') return 'Submit batch'
  return 'Propose batch to Safe'
}

export type SafeBatchOutcome =
  | { kind: 'safe-app'; safeTxHash: Hex; executionHash: Hex }
  | { kind: 'safe-owner'; result: SafeCallResult }
  | { kind: 'eoa'; hashes: Hex[] }

function address(step: BatchStep, name: string): Address {
  return getAddress(String(step.values[name]))
}

/**
 * The step rebuilt through the same audited builder its form would have
 * used, then checked against the calldata the tray stored: a stale or edited
 * tray entry cannot send anything its builder would not.
 */
export function authorityCallForStep(
  step: BatchStep,
  authority: Address,
): AuthorityCall {
  const chainId = step.chainId
  const projectId = BigInt(step.projectId)
  const label = step.label
  let call: AuthorityCall
  switch (step.kind) {
    case 'setHookFor':
      call = buildBuybackHookAuthorityCall({
        chainId,
        authority,
        registry: step.to,
        projectId,
        hook: address(step, 'hook'),
        label,
      })
      break
    case 'setPoolFor':
      call = buildSetBuybackPoolAuthorityCall({
        chainId,
        authority,
        registry: step.to,
        projectId,
        fee: Number(step.values.fee),
        tickSpacing: Number(step.values.tickSpacing),
        twapWindow: BigInt(String(step.values.twapWindow)),
        terminalToken: address(step, 'terminalToken'),
        label,
      })
      break
    case 'setTerminalFor':
      call = buildRouterTerminalAuthorityCall({
        chainId,
        authority,
        registry: step.to,
        projectId,
        terminal: address(step, 'terminal'),
        label,
      })
      break
    case 'setTwapWindowOf':
      call = buildSetBuybackTwapAuthorityCall({
        chainId,
        authority,
        hook: step.to,
        projectId,
        terminalToken: address(step, 'terminalToken'),
        twapWindow: BigInt(String(step.values.twapWindow)),
        label,
      })
      break
    case 'initializePoolFor':
      call = buildInitializeBuybackPoolAuthorityCall({
        chainId,
        authority,
        registry: step.to,
        projectId,
        fee: Number(step.values.fee),
        tickSpacing: Number(step.values.tickSpacing),
        twapWindow: BigInt(String(step.values.twapWindow)),
        pairToken: address(step, 'pairToken'),
        sqrtPriceX96: BigInt(String(step.values.sqrtPriceX96)),
        label,
      })
      break
    case 'setOperatorOf':
      call = buildRevnetOperatorAuthorityCall({
        chainId,
        authority,
        revnetId: projectId,
        operator: address(step, 'operator'),
        label,
      })
      break
    case 'power':
      call = buildProjectPowerAuthorityCall({
        chainId,
        authority,
        target: step.to,
        abi: step.abi,
        functionName: step.functionName,
        args: step.args,
        contractName: step.contractName,
        gas: step.values.flag === 'allowAddAccountingContext' ? 300_000n : 500_000n,
        label,
      })
      break
  }
  if (
    call.target.toLowerCase() !== step.to.toLowerCase() ||
    call.data.toLowerCase() !== step.data.toLowerCase()
  ) {
    throw new Error(
      `${step.label} no longer matches its builder. Remove it from the batch and add it again.`,
    )
  }
  return call
}

function reviewCallsFor(
  steps: readonly BatchStep[],
  from: Address,
): TransactionReviewCall[] {
  return steps.map(step => ({
    chainId: step.chainId,
    from,
    to: step.to,
    data: step.data,
    value: step.value,
    label: step.label,
    abi: step.abi,
    functionName: step.functionName,
    args: step.args,
    contractName: step.contractName,
  }))
}

function revertDetail(error: unknown): string {
  if (error instanceof Error && 'shortMessage' in error && typeof error.shortMessage === 'string') {
    return error.shortMessage
  }
  return error instanceof Error ? error.message.split('\n')[0] : 'The call would revert.'
}

/**
 * Prove the whole sequence from the authority before anything is signed:
 * `eth_simulateV1` runs the calls in order against one state; where a node
 * lacks it, each call that does not depend on an earlier step is simulated
 * on its own.
 */
async function simulateSequence(
  client: PublicClient,
  from: Address,
  steps: readonly BatchStep[],
  calls: readonly BatchCall[],
): Promise<void> {
  let sequence: { status: string; error?: unknown }[] | null = null
  try {
    const simulated = await client.simulateCalls({ account: from, calls })
    sequence = simulated.results.map(result =>
      result.status === 'failure'
        ? { status: 'failure', error: result.error }
        : { status: result.status },
    )
  } catch {
    // The node lacks eth_simulateV1; fall back to independent per-call checks.
    sequence = null
  }
  if (sequence) {
    const failed = sequence.findIndex(result => result.status !== 'success')
    if (failed !== -1) {
      const result = sequence[failed]
      throw new Error(
        `${steps[failed].label} cannot run on ${chainName(steps[failed].chainId)}: ${
          result.status === 'failure' ? revertDetail(result.error) : 'The call would revert.'
        }`,
      )
    }
    return
  }
  for (const step of steps) {
    if (dependsOnPrior(step, steps)) continue
    try {
      await simulateStateChangingTransaction(client, {
        from,
        to: step.to,
        data: step.data,
        value: step.value,
      })
    } catch (error) {
      throw new Error(
        `${step.label} cannot run on ${chainName(step.chainId)}: ${revertDetail(error)}`,
      )
    }
  }
}

export async function submitSafeBatch({
  chainId,
  authority,
  steps,
  route,
  onProgress,
  onStep,
  onProposed,
}: {
  chainId: JBChainId
  authority: Address
  steps: readonly BatchStep[]
  route: SafeBatchRoute
  onProgress?: (message: string) => void
  /** The step whose wallet prompt is next (EOA route). */
  onStep?: (index: number) => void
  /** The proposal hash, once a Safe route has queued the batch. */
  onProposed?: (safeTxHash: Hex) => Promise<void> | void
}): Promise<SafeBatchOutcome> {
  assertNoViewAs()
  if (route.kind === 'unavailable') throw new Error(route.reason)
  if (steps.some(step => step.chainId !== chainId)) {
    throw new Error('Every step in a batch must target the same chain.')
  }
  const { calls, problems } = composeBatch(steps)
  if (!calls.length) throw new Error('Add at least one step to the batch.')
  if (problems.length) throw new Error(problems[0].message)
  const connected = getAccount(wagmiConfig).address
  if (!connected) throw new Error('Connect a wallet first.')
  const client = clientFor(chainId)

  if (route.kind === 'eoa') {
    const hashes: Hex[] = []
    for (let index = 0; index < steps.length; index++) {
      onStep?.(index)
      const result = await runAuthorityCalls({
        calls: [authorityCallForStep(steps[index], authority)],
        onProgress: progress => onProgress?.(progress.message),
      })
      hashes.push(...result.directResults)
    }
    return { kind: 'eoa', hashes }
  }

  onProgress?.(`Simulating ${calls.length} calls from the Safe…`)
  await simulateSequence(client, authority, steps, calls)

  if (route.kind === 'safe-app') {
    onProgress?.('Continue in Safe, then execute the proposal…')
    const proposal = await proposeSafeBatch({
      chainId,
      safe: authority,
      calls,
      reviewCalls: reviewCallsFor(steps, authority),
      title: `Review batch on ${chainName(chainId)}`,
      onProposed,
    })
    return { kind: 'safe-app', ...proposal }
  }

  const code = await client.getCode({ address: MULTI_SEND_CALL_ONLY })
  if (!code || code === '0x') {
    throw new Error(
      `MultiSendCallOnly is not deployed on ${chainName(chainId)}, so a batch cannot be proposed there.`,
    )
  }
  const packed = packMultiSend(calls)
  const [result] = await runSafeCalls({
    signer: connected,
    calls: [
      {
        chainId,
        safe: authority,
        target: MULTI_SEND_CALL_ONLY,
        data: encodeMultiSend(calls),
        value: 0n,
        operation: 1,
        label: `Batch (${calls.length} calls)`,
        abi: multiSendAbi,
        functionName: 'multiSend',
        args: [packed],
        contractName: 'MultiSendCallOnly',
      },
    ],
    onProgress,
  })
  await onProposed?.(result.safeTxHash)
  return { kind: 'safe-owner', result }
}
