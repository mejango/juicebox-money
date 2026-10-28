'use client'

import { chainName } from '@/lib/urn'
import { getAccount, getPublicClient } from '@wagmi/core'
import {
  isAddress,
  isAddressEqual,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import {
  JBCoreContracts,
  jbV6ContractAddress,
  jbProjectsAbi,
  revOwnerAbi,
  RevnetCoreContracts,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { wagmiConfig } from '@/providers/Providers'
import { loadReviewEngine } from '@/lib/preload-review'
import { reviewedSendDeps } from '@/lib/reviewed-send'
import { captureWalletContext } from '@/lib/wallet-context'
import { assertNoViewAs } from '@/lib/viewAs'
import { requireHeldSettlement, reviewDescription, safeHoldNamespace, safeProposalKey, safeWriteHold } from '@/lib/write-holds'
import {
  gasWithinCap,
  simulateStateChangingTransaction,
  waitForTrackedReceipt,
  type ReviewedPlan,
  type WriteHoldClient,
} from '@bananapus/nana-sdk-core/review'
import {
  relayrRecordChain,
  relayrSupportsChains,
  type RelayrTransactionRecord,
} from '@bananapus/nana-sdk-core/review/relayr'
import {
  loadRelayrPendingSession,
  relayrCallsScope,
  relayrSessionAwaitsPayment,
  relayrTargetSupportsForwarder,
  runRelayrCalls,
  type RelayrCall,
  type RelayrProgress,
} from '@/lib/relayr'
import {
  hasSafeService,
  type SafeQueuedTransaction,
} from '@bananapus/nana-sdk-core/safe-service'
import {
  runSafeCalls,
  SAFE_SERVICE,
  type SafeCallResult,
} from '@/lib/safe'
import { readAuthorityIdentity } from '@bananapus/nana-sdk-core/safe'
import {
  readMatchingAuthorityIdentities,
  UnprovenSafeError,
} from '@/lib/cross-chain-authority'
import {
  findPendingSafeAppProposal,
  isSafeConnection,
  requireSafeProposalSuccess,
  SAFE_NONCE_GUIDANCE,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'

export type AuthorityCall = {
  /** Latest inclusion time for a prepared staged schedule. */
  deadline?: number
  chainId: JBChainId
  /**
   * Optional chain on which this authority's account type is authoritative.
   * Use this when a governance account controls a project on one chain but
   * the requested call executes elsewhere (for example, JBProjectHandles on
   * mainnet). A source-chain Safe must never fall through to the EOA path just
   * because its same-address proxy has not been deployed on the call chain.
   */
  detectionChainId?: JBChainId
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
  /** Re-prove mutable application authority around any open wallet review. */
  reverifyAuthority?: () => Promise<void>
  /** Persist recovery information before exposing a wallet submission. */
  onSending?: (kind: 'direct' | 'safe-connector') => Promise<void>
  /** Remove only the hashless intent when the final guard proves no wallet call occurred. */
  onBeforeSubmissionAborted?: () => Promise<void>
  onSubmitted?: (hash: Hex, kind: 'direct' | 'safe-connector') => Promise<void>
  onSafePrepared?: (tx: SafeQueuedTransaction) => Promise<void>
  /**
   * A direct send's hold key when a journal recovers it (a project batch's call):
   * held by it, and still by its exact call, as the last release held it.
   */
  holdNamespace?: string
}

export type AuthorityProgress = {
  kind: 'checking' | 'direct' | 'relayr' | 'safe'
  message: string
}

export type AuthorityResult = {
  directResults: Hex[]
  /** Destination identity for each direct or executed Safe-connector hash. */
  directResultDetails?: Array<{ chainId: JBChainId; hash: Hex }>
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
 * fails. Pass `indexedOnly` for revnets: the indexed address is only a
 * candidate, and the live REVOwner contract must confirm it as operator.
 */
export async function readAuthorityOf(
  client: PublicClient,
  deployment: {
    chainId: JBChainId
    projectId: number
    indexedAuthority: Address | null
  },
  {
    indexedOnly = false,
    indexedCandidates,
    strict = false,
    detectRevnet = false,
  }: {
    indexedOnly?: boolean
    indexedCandidates?: readonly Address[]
    strict?: boolean
    /** Classify a possible revnet from live JBProjects ownership. */
    detectRevnet?: boolean
  } = {},
): Promise<Address | null> {
  if (indexedOnly || detectRevnet) {
    const seen = new Set<string>()
    const candidates = [
      ...(indexedCandidates ?? []),
      ...(deployment.indexedAuthority ? [deployment.indexedAuthority] : []),
    ].flatMap(candidate => {
      if (!isAddress(candidate) || isAddressEqual(candidate, zeroAddress)) {
        return []
      }
      const key = candidate.toLowerCase()
      if (seen.has(key)) return []
      seen.add(key)
      return [candidate]
    })
    try {
      const owner = (await client.readContract({
        address: jbV6ContractAddress[JBCoreContracts.JBProjects][
          deployment.chainId
        ],
        abi: jbProjectsAbi,
        functionName: 'ownerOf',
        args: [BigInt(deployment.projectId)],
      })) as Address
      const canonicalRevOwner = jbV6ContractAddress[
        RevnetCoreContracts.REVOwner
      ][deployment.chainId] as Address | undefined
      if (
        !canonicalRevOwner ||
        !isAddressEqual(owner, canonicalRevOwner)
      ) {
        return owner
      }
      if (!candidates.length) return null
      const live = await Promise.all(
        candidates.map(candidate =>
          client.readContract({
            address: canonicalRevOwner,
            abi: revOwnerAbi,
            functionName: 'isOperatorOf',
            args: [BigInt(deployment.projectId), candidate],
          }),
        ),
      )
      const verified = candidates.filter((_, index) => live[index])
      return verified.length === 1 ? verified[0] : null
    } catch {
      return null
    }
  }
  return (await client
    .readContract({
      address: jbV6ContractAddress[JBCoreContracts.JBProjects][
        deployment.chainId
      ],
      abi: jbProjectsAbi,
      functionName: 'ownerOf',
      args: [BigInt(deployment.projectId)],
    })
    .catch(() => (strict ? null : deployment.indexedAuthority))) as Address | null
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
    return `Safe action recorded${queued ? ` | ${queued} queued` : ''}${
      waiting ? ` | ${waiting} awaiting more approvals` : ''
    }${submitted ? ` | ${submitted} submitted and awaiting confirmation` : ''}${
      executed ? ` | ${executed} executed` : ''
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
    deadline: call.deadline,
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
  paymentChainId,
  plan,
  signal,
}: {
  calls: AuthorityCall[]
  /**
   * The flow's: when it aborts, the wait for a Safe to execute what the run
   * proposed ends, and the proposal stays submitted.
   */
  signal: AbortSignal
  onProgress?: (progress: AuthorityProgress) => void
  /** Omit to ask the user to choose from the authenticated quote options. */
  paymentChainId?: number
  /**
   * A plan one review already showed these exact calls in (`reviewPlan`):
   * the direct and Safe-app sends spend it instead of asking again. Relay
   * and Safe signatures are still reviewed.
   */
  plan?: ReviewedPlan
}): Promise<AuthorityResult> {
  assertNoViewAs()
  if (!calls.length) throw new Error('Choose at least one chain.')
  const { address: connected, chainId: startChainId } = getAccount(wagmiConfig)
  if (!connected) throw new Error('Connect a wallet first.')
  const walletGuards = new Map(calls.map(call => [call, captureWalletContext(wagmiConfig, {
    account: call.authority, chainId: call.chainId,
  })]))

  const groups = new Map<string, AuthorityCall[]>()
  for (const call of calls) {
    const key = call.authority.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), call])
  }

  type ReviewedGroup = {
    calls: AuthorityCall[]
    mode: 'direct' | 'safe' | 'safe-connector' | 'relayr'
    pendingScope?: string
    recovered?: boolean
  }

  // Review every authority before submitting anything. Without this pass a
  // mixed-authority action could relay its first group and only then discover
  // that the connected wallet cannot authorize a later Safe/EOA group.
  const reviewedGroups: ReviewedGroup[] = []
  for (const group of groups.values()) {
    const savedScope = relayrCallsScope(toRelayrCalls(group))
    const saved = loadRelayrPendingSession(savedScope)
    if (saved && !relayrSessionAwaitsPayment(saved)) {
      reviewedGroups.push({ calls: group, mode: 'relayr', pendingScope: savedScope })
      continue
    }
    const authority = group[0].authority
    // A saved session's action rechecks only after the requests it published
    // are classified (ruling R114), in runRelayrCalls: a request that ran
    // would make the recheck refuse first.
    if (!saved) await Promise.all(group.map(call => call.reverifyAuthority?.()))
    onProgress?.({
      kind: 'checking',
      message: `Checking authority on ${group.length} chain${
        group.length === 1 ? '' : 's'
      }…`,
    })
    const authorityIdentities = await Promise.all(
      group.map(async call => {
        const client = getPublicClient(wagmiConfig, {
          chainId: call.chainId,
        }) as PublicClient | undefined
        if (!client) {
          throw new Error(
            `Could not verify the authority on ${chainName(call.chainId)}.`,
          )
        }
        const identity = await readAuthorityIdentity(client, authority)
        if (!identity) {
          throw new Error(
            `Could not verify the authority on ${chainName(call.chainId)}.`,
          )
        }
        return identity
      }),
    )
    const unsupported = group.filter(
      (_, index) => authorityIdentities[index].kind === 'contract',
    )
    if (unsupported.length) {
      throw new Error(
        `The project authority is an unsupported contract on ${unsupported
          .map(call => chainName(call.chainId))
          .join(', ')}. Only an EOA or a canonical Safe is supported.`,
      )
    }
    for (const call of group) {
      if (!call.detectionChainId || call.detectionChainId === call.chainId) {
        continue
      }
      const sourceClient = getPublicClient(wagmiConfig, {
        chainId: call.detectionChainId,
      }) as PublicClient | undefined
      const destinationClient = getPublicClient(wagmiConfig, {
        chainId: call.chainId,
      }) as PublicClient | undefined
      if (!sourceClient || !destinationClient) {
        throw new Error('Could not verify the cross-chain authority policy.')
      }
      const identities = await readMatchingAuthorityIdentities({
        sourceChainId: call.detectionChainId,
        sourceClient,
        destinationClient,
        authority,
        service: SAFE_SERVICE,
      })
      if (!identities) {
        throw new Error('Could not verify the cross-chain authority policy.')
      }
      if (identities.creationUnproven) {
        throw new UnprovenSafeError(call.chainId)
      }
      if (!identities.matches) {
        const sourceName =
          chainName(call.detectionChainId)
        const destinationName =
          chainName(call.chainId)
        if (
          identities.source.kind === 'safe' &&
          identities.destination.kind === 'eoa'
        ) {
          throw new Error(
            `This authority is a Safe on ${sourceName}, but the same Safe address is not deployed on ${destinationName}. Use “Deploy same Safe on Ethereum” in the project handle editor before retrying.`,
          )
        }
        if (
          identities.source.kind === 'safe' &&
          identities.destination.kind === 'delegated-eoa'
        ) {
          throw new Error(
            `This authority is a Safe on ${sourceName}, but its address on ${destinationName} is occupied by an EIP-7702 delegated EOA. It cannot be used as the same-address Safe.`,
          )
        }
        if (
          identities.source.kind === 'safe' &&
          identities.destination.kind === 'safe'
        ) {
          throw new Error(
            `The ${sourceName} and ${destinationName} Safes do not have the same current owners, threshold, and module-free policy. Align them before publishing this cross-chain handle claim.`,
          )
        }
        throw new Error(
          `This cross-chain handle claim cannot verify control of ${authority}. Only the same EOA on both chains or matching module-free Safes are supported.`,
        )
      }
    }
    const safeCount = authorityIdentities.filter(
      identity => identity.kind === 'safe',
    ).length

    if (safeCount > 0 && safeCount !== group.length) {
      const missing = group
        .filter((_, index) => authorityIdentities[index].kind !== 'safe')
        .map(call => chainName(call.chainId))
      throw new Error(
        `This Safe is not deployed on ${missing.join(', ')}. Deploy the same Safe there from the Account card, or deselect those chains.`,
      )
    }

    if (safeCount === group.length) {
      if (
        isSafeConnection(wagmiConfig) &&
        connected.toLowerCase() === authority.toLowerCase()
      ) {
        if (group.length !== 1) {
          throw new Error(
            'The Safe app connector can submit one reviewed authority call at a time.',
          )
        }
        reviewedGroups.push({ calls: group, mode: 'safe-connector' })
        continue
      }
      const unavailable = group.filter((_, index) => {
        const identity = authorityIdentities[index]
        return identity.kind !== 'safe' || !identity.owners.some(
          owner => owner.toLowerCase() === connected.toLowerCase(),
        )
      })
      if (unavailable.length) {
        throw new Error(
          `The connected wallet is not a signer of ${authority} on ${unavailable
            .map(call => chainName(call.chainId))
            .join(', ')}. Switch to a signer that belongs to every selected Safe.`,
        )
      }
      reviewedGroups.push({ calls: group, mode: 'safe' })
      continue
    }

    if (connected.toLowerCase() !== authority.toLowerCase()) {
      throw new Error(
        `The connected wallet is not the authority on ${group
          .map(call => chainName(call.chainId))
          .join(', ')}. Switch to ${authority}.`,
      )
    }
    // Relaying is decided PER GROUP, so the multi-chain test has to be too:
    // measured across every call, a single-chain EOA group inside a mixed
    // EOA+Safe action would pay Relayr for something it can send itself.
    const uniqueChains = new Set(group.map(call => call.chainId))
    const pendingScope = relayrCallsScope(toRelayrCalls(group))
    if (!loadRelayrPendingSession(pendingScope) && (
      uniqueChains.size <= 1 || uniqueChains.size !== group.length ||
      !relayrSupportsChains(group.map(call => call.chainId)) ||
      !(await Promise.all(toRelayrCalls(group).map(relayrTargetSupportsForwarder))).every(Boolean)
    )) {
      // Direct writes have no durable per-call recovery journal. Sending more
      // than one would let a retry replay an earlier confirmed call after a
      // later destination failed, including repeated calls on one chain.
      if (group.length !== 1) {
        throw new Error(
          'These calls cannot share one Relayr payment. Select one chain and one action at a time, and confirm each result before continuing.',
        )
      }
      reviewedGroups.push({ calls: group, mode: 'direct' })
      continue
    }

    reviewedGroups.push({
      calls: group,
      mode: 'relayr',
      pendingScope,
    })
  }

  const reportRelayrProgress = (progress: RelayrProgress) => {
    let message: string
    if (progress.phase === 'signing') {
      message = `Review and sign ${progress.current}/${progress.total} chain requests…`
    } else if (progress.phase === 'quoting') {
      message = 'Getting payment options…'
    } else if (progress.phase === 'paying') {
      message = 'Review and confirm one payment…'
    } else if (progress.phase === 'payment-submitted') {
      message = `Payment submitted (${progress.paymentHash.slice(0, 10)}…) | bundle ${progress.bundleUuid}. Do not pay again.`
    } else if (progress.phase === 'payment-confirmed') {
      message = `Payment confirmed | bundle ${progress.bundleUuid}. Waiting for destination chains…`
    } else {
      const states = progress.records.map((record, index) => {
        const chainId = relayrRecordChain(record)
        const chain =
          typeof chainId === 'number'
            ? chainName(chainId)
            : `Call ${index + 1}`
        const state = record.status?.state || 'Pending'
        return `${chain}: ${state}`
      })
      message = `Bundle ${progress.bundleUuid} | Reported status: ${progress.done}/${progress.total} complete; checking onchain${
        states.length ? ` | ${states.join(' | ')}` : ''
      }`
    }
    onProgress?.({ kind: 'relayr', message })
  }

  let relayrGroups = 0
  const directResults: Hex[] = []
  const directResultDetails: NonNullable<AuthorityResult['directResultDetails']> = []
  const relayrResults: AuthorityResult['relayrResults'] = []
  const safeResults: SafeCallResult[] = []

  const reverifyRelayrGroup = async (group: AuthorityCall[]) => {
    for (const call of group) {
      await call.reverifyAuthority?.()
      const live = getAccount(wagmiConfig).address
      if (!live || live.toLowerCase() !== call.authority.toLowerCase()) {
        throw new Error(
          'Connected account changed. Review this project action again.',
        )
      }
      await simulateStateChangingTransaction(clientFor(call.chainId), {
        from: call.authority,
        to: call.target,
        data: call.data,
        value: call.value ?? 0n,
        gas: call.gas,
      })
    }
  }

  // Recover an already-paid bundle before simulating current chain state. A
  // reload can happen after payment while Relayr is still executing; in that
  // case a fresh simulation may now revert and must not lead to a duplicate
  // quote or payment.
  for (const reviewed of reviewedGroups) {
    const pending = reviewed.mode === 'relayr' && reviewed.pendingScope
      ? loadRelayrPendingSession(reviewed.pendingScope)
      : null
    if (!pending) continue
    const recovered = await runRelayrCalls({
      calls: toRelayrCalls(reviewed.calls),
      account: connected,
      pendingScope: reviewed.pendingScope,
      onProgress: reportRelayrProgress,
      paymentChainId,
      preferredPaymentChainId: startChainId,
      // A paid bundle is proven first; its calls are rechecked only once every
      // request expired unused, before they are signed again (ruling R114).
      reverify: () => reverifyRelayrGroup(reviewed.calls),
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
        chainName(call.chainId)
      }…`,
    })
    try {
      await call.reverifyAuthority?.()
      await simulateStateChangingTransaction(client, {
        from: call.authority,
        to: call.target,
        data: call.data,
        value: call.value ?? 0n,
        gas: call.gas,
      })
      // A builder cap bounds the raw preflight above against a
      // target-controlled contract; it is not the cost of the call, and a
      // wallet asked to reserve the whole cap rejects accounts that can
      // comfortably afford the transaction. Measure inside the cap, so the
      // estimator is never unbounded and the sent limit is the real one.
      call.gas = await gasWithinCap(
        client,
        {
          account: call.authority,
          to: call.target,
          data: call.data,
          value: call.value ?? 0n,
        },
        call.gas,
      )
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
          chainName(call.chainId)
        }: ${detail}`,
      )
    }
  }

  for (const reviewed of reviewedGroups) {
    if (reviewed.recovered) continue
    const group = reviewed.calls
    if (reviewed.mode === 'safe-connector') {
      const call = group[0]
      await call.reverifyAuthority?.()
      // A retry confirms the exact proposal already queued instead of
      // proposing it twice; a chain without Safe's service has no queue.
      const existing = hasSafeService(call.chainId)
        ? await findPendingSafeAppProposal(
            clientFor(call.chainId),
            call.chainId,
            call.authority,
            { to: call.target, data: call.data, value: call.value },
            SAFE_SERVICE,
          )
        : null
      if (existing) {
        await call.onSafePrepared?.(existing.tx)
        safeResults.push({
          chainId: call.chainId,
          mode: 'service',
          status: 'queued',
          nonce: existing.tx.nonce,
          safeTxHash: existing.proposalHash,
        })
        onProgress?.({
          kind: 'safe',
          message: 'This proposal is waiting in your Safe. Finish it there first.',
        })
        continue
      }
      onProgress?.({
        kind: 'safe',
        message: 'Continue in Safe, then execute the proposal…',
      })
      // Core reviews (or spends the parent plan) and proposes the exact call
      // under the same hold the tracking below reads.
      const sentCall = { to: call.target, data: call.data, value: call.value ?? 0n }
      const { sendReviewed } = await loadReviewEngine()
      const proposed = await sendReviewed({
        account: call.authority,
        calls: [{
          chainId: call.chainId, ...sentCall,
          label: call.label, abi: call.abi, functionName: call.functionName, args: call.args, contractName: call.contractName,
          intent: safeHoldNamespace(safeProposalKey(call.chainId, call.authority, sentCall)),
        }],
        title: 'Review Safe transaction',
        description: reviewDescription(`This exact call will continue in Safe. ${SAFE_NONCE_GUIDANCE}`),
        confirmLabel: 'Agree & continue to Safe',
        ...(plan ? { plan } : {}),
        guard: assertNoViewAs,
        reverify: async () => {
          await call.reverifyAuthority?.()
          walletGuards.get(call)!()
          if (!isSafeConnection(wagmiConfig)) throw new Error('Safe connection changed. Review this project action again.')
        },
        assertWriteState: () => {
          walletGuards.get(call)!()
          if (!isSafeConnection(wagmiConfig)) throw new Error('Safe connection changed. Review this project action again.')
        },
        beforeWallet: () => call.onSending?.('safe-connector'),
        onUnsent: () => call.onBeforeSubmissionAborted?.(),
      }, reviewedSendDeps)
      if (proposed.status !== 'proposed') throw new Error('Safe connection changed. Review this project action again.')
      const safeTxHash = proposed.safeTxHash
      const hold = safeWriteHold(call.chainId, call.authority, sentCall)
      const holdClient = clientFor(call.chainId) as unknown as WriteHoldClient
      await call.onSubmitted?.(safeTxHash, 'safe-connector')
      let executionHash: Hex
      try {
        executionHash = await waitForSafeExecutionHash(call.chainId, safeTxHash, { signal })
      } catch (error) {
        // The wait ended without an execution: unless the flow ended it, the hold takes it as
        // unproven and offers its exit (HeldWritesNotice lists it).
        if (!signal.aborted) await hold.onUnproven(holdClient, safeTxHash).catch(() => null)
        throw error
      }
      const receipt = await waitForTrackedReceipt(
        clientFor(call.chainId),
        executionHash,
      )
      const failure = `${call.label ?? 'Project action'} reverted after Safe execution.`
      if (receipt.status !== 'success') {
        void hold.onReceipt(receipt, holdClient, { calls: [sentCall] }).catch(() => {})
        throw new Error(failure)
      }
      try {
        await requireSafeProposalSuccess(
          {
            client: clientFor(call.chainId),
            receipt,
            safe: call.authority,
            proposalHash: safeTxHash,
            calls: [{ to: call.target, data: call.data, value: call.value }],
          },
          failure,
        )
      } catch (error) {
        // The hold settles a failure at finality, or keeps an unproven one, on its own evidence.
        void hold.onReceipt(receipt, holdClient, { calls: [sentCall] }).catch(() => {})
        throw error
      }
      await requireHeldSettlement(hold, holdClient, receipt, { calls: [sentCall] })
      directResults.push(executionHash)
      directResultDetails.push({ chainId: call.chainId, hash: executionHash })
      continue
    }
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
            reverifyAuthority: call.reverifyAuthority,
            onSafePrepared: call.onSafePrepared,
          })),
          onProgress: message => onProgress?.({ kind: 'safe', message }),
          signal,
        })),
      )
      continue
    }

    if (reviewed.mode === 'direct') {
      // Core reviews the group once (or spends the parent plan), then sends,
      // simulates, holds and waits on each call in order.
      const { sendReviewed, HELD_CONFIRMING_LINE } = await loadReviewEngine()
      const exactOf = (call: AuthorityCall) => ({ to: call.target, data: call.data, value: call.value ?? 0n })
      /** The call core is sending now, for the final gate. */
      let current = group[0]
      const assertDirect = () => {
        walletGuards.get(current)!()
        if (isSafeConnection(wagmiConfig)) throw new Error('Connected wallet changed. Review this project action again.')
      }
      const result = await sendReviewed({
        account: group[0].authority,
        calls: group.map(call => ({
          chainId: call.chainId, ...exactOf(call),
          // ponytail: under a parent plan the reviewed calls carry no gas, so
          // core estimates at send; the cap-bounded measure applies to a direct review.
          ...(plan ? {} : { gas: call.gas }),
          label: call.label, abi: call.abi, functionName: call.functionName, args: call.args, contractName: call.contractName,
          ...(call.holdNamespace ? { intent: call.holdNamespace, legacy: [{ call: exactOf(call) }] } : {}),
        })),
        title: group.length === 1 ? 'Review transaction' : 'Review transactions',
        description: reviewDescription('Confirm each transaction on its destination chain. Calls are sent in the displayed order.'),
        ...(plan ? { plan } : {}),
        guard: assertNoViewAs,
        reverify: async (_sent, step) => {
          const call = group[step]
          onProgress?.({
            kind: 'direct',
            message: `Confirming ${step + 1}/${group.length} directly on ${chainName(call.chainId)}…`,
          })
          current = call
          await call.reverifyAuthority?.()
          assertDirect()
        },
        assertWriteState: assertDirect,
        beforeWallet: (_sent, step) => group[step].onSending?.('direct'),
        onUnsent: (_sent, step) => group[step].onBeforeSubmissionAborted?.(),
        onSubmitted: (_sent, step, hash) => group[step].onSubmitted?.(hash, 'direct'),
        // A step still confirming is followed in the run, which then goes on to the next call.
        follow: { onConfirming: () => onProgress?.({ kind: 'direct', message: HELD_CONFIRMING_LINE }) },
      }, reviewedSendDeps)
      if (result.status !== 'done') throw new Error('Connected wallet changed. Review this project action again.')
      directResults.push(...result.hashes)
      directResultDetails.push(...result.hashes.map(hash => ({ chainId: group[0].chainId, hash })))
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
      paymentChainId,
      preferredPaymentChainId: startChainId,
      pendingScope,
      onProgress: reportRelayrProgress,
      reverify: () => reverifyRelayrGroup(reviewed.calls),
    })
    relayrResults.push({
      bundleUuid: relayrResult.quote.bundle_uuid,
      paymentHash: relayrResult.paymentHash,
      records: relayrResult.records,
    })
    relayrGroups += 1
  }

  return { directResults, relayrGroups, relayrResults, safeResults, ...(directResultDetails.length ? { directResultDetails } : {}) }
}
