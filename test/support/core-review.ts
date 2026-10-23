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
export async function fakeEngine({ send, receipt, sign, safe = () => false, switchChain = async () => {} }: {
  send: (call: import('@bananapus/nana-sdk-core/review').ReviewedCall) => Promise<Hex>
  receipt?: (hash: Hex, chainId: number) => Promise<import('viem').TransactionReceipt>
  sign?: (typedData: import('viem').TypedDataDefinition) => Promise<Hex>
  safe?: () => boolean
  /** Core moves the wallet to the call's chain before `reverify`. */
  switchChain?: (chainId: number) => Promise<void>
}): Promise<Engine> {
  const core = await vi.importActual<Engine>('@bananapus/nana-sdk-core/review')
  const prompt = async (request: Parameters<Engine['buildReviewModel']>[0]) => {
    const model = core.buildReviewModel(request)
    coreReviews.shown.push(model)
    if (!(await coreReviews.answer(model))) throw new core.TransactionReviewCancelledError()
  }
  const sendReviewed: Engine['sendReviewed'] = async action => {
    action.guard?.()
    await prompt({ title: action.title, description: action.description ?? '', confirmLabel: action.confirmLabel,
      context: action.context, calls: action.calls.map(call => ({ ...call, from: action.account })) })
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
      try {
        // A Safe app proposes with safeTxGas 0, whatever gas the call names.
        hash = await send(safe() ? { ...call, gas: 0n } : call)
      } catch (error) {
        if (core.isDefiniteWalletRejection(error)) await action.onUnsent?.(call, step)
        throw error
      }
      await action.onSubmitted?.(call, step, hash, { safe: safe(), adopted: false })
      if (safe()) return { status: 'proposed', step, safeTxHash: hash }
      let mined: import('viem').TransactionReceipt
      try {
        mined = await receipt!(hash, call.chainId)
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
        kind: signature.kind, chainId: 'chainId' in signature ? signature.chainId : 0, typedData: typed[index] })) })
    const signed: Hex[] = []
    for (const [index, typedData] of typed.entries()) {
      const signature = signatures[index]
      if ('chainId' in signature) await switchChain(signature.chainId)
      await action.reverify?.()
      signed.push(await sign!(typedData))
    }
    return signed
  }
  return { ...core, sendReviewed, signReviewed }
}
