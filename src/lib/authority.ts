'use client'

import { getAccount, getPublicClient } from '@wagmi/core'
import type { Abi, Address, Hex, PublicClient } from 'viem'
import {
  JB_CHAINS,
  JBCoreContracts,
  jbContractAddress,
  jbProjectsAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { wagmiConfig } from '@/providers/Providers'
import { requireTransactionReview } from '@/lib/transaction-review'
import { connectedWallet } from '@/lib/wallet-core'
import { assertNoViewAs } from '@/lib/viewAs'
import { gasWithHeadroom } from '@/lib/gas'
import { waitForTrackedReceipt } from '@/lib/receipt'
import {
  loadRelayrPendingSession,
  relayrCallsScope,
  runRelayrCalls,
  type RelayrCall,
  type RelayrProgress,
  type RelayrTransactionRecord,
} from '@/lib/relayr'
import { fetchSafeInfo, runSafeCalls, type SafeCallResult } from '@/lib/safe'

export type AuthorityCall = {
  chainId: JBChainId
  authority: Address
  target: Address
  data: Hex
  value?: bigint
  gas?: bigint
  label?: string
  abi?: Abi
  functionName?: string
  args?: readonly unknown[]
  contractName?: string
}

export type AuthorityProgress = {
  kind: 'checking' | 'direct' | 'relayr' | 'safe'
  message: string
}

export type AuthorityResult = {
  directResults: Hex[]
  relayrGroups: number
  relayrResults: Array<{
    bundleUuid: string
    paymentHash: Hex | null
    records: RelayrTransactionRecord[]
  }>
  safeResults: SafeCallResult[]
}

/** A configured public client for the chain — throws instead of returning
 *  undefined so callers can read immediately. */
export function clientFor(chainId: JBChainId): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId })
  if (!client) throw new Error(`No RPC client is configured for chain ${chainId}.`)
  return client as PublicClient
}

/**
 * The account authorized to act for a project on one chain: the live
 * JBProjects ownerOf, falling back to the indexed authority when the read
 * fails. Pass `indexedOnly` (revnets) to trust the indexed operator without
 * an owner read — revnet project NFTs are held by REVOwner, not the operator.
 */
export async function readAuthorityOf(
  client: PublicClient,
  deployment: {
    chainId: JBChainId
    projectId: number
    indexedAuthority: Address | null
  },
  { indexedOnly = false }: { indexedOnly?: boolean } = {},
): Promise<Address | null> {
  if (indexedOnly) return deployment.indexedAuthority
  return (await client
    .readContract({
      address: jbContractAddress['6'][JBCoreContracts.JBProjects][
        deployment.chainId
      ],
      abi: jbProjectsAbi,
      functionName: 'ownerOf',
      args: [BigInt(deployment.projectId)],
    })
    .catch(() => deployment.indexedAuthority)) as Address | null
}

/**
 * The status line shown after `runAuthorityCalls`: the caller's `completed`
 * message, unless any call went through a Safe — then a queued/waiting
 * summary pointing at the Pending multisig transactions card. `showExecuted`
 * appends the already-executed count and `instruction` overrides the default
 * closing sentence.
 */
export function safeOutcomeMessage(
  result: AuthorityResult,
  completed: string,
  options: { showExecuted?: boolean; instruction?: string } = {},
): string {
  const queued = result.safeResults.filter(row => row.status === 'queued').length
  const waiting = result.safeResults.filter(row => row.status === 'waiting').length
  const submitted = result.safeResults.filter(
    row => row.status === 'submitted',
  ).length
  const executed = options.showExecuted
    ? result.safeResults.filter(row => row.status === 'executed').length
    : 0
  if (queued || waiting || submitted) {
    return `Safe action recorded${queued ? ` · ${queued} queued` : ''}${
      waiting ? ` · ${waiting} awaiting more approvals` : ''
    }${submitted ? ` · ${submitted} submitted and awaiting confirmation` : ''}${
      executed ? ` · ${executed} executed` : ''
    }. ${
      options.instruction ?? 'Complete it in Pending multisig transactions.'
    }`
  }
  return completed
}

/** A copy of the set with `value` toggled in or out. */
export function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

/**
 * The Relayr view of a group of authority calls. Build this at the moment the
 * calls are handed to Relayr, never earlier: the simulation pass writes the
 * measured `gas` onto the shared AuthorityCall objects, and a snapshot taken
 * before that pass would sign every ForwardRequest with the 500k fallback —
 * under-capping any larger call AFTER the user paid for the bundle.
 * (`relayrCallsScope` ignores `gas`, so the pending-session scope is identical
 * whether it is computed before or after estimation.)
 */
function toRelayrCalls(calls: AuthorityCall[]): RelayrCall[] {
  return calls.map(call => ({
    chainId: call.chainId,
    target: call.target,
    data: call.data,
    value: call.value,
    gas: call.gas,
    label: call.label,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    contractName: call.contractName,
  }))
}

/**
 * Route reviewed project owner/operator calls by the controlling account on
 * each chain. A one-chain EOA action is sent directly; a genuinely
 * multi-chain EOA action signs ERC-2771 requests and pays Relayr once. A Safe
 * signer queues or approves the exact call through that chain's Safe path.
 */
export async function runAuthorityCalls({
  calls,
  onProgress,
}: {
  calls: AuthorityCall[]
  onProgress?: (progress: AuthorityProgress) => void
}): Promise<AuthorityResult> {
  assertNoViewAs()
  if (!calls.length) throw new Error('Choose at least one chain.')
  const connected = getAccount(wagmiConfig).address
  if (!connected) throw new Error('Connect a wallet first.')

  const groups = new Map<string, AuthorityCall[]>()
  for (const call of calls) {
    const key = call.authority.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), call])
  }

  type ReviewedGroup = {
    calls: AuthorityCall[]
    mode: 'direct' | 'safe' | 'relayr'
    pendingScope?: string
    recovered?: boolean
  }

  // Review every authority before submitting anything. Without this pass a
  // mixed-authority action could relay its first group and only then discover
  // that the connected wallet cannot authorize a later Safe/EOA group.
  const reviewedGroups: ReviewedGroup[] = []
  for (const group of groups.values()) {
    const authority = group[0].authority
    onProgress?.({
      kind: 'checking',
      message: `Checking authority on ${group.length} chain${
        group.length === 1 ? '' : 's'
      }…`,
    })
    const safeInfo = await Promise.all(
      group.map(call => fetchSafeInfo(call.chainId, authority)),
    )
    const safeCount = safeInfo.filter(Boolean).length

    if (safeCount > 0 && safeCount !== group.length) {
      const missing = group
        .filter((_, index) => !safeInfo[index])
        .map(call => JB_CHAINS[call.chainId]?.name ?? `${call.chainId}`)
      throw new Error(
        `This Safe is not deployed on ${missing.join(', ')}. Deploy the same Safe there from the Account card, or deselect those chains.`,
      )
    }

    if (safeCount === group.length) {
      const unavailable = group.filter((_, index) => {
        const info = safeInfo[index]
        return !info?.owners.some(
          owner => owner.toLowerCase() === connected.toLowerCase(),
        )
      })
      if (unavailable.length) {
        throw new Error(
          `The connected wallet is not a signer of ${authority} on ${unavailable
            .map(call => JB_CHAINS[call.chainId]?.name ?? `${call.chainId}`)
            .join(', ')}. Switch to a signer that belongs to every selected Safe.`,
        )
      }
      reviewedGroups.push({ calls: group, mode: 'safe' })
      continue
    }

    if (connected.toLowerCase() !== authority.toLowerCase()) {
      throw new Error(
        `The connected wallet is not the authority on ${group
          .map(call => JB_CHAINS[call.chainId]?.name ?? `${call.chainId}`)
          .join(', ')}. Switch to ${authority}.`,
      )
    }
    // Relaying is decided PER GROUP, so the multi-chain test has to be too:
    // measured across every call, a single-chain EOA group inside a mixed
    // EOA+Safe action would pay Relayr for something it can send itself.
    if (new Set(group.map(call => call.chainId)).size <= 1) {
      reviewedGroups.push({ calls: group, mode: 'direct' })
      continue
    }

    reviewedGroups.push({
      calls: group,
      mode: 'relayr',
      pendingScope: relayrCallsScope(toRelayrCalls(group)),
    })
  }

  const reportRelayrProgress = (progress: RelayrProgress) => {
    let message: string
    if (progress.phase === 'signing') {
      message = `Review and sign ${progress.current}/${progress.total} chain requests…`
    } else if (progress.phase === 'quoting') {
      message = 'Requesting a Relayr quote…'
    } else if (progress.phase === 'paying') {
      message = 'Review and confirm one Relayr payment…'
    } else if (progress.phase === 'payment-submitted') {
      message = `Relayr payment submitted (${progress.paymentHash.slice(0, 10)}…) · bundle ${progress.bundleUuid}. Do not pay again.`
    } else if (progress.phase === 'payment-confirmed') {
      message = `Relayr payment confirmed · bundle ${progress.bundleUuid}. Waiting for destination chains…`
    } else {
      const states = progress.records.map((record, index) => {
        const chainId = record.chain
        const chain =
          typeof chainId === 'number'
            ? JB_CHAINS[chainId as JBChainId]?.name ?? `Chain ${chainId}`
            : `Call ${index + 1}`
        const state = record.status?.state || 'Pending'
        return `${chain}: ${state}`
      })
      message = `Relayr bundle ${progress.bundleUuid} · ${progress.done}/${progress.total} confirmed${
        states.length ? ` · ${states.join(' · ')}` : ''
      }`
    }
    onProgress?.({ kind: 'relayr', message })
  }

  let relayrGroups = 0
  const directResults: Hex[] = []
  const relayrResults: AuthorityResult['relayrResults'] = []
  const safeResults: SafeCallResult[] = []

  // Recover an already-paid bundle before simulating current chain state. A
  // reload can happen after payment while Relayr is still executing; in that
  // case a fresh simulation may now revert and must not lead to a duplicate
  // quote or payment.
  for (const reviewed of reviewedGroups) {
    if (
      reviewed.mode !== 'relayr' ||
      !reviewed.pendingScope ||
      !loadRelayrPendingSession(reviewed.pendingScope)
    ) {
      continue
    }
    const recovered = await runRelayrCalls({
      calls: toRelayrCalls(reviewed.calls),
      account: connected,
      pendingScope: reviewed.pendingScope,
      onProgress: reportRelayrProgress,
    })
    relayrResults.push({
      bundleUuid: recovered.quote.bundle_uuid,
      paymentHash: recovered.paymentHash,
      records: recovered.records,
    })
    reviewed.recovered = true
    relayrGroups += 1
  }

  // Fail before collecting new signatures or a Relayr payment. An eth_call
  // from the real owner/operator address exercises the same authorization
  // branch as the eventual direct, forwarded, or Safe call without changing
  // state. Recovered bundles are deliberately excluded above.
  const callsToSimulate = reviewedGroups
    .filter(reviewed => !reviewed.recovered)
    .flatMap(reviewed => reviewed.calls)
  for (let index = 0; index < callsToSimulate.length; index++) {
    const call = callsToSimulate[index]
    const client = getPublicClient(wagmiConfig, {
      chainId: call.chainId,
    }) as PublicClient | undefined
    if (!client) {
      throw new Error(`No RPC client is configured for chain ${call.chainId}.`)
    }
    onProgress?.({
      kind: 'checking',
      message: `Checking ${index + 1}/${callsToSimulate.length} on ${
        JB_CHAINS[call.chainId]?.name ?? `chain ${call.chainId}`
      }…`,
    })
    try {
      await client.call({
        account: call.authority,
        to: call.target,
        data: call.data,
        value: call.value ?? 0n,
      })
      // Measure what the call actually needs and sign THAT, with headroom. The forwarder
      // caps the inner call at `request.gas` and reverts `execute` when the inner call
      // fails (OZ ERC2771Forwarder), so a hard-coded cap that turns out too small burns the
      // bundle AFTER the user has paid Relayr for it. Keep a larger builder
      // floor when one exists, but never let it suppress a higher live 2x
      // estimate. A failed estimate leaves the existing fallback untouched.
      try {
        const estimate = await client.estimateGas({
          account: call.authority,
          to: call.target,
          data: call.data,
          value: call.value ?? 0n,
        })
        const buffered = gasWithHeadroom(estimate)
        if (call.gas === undefined || call.gas < buffered) call.gas = buffered
      } catch {
        // Estimation is best-effort; the eth_call above is the real gate.
      }
    } catch (simulationError) {
      const detail =
        simulationError instanceof Error &&
        'shortMessage' in simulationError &&
        typeof simulationError.shortMessage === 'string'
          ? simulationError.shortMessage
          : simulationError instanceof Error
            ? simulationError.message.split('\n')[0]
            : 'The call would revert.'
      throw new Error(
        `${call.label ?? 'Action'} cannot run on ${
          JB_CHAINS[call.chainId]?.name ?? `chain ${call.chainId}`
        }: ${detail}`,
      )
    }
  }

  for (const reviewed of reviewedGroups) {
    if (reviewed.recovered) continue
    const group = reviewed.calls
    if (reviewed.mode === 'safe') {
      safeResults.push(
        ...(await runSafeCalls({
          signer: connected,
          calls: group.map(call => ({
            chainId: call.chainId,
            safe: call.authority,
            target: call.target,
            data: call.data,
            value: call.value,
            label: call.label,
            abi: call.abi,
            functionName: call.functionName,
            args: call.args,
            contractName: call.contractName,
          })),
          onProgress: message => onProgress?.({ kind: 'safe', message }),
        })),
      )
      continue
    }

    if (reviewed.mode === 'direct') {
      await requireTransactionReview({
        title: group.length === 1 ? 'Review transaction' : 'Review transactions',
        description:
          'These calls affect one chain, so they will be sent directly without Relayr.',
        calls: group.map(call => ({
          chainId: call.chainId,
          from: call.authority,
          to: call.target,
          data: call.data,
          value: call.value ?? 0n,
          label: call.label,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
          contractName: call.contractName,
        })),
      })

      for (let index = 0; index < group.length; index++) {
        const call = group[index]
        const { wallet, account } = await connectedWallet(call.chainId, {
          expected: call.authority,
          requireUnchanged: true,
          changedError:
            'Connected account changed. Review this project action again.',
        })
        const client = clientFor(call.chainId)
        onProgress?.({
          kind: 'direct',
          message: `Confirming ${index + 1}/${group.length} directly on ${
            JB_CHAINS[call.chainId]?.name ?? `chain ${call.chainId}`
          }…`,
        })
        await client.call({
          account,
          to: call.target,
          data: call.data,
          value: call.value ?? 0n,
        })
        const live = getAccount(wagmiConfig).address
        if (!live || live.toLowerCase() !== call.authority.toLowerCase()) {
          throw new Error(
            'Connected account changed. Review this project action again.',
          )
        }
        const hash = await wallet.sendTransaction({
          account,
          to: call.target,
          data: call.data,
          value: call.value ?? 0n,
          gas: call.gas,
        })
        const receipt = await waitForTrackedReceipt(client, hash)
        if (receipt.status !== 'success') {
          throw new Error(
            `${call.label ?? 'Project action'} reverted on ${
              JB_CHAINS[call.chainId]?.name ?? `chain ${call.chainId}`
            }.`,
          )
        }
        directResults.push(hash)
      }
      continue
    }

    const pendingScope = reviewed.pendingScope
    if (!pendingScope) {
      throw new Error('Relayr authority review is incomplete.')
    }
    // Built AFTER the simulation pass above, so each call carries its
    // measured `gas` into the signed ForwardRequest.
    const relayrResult = await runRelayrCalls({
      calls: toRelayrCalls(reviewed.calls),
      account: connected,
      pendingScope,
      onProgress: reportRelayrProgress,
    })
    relayrResults.push({
      bundleUuid: relayrResult.quote.bundle_uuid,
      paymentHash: relayrResult.paymentHash,
      records: relayrResult.records,
    })
    relayrGroups += 1
  }

  return { directResults, relayrGroups, relayrResults, safeResults }
}
