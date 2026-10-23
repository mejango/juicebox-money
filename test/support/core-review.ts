import { vi } from 'vitest'
import type { Address, Hex } from 'viem'
import { registerReviewHandler, type ReviewModel, type WalletAdapter } from '@bananapus/nana-sdk-core/review'

/**
 * Core's review prompt in a lib test: every model core shows is kept, and
 * `answer` decides it (confirm by default). Tests that render the app's
 * provider use `fake-wallet` instead.
 */
export const coreReviews = {
  shown: [] as ReviewModel[],
  answer: vi.fn(async (_model: ReviewModel) => true),
  reset() {
    coreReviews.shown = []
    coreReviews.answer.mockReset().mockImplementation(async () => true)
  },
}

registerReviewHandler(async prompt => {
  coreReviews.shown.push(prompt.model)
  return (await coreReviews.answer(prompt.model)) ? prompt.confirmation : null
})

/** The exact calls a model reviewed, as the wallet sends them. */
export const reviewedCalls = (model: ReviewModel) =>
  model.calls.map(({ chainId, to, data, value }) => ({ chainId, to, data, value }))

/** A wallet adapter over test doubles; anything not given refuses. */
export function testAdapter(over: Partial<WalletAdapter> & { account: () => Address | undefined }): WalletAdapter {
  const refuse = async (): Promise<Hex> => { throw new Error('This test wallet does not do that.') }
  return {
    kind: 'wallet',
    chainId: () => 1,
    isSafe: () => false,
    switchChain: async () => {},
    sendTransaction: refuse,
    signTypedData: refuse,
    signMessage: refuse,
    ...over,
  }
}

type Engine = typeof import('@bananapus/nana-sdk-core/review')

/**
 * Core's send and sign as a lib test needs them, over its own wallet doubles:
 * one prompt of core's model (`coreReviews`), then for each call the chain
 * switch, `reverify`, `beforeWallet`, the final gate,
 * the send and its receipt, telling the
 * action's callbacks as core does. A Safe app's first send is its proposal.
 * Core's own tests cover its holds, journals and simulations; this keeps a
 * jbm test on jbm's checks around them.
 */
export async function fakeEngine({ send, receipt, sign, safe = () => false, switchChain = async () => {}, hold }: {
  send: (call: import('@bananapus/nana-sdk-core/review').ReviewedCall) => Promise<Hex>
  receipt?: (hash: Hex, chainId: number) => Promise<import('viem').TransactionReceipt>
  sign?: (typedData: import('viem').TypedDataDefinition) => Promise<Hex>
  safe?: () => boolean
  /** Core moves the wallet to the call's chain before `reverify`. */
  switchChain?: (chainId: number) => Promise<void>
  /** Core's write hold over this client: each send is held under its intent, as core holds it. */
  hold?: { holds: import('@bananapus/nana-sdk-core/review').WriteHold; client: (chainId: number) => unknown }
}): Promise<Engine> {
  const core = await vi.importActual<Engine>('@bananapus/nana-sdk-core/review')
  const prompt = async (request: Parameters<Engine['buildReviewModel']>[0]) => {
    const model = core.buildReviewModel(request)
    coreReviews.shown.push(model)
    if (!(await coreReviews.answer(model))) throw new core.TransactionReviewCancelledError()
  }
  /** Core's plan rule as a test needs it: one unspent plan call, by exact key, for each call. */
  const keyOf = (call: { chainId: number; from: string; to: string; data: string; value?: bigint; gas?: bigint }) =>
    `${call.chainId}:${call.from.toLowerCase()}:${call.to.toLowerCase()}:${call.data.toLowerCase()}:${call.value ?? 0n}:${call.gas ?? ''}`
  const spent = new WeakMap<object, boolean[]>()
  const spend = (plan: import('@bananapus/nana-sdk-core/review').ReviewedPlan, account: string, calls: readonly import('@bananapus/nana-sdk-core/review').ReviewedCall[]) => {
    const taken = [...(spent.get(plan) ?? [])]
    if (!taken.length || plan.account.toLowerCase() !== account.toLowerCase()) throw new core.ReviewLineError(core.REVIEWED_PLAN_REFUSED_LINE)
    for (const call of calls) {
      const at = plan.calls.findIndex((planned, index) => !taken[index] && keyOf(planned) === keyOf({ ...call, from: account }))
      if (at < 0) throw new core.ReviewLineError(core.REVIEWED_PLAN_REFUSED_LINE)
      taken[at] = true
    }
    spent.set(plan, taken)
  }
  const reviewPlan: Engine['reviewPlan'] = async action => {
    await prompt({ title: action.title, description: action.description ?? '', confirmLabel: action.confirmLabel,
      context: action.context, calls: action.calls.map(call => ({ ...call, from: call.from === 'relayr' ? undefined : call.from ?? action.account })) })
    const plan = { account: action.account, expiresAt: Date.now() + core.REVIEWED_PLAN_TTL_MS,
      calls: action.calls.map(({ chainId, from, to, data, value, gas }) => ({ chainId, from: from ?? action.account, to, data,
        value: value ?? 0n, ...(gas === undefined || from === 'relayr' ? {} : { gas }) })) }
    spent.set(plan, plan.calls.map(() => false))
    return plan
  }
  const sendReviewed: Engine['sendReviewed'] = async action => {
    action.guard?.()
    if (action.plan) spend(action.plan, action.account, action.calls)
    // A Safe app's calls show as safeTxGas 0, never the app's gas, as core shows them.
    else await prompt({ title: action.title, description: action.description ?? '', confirmLabel: action.confirmLabel,
      context: action.context, calls: action.calls.map(({ gas, ...call }) => ({ ...call, from: action.account,
        ...(safe() ? { safeTxGas: 0n } : gas === undefined ? {} : { gas }) })) })
    const hashes: Hex[] = []
    const receipts: import('viem').TransactionReceipt[] = []
    for (const [step, call] of action.calls.entries()) {
      await switchChain(call.chainId)
      await action.reverify?.(call, step, undefined)
      let hash: Hex
      try {
        await action.beforeWallet?.(call, step)
      } catch (error) {
        await action.onUnsent?.(call, step)
        throw error
      }
      try {
        action.assertWriteState?.()
      } catch (error) {
        await action.onUnsent?.(call, step)
        throw error
      }
      // A Safe app proposes with safeTxGas 0, whatever gas the call names.
      const sending = safe() ? { ...call, gas: 0n } : call
      try {
        hash = hold
          ? await core.openStepHold(hold.holds, action.account, safe(), call).send<Hex>(hold.client(call.chainId) as never, async gate => {
            await gate.beforeSend()
            let sent: Hex
            try {
              sent = await send(sending)
            } catch (error) {
              if (core.isDefiniteWalletRejection(error)) gate.onRejected()
              throw error
            }
            gate.afterSubmit(sent)
            return sent
          })
          : await send(sending)
      } catch (error) {
        if (core.isDefiniteWalletRejection(error)) await action.onUnsent?.(call, step)
        throw error
      }
      await action.onSubmitted?.(call, step, hash, { safe: safe(), adopted: false })
      if (safe()) return { status: 'proposed', step, safeTxHash: hash }
      let mined: import('viem').TransactionReceipt
      try {
        mined = hold ? await core.waitForTrackedReceipt(hold.client(call.chainId) as never, hash, { attempts: 1, intervalMs: 0 }) : await receipt!(hash, call.chainId)
      } catch (cause) {
        throw new core.TransactionReceiptUnavailableError(hash, call.chainId, { cause })
      }
      if (mined.status !== 'success') throw new core.ReviewedCallRevertedError(step, hash, mined)
      hashes.push(hash)
      receipts.push(mined)
      await action.onConfirmed?.(call, step, mined)
    }
    return { status: 'done', hashes, receipts }
  }
  const { SAFE_TX_TYPES, safeTransactionMessage } = await vi.importActual<typeof import('@bananapus/nana-sdk-core/safe-service')>('@bananapus/nana-sdk-core/safe-service')
  const { FORWARD_REQUEST_TYPES, relayrForwarder } = await vi.importActual<typeof import('@bananapus/nana-sdk-core/review/relayr')>('@bananapus/nana-sdk-core/review/relayr')
  /** The typed data core signs for each kind a jbm lib signs. */
  const typedDataOf = (signature: Parameters<Engine['signReviewed']>[0][number]) => {
    if (signature.kind === 'safe-tx') {
      return { domain: { chainId: signature.chainId, verifyingContract: signature.safe }, types: SAFE_TX_TYPES,
        primaryType: 'SafeTx', message: safeTransactionMessage(signature.tx) } as import('viem').TypedDataDefinition
    }
    if (signature.kind === 'forward-request') {
      return { domain: { name: 'Juicebox', version: '1', chainId: signature.chainId, verifyingContract: relayrForwarder(signature.chainId)! },
        types: FORWARD_REQUEST_TYPES, primaryType: 'ForwardRequest', message: signature.request } as import('viem').TypedDataDefinition
    }
    throw new Error(`This test engine does not sign ${signature.kind}.`)
  }
  const signReviewed: Engine['signReviewed'] = async (signatures, action) => {
    const typed = signatures.map(typedDataOf)
    await prompt({ kind: 'authorization', title: action.title, description: action.description ?? '', calls: [],
      context: action.context, signatures: signatures.map((signature, index) => ({
        kind: signature.kind, chainId: 'chainId' in signature ? signature.chainId : 0, typedData: typed[index],
        // The call a forward request lets the forwarder run, decoded as core shows it.
        ...(signature.kind === 'forward-request' ? { calls: [{ chainId: signature.chainId, from: signature.request.from,
          to: signature.request.to, data: signature.request.data, value: signature.request.value, gas: signature.request.gas }] } : {}) })) })
    const signed: Hex[] = []
    for (const [index, typedData] of typed.entries()) {
      const signature = signatures[index]
      if ('chainId' in signature) await switchChain(signature.chainId)
      await action.reverify?.()
      signed.push(await sign!(typedData))
    }
    return signed
  }
  return { ...core, reviewPlan, sendReviewed, signReviewed }
}
