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
import { gasWithHeadroom } from '@/lib/gas'
import { isSafeConnection, waitForSafeExecutionHash } from '@/lib/safe-connector'
import { publicClient } from '@/lib/wallet-core'
import { simulateStateChangingTransaction, TRANSACTION_SIMULATION_GAS } from '@/lib/transaction-simulation'

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

function walletRejected(error: unknown): boolean {
  let current = error
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const item = current as { code?: unknown; name?: unknown; cause?: unknown }
    if (item.code === 4001 || item.name === 'UserRejectedRequestError') return true
    current = item.cause
  }
  return false
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

    let hash = prior?.phase === 'confirming' ? prior.txHash : undefined
    let proposal = prior?.phase === 'confirming' ? prior.safeProposalHash : undefined
    if (!hash && !proposal) {
      if (await verifySafeDeployments(client, plan.multisigs!, { allowMissing: true })) {
        persist({ phase: 'done' })
        return
      }
      if (prior?.phase === 'signing') {
        throw new Error('Safe creation may already have been submitted. Check your wallet and recover its hash before trying again.')
      }
      if (prior?.phase === 'done') {
        throw new Error('The previously created Safe could not be verified. Check the original setup transaction before continuing.')
      }
      const request = buildSafeDeploymentTx(chainId, plan.multisigs!)
      const safe = isSafeConnection(wagmiConfig)
      let walletInvoked = false
      try {
        onProgress('Review Safe creation')
        hash = await submitReviewedContractWrite({
          request,
          expectedAccount: account,
          review: reviewed => requireContractTransactionReview({ ...reviewed, account }, {
            title: 'Review Safe creation',
            label: `Create ${plan.flavor === 'revnet' ? 'Operator' : 'Owner'} Safe`,
            description: launchMultisigReview(plan),
            contractName: 'Multicall3',
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
            return { ...reviewed, account, gas: gas > TRANSACTION_SIMULATION_GAS ? TRANSACTION_SIMULATION_GAS : gas }
          },
          write: async simulated => {
            read()
            if (isSafeConnection(wagmiConfig) !== safe) throw new Error('Connected wallet changed. Review Safe creation again.')
            persist({ phase: 'signing', ...(safe ? { safe: true as const } : {}) })
            // Persist immediately before crossing the wallet boundary. A reload
            // or an ambiguous wallet error now requires explicit recovery.
            if (!getAccount(wagmiConfig).address || !isAddressEqual(getAccount(wagmiConfig).address!, account)) {
              throw new Error('Connected account changed. Review Safe creation again.')
            }
            walletInvoked = true
            return options.writeContract(simulated)
          },
          accountChangedError: 'Connected account changed. Review Safe creation again.',
        })
      } catch (error) {
        if (!walletInvoked || walletRejected(error)) persist({ phase: 'failed' })
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
      hash = await waitForSafeExecutionHash(chainId, proposal)
      persist({ phase: 'confirming', txHash: hash, safe: true })
    }
    onProgress('Confirming Safe creation')
    const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: chainId as JBChainId, hash: hash! })
    if (receipt.status !== 'success') {
      persist({ phase: 'failed', txHash: hash })
      throw new Error('Safe creation reverted. Review the setup before trying again.')
    }
    await verifyCreatedLaunchMultisigs(client, plan, receipt.blockNumber)
    persist({ phase: 'done', txHash: hash })
  })
}

/** A user supplies the original hash, or explicitly confirms no request was submitted. */
export async function recoverLaunchMultisigSetup(chainId: number, salt: Hex, hash?: Hex): Promise<void> {
  return withLaunchLock(async () => {
    const session = requireSession(chainId, salt)
    const status = session.statuses[chainId]
    const setup = status?.multisigSetup
    if (!session.plans[chainId].multisigs?.length || setup?.phase !== 'signing' || setup.txHash || setup.safeProposalHash) {
      throw new Error('There is no interrupted Safe creation to recover.')
    }
    if (hash !== undefined && !/^0x[0-9a-fA-F]{64}$/u.test(hash)) throw new Error('Enter a valid transaction or Safe proposal hash.')
    status.multisigSetup = hash
      ? { phase: 'confirming', txHash: hash, ...(setup.safe ? { safe: true, safeProposalHash: hash } : {}) }
      : { phase: 'failed' }
    if (!saveLaunchSession(session)) throw new Error('Safe recovery could not be saved. Restore browser storage before continuing.')
  })
}
