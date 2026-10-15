'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import {
  CREATE_BATCH_ABI,
  SAFE_CREATE_ABI,
  buildSafeDeploymentTx,
  verifySafeDeployments,
} from '@bananapus/nana-sdk-core/safe'
import { getAccount, waitForTransactionReceipt } from '@wagmi/core'
import {
  decodeFunctionResult,
  encodeFunctionData,
  isAddressEqual,
  type Address,
  type Hex,
} from 'viem'
import { wagmiConfig } from '@/providers/Providers'
import type { LaunchPlan } from '@/lib/launch'
import { checkLaunchMultisigs, launchMultisigReview, verifyCreatedLaunchMultisigs } from '@/lib/launch-multisig'
import { loadLaunchSession, saveLaunchSession, type LaunchChainStatus, type LaunchSession } from '@/lib/launch-session'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { requireContractTransactionReview } from '@/lib/transaction-review'
import {
  gasWithHeadroom,
  isDefiniteWalletRejection,
  simulateStateChangingTransaction,
  TRANSACTION_SIMULATION_GAS,
  writeIntentKey,
  intent,
  type SavedAttempt,
  type WriteHoldClient,
} from '@bananapus/nana-sdk-core/review'
import { isSafeConnection, readSafeAppExecution, SAFE_NONCE_GUIDANCE, SAFE_PROPOSAL_UNCONFIRMED, waitForSafeExecutionHash } from '@/lib/safe-connector'
import { publicClient } from '@/lib/wallet-core'
import { captureWalletContext } from '@/lib/wallet-context'
import { recoverSaved, requireHeldSettlement, SavedAttemptShownError, strictRetirable, writeHolds } from '@/lib/write-holds'

type Setup = NonNullable<LaunchChainStatus['multisigSetup']>
type LaunchMultisigSetupRequest = ReturnType<typeof buildSafeDeploymentTx> & {
  account: Address
  gas: bigint
}

type PrepareOptions = {
  chainId: number
  salt: Hex
  plan: LaunchPlan
  account: Address
  switchChain: (chainId: number) => Promise<unknown>
  writeContract: (request: LaunchMultisigSetupRequest) => Promise<Hex>
  onProgress: (message: string) => void
  onSetup?: (setup: Setup) => void
  /**
   * The page's: when it aborts, the wait for a Safe to execute the setup ends,
   * the setup stays confirming with its proposal, and the launch lock is let
   * go.
   */
  signal: AbortSignal
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return `${item}#bigint`
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    }
    return item
  })
}

async function withLaunchLock<T>(action: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('jbm-launch', { ifAvailable: true }, lock => {
      if (!lock) throw new Error('Another tab is updating this launch. Continue there or close it first.')
      return action()
    })
  }
  return action()
}


/** A launch's Safe setup on one chain: held by its launch (salt) and sender. No SDK builder covers it. */
export function setupNamespace(chainId: number, account: Address, salt: Hex): string {
  return writeIntentKey('launch-safe-setup', { chainId, account: intent.address(account), salt: intent.hex(salt) })
}

/**
 * A chain's saved Safe setup as the SDK's saved-attempt recovery reads it: only
 * what the journal saved. Its domain check is the setup's own receipt creating
 * every planned Safe; the journal's strict re-read is the final say before a
 * check or exit retires it.
 */
export function setupAttemptOf(chainId: number, salt: Hex, account: Address, plan: LaunchPlan, setup: Setup): SavedAttempt<true> {
  const client = publicClient(chainId as JBChainId)
  const request = buildSafeDeploymentTx(chainId, plan.multisigs!)
  const attempt: SavedAttempt<true> = {
    chainId,
    account,
    safe: !!setup.safe,
    namespaces: [setupNamespace(chainId, account, salt)],
    // The exact setup call: a saved hash the hold doesn't know (the last release held none) is adopted against it.
    call: { to: request.address, data: encodeFunctionData(request), value: request.value ?? 0n },
    saved: {
      started: true,
      ...(setup.safeProposalHash ? { safeTxHash: setup.safeProposalHash } : setup.txHash ? { hash: setup.txHash } : {}),
    },
    async authenticate(hash) {
      if (!hash) return { result: 'unknown' }
      const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
      if (!receipt) return { result: 'unknown' }
      if (receipt.status !== 'success') return { result: 'not-this', reason: 'Safe creation reverted.' }
      return await verifySafeDeployments(client, plan.multisigs!).then(() => ({ result: 'proven' as const, value: true as const }), () => ({ result: 'unknown' as const }))
    },
    confirmRetirable: strictRetirable(() => attempt, () => {
      const session = loadLaunchSession({ strict: true })
      const now = session?.salt === salt ? session.statuses[chainId]?.multisigSetup : undefined
      return !!now && now.phase !== 'done'
    }),
  }
  return attempt
}

function requireSession(chainId: number, salt: Hex): LaunchSession {
  const session = loadLaunchSession({ strict: true })
  if (!session || session.salt !== salt || !session.chains.includes(chainId) || session.transport === 'relayr') {
    throw new Error('The saved launch changed. Recover the original launch before creating its Safe.')
  }
  return session
}

/** Keep Safe creation separate from the launch so direct calls retain their original sender. */
export async function prepareLaunchMultisigs(options: PrepareOptions): Promise<void> {
  if (!options.plan.multisigs?.length) return
  const assertWalletContext = captureWalletContext(wagmiConfig, { account: options.account, chainId: options.chainId })
  const safe = isSafeConnection(wagmiConfig)
  return withLaunchLock(async () => {
    const { chainId, salt, account, onProgress, onSetup } = options
    const plan = structuredClone(options.plan)
    const expectedPlan = fingerprint(plan)
    let revertedProjectHash: Hex | undefined
    const read = (checkReverted = false) => {
      const session = requireSession(chainId, salt)
      if (!session.account || !isAddressEqual(session.account, account) || fingerprint(session.plans[chainId]) !== expectedPlan) {
        throw new Error('The saved Safe or launch account changed. Recover the original launch before continuing.')
      }
      const status = session.statuses[chainId]
      const retryReverted = status?.phase === 'failed' && status.txHash &&
        (checkReverted || status.txHash === revertedProjectHash)
      if ((status?.txHash && !retryReverted) || status?.safeProposalHash || status?.phase === 'done' || status?.unverifiedSend) {
        throw new Error('A project launch may already have been submitted. Recover it before creating its Safe.')
      }
      return session
    }
    const persist = (setup: Setup) => {
      const session = read()
      session.statuses[chainId] = { ...session.statuses[chainId], multisigSetup: setup }
      if (!saveLaunchSession(session)) {
        throw new Error('Safe setup progress could not be saved. Restore browser storage before continuing.')
      }
      onSetup?.(setup)
    }
    const client = publicClient(chainId as JBChainId)
    // Recovery runs first (invariant A): a saved setup submission is recovered by the SDK from
    // what the journal saved alone, before any read or preparation.
    let recovered: Hex | undefined
    const saved = read(true).statuses[chainId]?.multisigSetup
    if (saved?.phase === 'signing' || saved?.phase === 'confirming') {
      const attempt = setupAttemptOf(chainId, salt, account, plan, saved)
      const outcome = await recoverSaved(attempt, client as unknown as WriteHoldClient)
      if (outcome.status === 'done' && outcome.result === 'success') {
        if (!outcome.hash) throw new SavedAttemptShownError(attempt as SavedAttempt<unknown>, 'Safe creation went through. It is still confirming.')
        recovered = outcome.hash
        persist({ phase: 'confirming', txHash: recovered, ...(saved.safe ? { safe: true as const } : {}) })
      } else {
        // A proven revert, or retired (the user's exit or check, a definite rejection): nothing is out.
        persist({ phase: 'failed' })
      }
    }
    const priorLaunch = read(true).statuses[chainId]
    if (priorLaunch?.phase === 'failed' && priorLaunch.txHash) {
      const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: chainId as JBChainId, hash: priorLaunch.txHash })
      if (receipt.status !== 'reverted') {
        throw new Error('The previous project launch did not revert. Recover it before trying again.')
      }
      revertedProjectHash = priorLaunch.txHash
    }
    const prior = read().statuses[chainId]?.multisigSetup
    await checkLaunchMultisigs(client, plan)

    let hash = recovered
    let proposal: Hex | undefined
    if (!hash) {
      if (await verifySafeDeployments(client, plan.multisigs!, { allowMissing: true })) {
        persist({ phase: 'done' })
        return
      }
      if (prior?.phase === 'done') {
        throw new Error('The previously created Safe could not be verified. Check the original setup transaction before continuing.')
      }
      const request = buildSafeDeploymentTx(chainId, plan.multisigs!)
      // Held by the SDK's write hold from just before the wallet opens until it settles.
      const hold = writeHolds.open({
        chainId, account, safe, namespace: setupNamespace(chainId, account, salt),
        call: { to: request.address, data: encodeFunctionData(request), value: request.value ?? 0n },
      })
      let walletInvoked = false
      try {
        onProgress('Review Safe creation')
        hash = await hold.send<Hex>(client as unknown as WriteHoldClient, gate => submitReviewedContractWrite({
          request,
          expectedAccount: account,
          // A Safe app signs the sent gas as safeTxGas; 0 makes a failed call revert.
          review: reviewed => requireContractTransactionReview({ ...reviewed, account, ...(safe ? { safeTxGas: 0n } : {}) }, {
            title: 'Review Safe creation',
            label: `Create ${plan.flavor === 'revnet' ? 'Operator' : 'Owner'} Safe`,
            description: [launchMultisigReview(plan), safe ? SAFE_NONCE_GUIDANCE : null].filter(Boolean).join('\n\n'),
            contractName: 'Multicall3',
            ...(safe ? { confirmLabel: 'Agree & continue to Safe' } : {}),
          }),
          switchChain: options.switchChain,
          currentAccount: () => getAccount(wagmiConfig).address,
          reverify: async () => { read(); await checkLaunchMultisigs(client, plan) },
          simulate: async reviewed => {
            const data = encodeFunctionData(reviewed)
            const result = await simulateStateChangingTransaction(client, {
              from: account, to: reviewed.address, data, value: reviewed.value,
            })
            const calls = decodeFunctionResult({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', data: result })
            if (calls.length !== plan.multisigs!.length) throw new Error('Safe setup simulation returned an unexpected result.')
            for (const [index, call] of calls.entries()) {
              if (call.success) {
                if (call.returnData.length !== 66) throw new Error('Safe setup simulation returned an invalid address.')
                const created = decodeFunctionResult({ abi: SAFE_CREATE_ABI, functionName: 'createProxyWithNonce', data: call.returnData })
                if (!isAddressEqual(created, plan.multisigs![index].address)) throw new Error('Safe setup simulation returned a different Safe address.')
              } else {
                await verifySafeDeployments(client, [plan.multisigs![index]])
              }
            }
            const estimate = await client.estimateGas({ account, to: reviewed.address, data, value: reviewed.value, gas: TRANSACTION_SIMULATION_GAS })
            const gas = gasWithHeadroom(estimate)
            return { ...reviewed, chainId, account, gas: safe ? 0n : gas > TRANSACTION_SIMULATION_GAS ? TRANSACTION_SIMULATION_GAS : gas }
          },
          beforeSend: () => {
            assertWalletContext()
            if (isSafeConnection(wagmiConfig) !== safe) throw new Error('Wallet connection changed. Review Safe creation again.')
          },
          beforeWrite: async () => {
            await gate.beforeSend()
            try {
              read()
              persist({ phase: 'signing', ...(safe ? { safe: true as const } : {}) })
            } catch (error) {
              gate.onRejected()
              throw error
            }
          },
          onWriteRejected: () => gate.onRejected(),
          onBeforeWriteAborted: () => gate.onRejected(),
          onWriteSubmitted: submitted => gate.afterSubmit(submitted),
          write: simulated => {
            // The shared synchronous guard runs after the durable marker and
            // its callbacks, immediately before this wallet invocation.
            walletInvoked = true
            return options.writeContract(simulated)
          },
          accountChangedError: 'Connected account changed. Review Safe creation again.',
        }))
      } catch (error) {
        if (!walletInvoked || isDefiniteWalletRejection(error)) persist({ phase: 'failed' })
        throw error
      }
      if (!/^0x[0-9a-fA-F]{64}$/u.test(hash)) {
        throw new Error('The wallet returned no valid Safe setup hash. Check your wallet before trying again.')
      }
      proposal = safe ? hash : undefined
      persist({ phase: 'confirming', txHash: hash, ...(proposal ? { safe: true, safeProposalHash: proposal } : {}) })
    }
    if (proposal) {
      onProgress('Waiting for Safe owners to approve creation')
      hash = await waitForSafeExecutionHash(chainId, proposal, { signal: options.signal })
      persist({ phase: 'confirming', txHash: hash, safe: true, safeProposalHash: proposal })
    }
    onProgress('Confirming Safe creation')
    const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: chainId as JBChainId, hash: hash! })
    if (proposal) {
      const request = buildSafeDeploymentTx(chainId, plan.multisigs!)
      const { status } = await readSafeAppExecution({
        client, receipt, safe: account, proposalHash: proposal,
        calls: [{ to: request.address, data: encodeFunctionData(request), value: request.value }],
        batch: false,
      })
      if (status === 'failed') {
        persist({ phase: 'failed', txHash: hash })
        throw new Error('Safe creation failed inside the Safe. Review the setup before trying again.')
      }
      if (status !== 'success') throw new Error(SAFE_PROPOSAL_UNCONFIRMED)
    } else if (receipt.status !== 'success') {
      persist({ phase: 'failed', txHash: hash })
      throw new Error('Safe creation reverted. Review the setup before trying again.')
    }
    await verifyCreatedLaunchMultisigs(client, plan, receipt.blockNumber)
    // Its proof reaches the hold, which settles it.
    const setupCall = buildSafeDeploymentTx(chainId, plan.multisigs!)
    await requireHeldSettlement(writeHolds.open({
      chainId, account, safe: !!proposal, namespace: setupNamespace(chainId, account, salt),
      call: { to: setupCall.address, data: encodeFunctionData(setupCall), value: setupCall.value ?? 0n },
    }), client as unknown as WriteHoldClient, receipt, proposal ? { calls: [{ to: setupCall.address, data: encodeFunctionData(setupCall), value: setupCall.value ?? 0n }] } : undefined).catch(() => null)
    persist({ phase: 'done', txHash: hash })
  })
}

/**
 * The SDK retired a chain's saved Safe setup (the user's exit or check): the
 * journal records that nothing is out, so the launch prepares its setup again.
 */
export async function retireLaunchMultisigSetup(chainId: number, salt: Hex): Promise<void> {
  return withLaunchLock(async () => {
    const session = requireSession(chainId, salt)
    const status = session.statuses[chainId]
    const setup = status?.multisigSetup
    if (setup?.phase !== 'signing' && setup?.phase !== 'confirming') return
    status.multisigSetup = { phase: 'failed' }
    if (!saveLaunchSession(session)) throw new Error('Safe recovery could not be saved. Restore browser storage before continuing.')
  })
}
