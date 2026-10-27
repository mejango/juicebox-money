'use client'

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { encodeFunctionData, erc20Abi, formatUnits, isAddress, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import { DefifaNftTransactionRevertedError, defifaPhaseAllowsPay, effectiveTierPrice, MAX_DEFIFA_ACTION_NFTS, prepareDefifaPay, verifyDefifaNftTransaction, type PreparedDefifaPay } from '@bananapus/nana-sdk-core/v6'
import { approvalIntent, verifyReviewedWriteReceipt, type ReviewedWriteRecoveryRecord, ReviewLineError } from '@bananapus/nana-sdk-core/review'
import { useWallet } from '@/hooks/useWallet'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'
import { SAVED_SEQUENCE_LINE } from '@/lib/reviewed-send'
import { hashOf, liveStep, reviewedCall, useReviewedAction, type ReviewedRun, type TxRequest } from '@/hooks/useReviewedAction'
import { DEFIFA_HOLDINGS_QUERY_PREFIX, NFT_CHECKOUT_PREVIEW_PAGE_SIZE, SHOP_721_QUERY_PREFIX, useShop721Media, type Shop } from '@/hooks/useShop721'
import { NftCheckoutCard } from '@/components/project/NftCheckoutCard'
import { CheckoutAmountRow, CHECKOUT_AMOUNT_INPUT_CLASS, CHECKOUT_ACTION_BUTTON_CLASS } from '@/components/project/CheckoutAmountRow'
import { NftCartLine } from '@/components/project/NftCartLine'
import { shopCartTotal } from '@/lib/shop-cart-total'
import { buildErc20ApproveRequest } from '@/lib/transaction-builders'
import { clearDefifaWriteRecovery, defifaSequenceCalls, defifaWriteNamespace, finishDefifaSequence, PendingDefifaWriteError, readDefifaWriteRecovery, runRecoverableDefifaWrite } from '@/lib/defifa-write-recovery'
import { DefifaRecovery } from '@/components/project/DefifaRecovery'
import { TxProgress } from '@/components/ui/TxProgress'
import { WriteRecoveryInTabNote } from '@/components/ui/WriteRecoveryInTabNote'
import { formatTokenAmount } from '@/lib/format'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { defifaPhaseLabel } from '@/lib/defifa-phase'
import { friendlyError } from '@/lib/errors'

type Review = {
  generation: number
  chainId: JBChainId
  projectId: number
  account: Address
  client: PublicClient
  hook: Address
  tierIds: bigint[]
  delegate: Address
  prepared: PreparedDefifaPay
  approval: TxRequest | null
  symbol: string
  selection: { id: number; name: string }[]
}
type Step = 'review' | 'approval' | 'mint' | 'verified' | 'failed'
const message = (error: unknown) => error instanceof Error ? friendlyError(error) : 'Unable to prepare this mint.'
const preparationEvidence = (prepared: PreparedDefifaPay) => JSON.stringify([prepared.selectedTiers, prepared.effectiveDelegates], (_, value) => typeof value === 'bigint' ? value.toString() : value)
const samePreparation = (a: PreparedDefifaPay, b: PreparedDefifaPay) =>
  encodeFunctionData(a.transaction) === encodeFunctionData(b.transaction) &&
  a.transaction.address.toLowerCase() === b.transaction.address.toLowerCase() &&
  a.transaction.chainId === b.transaction.chainId && a.transaction.value === b.transaction.value &&
  preparationEvidence(a) === preparationEvidence(b)

/** Native NFT selection, with SDK-owned pricing, delegation and receipt proof. */
export function DefifaCheckout({ chainId, projectId, shop }: { chainId: JBChainId; projectId: number; shop: Shop }) {
  const { address, isConnected, openSignIn } = useWallet()
  const flowSignal = useUnmountSignal()
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const queries = useQueryClient()
  const [quantities, setQuantities] = useState<Record<number, number>>({})
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(shop.tiers.length / NFT_CHECKOUT_PREVIEW_PAGE_SIZE))
  const visiblePage = Math.min(page, pageCount - 1)
  const visibleTiers = shop.tiers.slice(visiblePage * NFT_CHECKOUT_PREVIEW_PAGE_SIZE, (visiblePage + 1) * NFT_CHECKOUT_PREVIEW_PAGE_SIZE)
  const { data: mediaById } = useShop721Media(chainId, shop, visibleTiers.map(tier => tier.id))
  const [delegate, setDelegate] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('review')
  const recoveryRecord = useRef<ReviewedWriteRecoveryRecord | null>(null)
  const submissionStarted = useRef(false)
  const [submissionUnknown, setSubmissionUnknown] = useState(false)
  const [previousFailedTransaction, setPreviousFailedTransaction] = useState<{ hash: Hex; chainId: JBChainId; projectId: number; kind: 'approval' | 'mint' } | null>(null)
  const [submitted, setSubmitted] = useState<{ hash: Hex; safe: boolean } | null>(null)
  const [approvalBlock, setApprovalBlock] = useState<bigint>()
  const [checking, setChecking] = useState(false)
  const tx = useReviewedAction(review?.chainId ?? chainId)
  const locked = useRef(false)
  const preparingRef = useRef(false)
  const generation = useRef(0)
  const current = useRef({ chainId, projectId, address, hook: shop.hook, client })
  current.current = { chainId, projectId, address, hook: shop.hook, client }
  const identity = `${chainId}:${projectId}:${shop.hook}:${address ?? ''}`
  const priorIdentity = useRef({ identity, client })
  if (priorIdentity.current.identity !== identity || priorIdentity.current.client !== client) {
    priorIdentity.current = { identity, client }
    generation.current += 1
  }
  useEffect(() => {
    if (locked.current) return
    setReview(null)
    setPreparing(false)
    setQuantities({})
    setPage(0)
    setError(null)
  }, [identity, client])
  const assertCurrent = (frozen: Review) => {
    const now = current.current
    if (flowSignal().aborted || generation.current !== frozen.generation || now.chainId !== frozen.chainId || now.projectId !== frozen.projectId || now.hook !== frozen.hook || now.client !== frozen.client || now.address?.toLowerCase() !== frozen.account.toLowerCase())
      throw new ReviewLineError('The connected account or project changed. Review again.')
  }
  const prepareFresh = async (frozen: Review) => {
    assertCurrent(frozen)
    const fresh = await prepareDefifaPay(frozen.client, { chainId: frozen.chainId, projectId: BigInt(frozen.projectId), account: frozen.account, expectedHook: frozen.hook, tierIdsToMint: frozen.tierIds, attestationDelegate: frozen.delegate })
      .catch((cause: unknown) => { throw new ReviewLineError('This mint changed or is not open now. Review again.', { cause }) })
    assertCurrent(frozen)
    if (!samePreparation(frozen.prepared, fresh)) throw new ReviewLineError('The price or voting delegation changed. Review again.')
    return fresh
  }
  const prepare = async () => {
    if (flowSignal().aborted || preparingRef.current || locked.current || !client || !address) return
    preparingRef.current = true
    const attempt = ++generation.current
    setPreparing(true)
    setError(null)
    try {
      if (delegate && !isAddress(delegate)) throw new ReviewLineError('Enter a valid voting delegate address.')
      const tierIds = shop.tiers.flatMap(tier => Array<bigint>(quantities[tier.id] ?? 0).fill(BigInt(tier.id))).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      const prepared = await prepareDefifaPay(client, { chainId, projectId: BigInt(projectId), account: address, expectedHook: shop.hook, tierIdsToMint: tierIds, attestationDelegate: (delegate || zeroAddress) as Address })
      const token = prepared.inventory.pricing.token
      const allowance = token.toLowerCase() === NATIVE_TOKEN.toLowerCase() ? prepared.amount : await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [address, prepared.transaction.address] })
      if (flowSignal().aborted || generation.current !== attempt) return
      setReview({ generation: attempt, chainId, projectId, account: address, client, hook: shop.hook, tierIds, delegate: (delegate || zeroAddress) as Address, prepared, symbol: shop.pricing.symbol, selection: shop.tiers.filter(tier => quantities[tier.id]).map(tier => ({ id: tier.id, name: tier.name ?? `Tier #${tier.id}` })), approval: allowance < prepared.amount ? { ...buildErc20ApproveRequest({ chainId, token, spender: prepared.transaction.address, amount: prepared.amount }), value: 0n, label: 'Approve Defifa mint payment' } : null })
      setStep('review')
      setSubmitted(null)
      submissionStarted.current = false
      setSubmissionUnknown(false)
      setApprovalBlock(undefined)
      tx.reset()
    } catch (reason) {
      if (generation.current === attempt) setError(message(reason))
    } finally {
      preparingRef.current = false
      if (generation.current === attempt) setPreparing(false)
    }
  }
  /**
   * The payment approval (when the allowance is short) and the mint, in one
   * review: the mint simulates on the approval's receipt block. The same calls
   * run again after a Safe executes the approval, so core continues at the
   * mint and never asks for the approval twice.
   */
  const confirm = async () => {
    if (!review || locked.current) return
    locked.current = true
    setError(null)
    const scope = { chainId: review.chainId, projectId: review.projectId, account: review.account, action: 'pay' as const }
    const mint = reviewedCall({ ...review.prepared.transaction, label: 'Mint Defifa NFTs' }, review.approval ? { dependsOnPrior: true } : {})
    const planned = review.approval
      ? [reviewedCall(review.approval, { intent: approvalIntent(defifaWriteNamespace(scope), { step: 'approve', token: review.approval.address, spender: review.prepared.transaction.address }) }), mint]
      : [mint]
    let last = planned.length - 1
    // A sent transaction is followed by its receipt (a revert included); only an unsent submission is unknown.
    let sent = false
    try {
      assertCurrent(review)
      // A saved run whose step was sent continues as reviewed; one whose approval only went through is dropped, so a new cart reviews afresh.
      const { calls, saved, scope: runScope } = planned.length > 1 ? await defifaSequenceCalls(scope, planned) : { calls: planned, saved: false, scope: undefined }
      last = calls.length - 1
      const reverify: ReviewedRun['reverify'] = async (_call, at) => {
        await prepareFresh(review)
        // With an approval step, the mint simulates on its receipt block: the simulation is the allowance check.
        if (at === last && !review.approval && review.prepared.inventory.pricing.token.toLowerCase() !== NATIVE_TOKEN.toLowerCase()) {
          const allowance = await review.client.readContract({ address: review.prepared.inventory.pricing.token, abi: erc20Abi, functionName: 'allowance', args: [review.account, review.prepared.transaction.address] })
          if (allowance < review.prepared.amount) throw new ReviewLineError('Mint payment allowance is insufficient. Review again.')
        }
      }
      const action: ReviewedRun = { account: review.account, calls, ...(runScope ? { scope: runScope } : {}), ...(saved ? { description: SAVED_SEQUENCE_LINE } : { reverify }), assertWriteState: () => assertCurrent(review), beforeWallet: (_call, at) => { assertCurrent(review); if (at === last) submissionStarted.current = true }, onUnsent: (_call, at) => { if (at === last) submissionStarted.current = false }, onSubmitted: (_call, at, hash, { safe }) => { if (at !== last) return; sent = true; setStep('mint'); setSubmitted({ hash, safe }) } }
      const result = await runRecoverableDefifaWrite({ scope, action, onRecord: record => { recoveryRecord.current = record }, run: tx.run })
      if (result?.status === 'proposed' && result.step < last) {
        // A Safe executes each step as its own proposal: the approval first, then the mint, reviewed again once it runs.
        setStep('approval')
        setSubmitted({ hash: result.safeTxHash, safe: true })
      } else if (result) {
        setStep('mint')
        setSubmitted({ hash: hashOf(result)!, safe: result.status === 'proposed' })
      } else if (submissionStarted.current && !sent) {
        setSubmissionUnknown(true)
      } else locked.current = false
    } catch (reason) {
      setError(message(reason))
      if (reason instanceof PendingDefifaWriteError) { setReview(null); locked.current = false; return }
      if (submissionStarted.current) setSubmissionUnknown(true)
      else locked.current = false
    }
  }
  const clearOriginal = async (frozen: Review) => {
    const record = recoveryRecord.current
    if (!record) throw new ReviewLineError('The original recovery record is unavailable. Keep this action pending.')
    const scope = { chainId: frozen.chainId, projectId: frozen.projectId, account: frozen.account, action: 'pay' as const }
    await clearDefifaWriteRecovery(scope, record)
    recoveryRecord.current = null
    // The mint is proven: a run of its approval and mint saved for a Safe is over too.
    if (frozen.approval) await finishDefifaSequence(scope)
  }
  const active = tx
  const verify = async () => {
    if (!review || !submitted || !active.receipt || checking || step === 'verified' || step === 'failed') return
    setChecking(true)
    setError(null)
    try {
      if (step === 'approval') {
        const request = review.approval!
        const call = { to: request.address, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }), value: '0' }
        const status = await verifyReviewedWriteReceipt(review.client, { version: 1, id: submitted.hash, chainId: review.chainId, account: review.account, safe: submitted.safe, call, hash: submitted.hash }, active.receipt)
        // An approval step keeps no Defifa recovery record: its own hold settled it.
        if (status === 'failed') {
          submissionStarted.current = false
          setPreviousFailedTransaction({ hash: active.receipt.transactionHash, chainId: review.chainId, projectId: review.projectId, kind: 'approval' })
          setStep('failed')
          setError(`The payment approval failed onchain (${active.receipt.transactionHash}). Close this review to try again.`)
          return
        }
        const allowance = await review.client.readContract({ address: request.address, abi: erc20Abi, functionName: 'allowance', args: [review.account, review.prepared.transaction.address], blockNumber: active.receipt.blockNumber })
        if (allowance < review.prepared.amount) throw new ReviewLineError('Confirmed allowance is insufficient for this mint.')
        // The same run again: core continues at the mint.
        setApprovalBlock(active.receipt.blockNumber)
        submissionStarted.current = false
        setStep('review')
        setSubmitted(null)
        locked.current = false
      } else {
        await verifyDefifaNftTransaction(review.client, { hook: review.hook, implementation: review.prepared.inventory.implementation, account: review.account, transaction: review.prepared.transaction, ...(submitted.safe ? { safe: { proposalHash: submitted.hash } } : {}) }, active.receipt)
        await clearOriginal(review)
        await queries.invalidateQueries({ queryKey: [...SHOP_721_QUERY_PREFIX, review.chainId, review.projectId] })
        await queries.invalidateQueries({ queryKey: ['payNftProtocol', review.chainId, review.projectId] })
        await queries.invalidateQueries({ queryKey: [...DEFIFA_HOLDINGS_QUERY_PREFIX, review.chainId, review.projectId] })
        setStep('verified')
      }
    } catch (reason) {
      if (reason instanceof DefifaNftTransactionRevertedError && reason.chainId === review.chainId && reason.hash.toLowerCase() === active.receipt.transactionHash.toLowerCase()) {
        try {
          await clearOriginal(review)
          submissionStarted.current = false
          setPreviousFailedTransaction({ hash: reason.hash, chainId: review.chainId, projectId: review.projectId, kind: 'mint' })
          setStep('failed')
          setError(`The NFT mint failed onchain (${reason.hash}). Close this review to try again.`)
        } catch (failure) { setError(`Confirmation needs verification. ${message(failure)}`) }
      } else setError(`Confirmation needs verification. ${message(reason)}`)
    }
    finally { setChecking(false) }
  }
  useEffect(() => {
    if (submitted && active.receipt && (active.phase === 'success' || active.phase === 'error' || active.settledStep != null)) void verify()
    // Keep the exact submitted context. Changes in the current wallet never replace it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted, active.receipt, active.phase])
  const closeReview = () => {
    if (busy) return
    // A submitted mint stays recoverable; an approval with a Safe is held by its own hold.
    if (review && (submissionUnknown || (submitted && step === 'mint'))) {
      try {
        const retained = readDefifaWriteRecovery({ chainId: review.chainId, projectId: review.projectId, account: review.account, action: 'pay' })
        if (!retained || retained.id !== recoveryRecord.current?.id) throw new ReviewLineError('The original recovery record is unavailable. Keep this action pending.')
      } catch (reason) { setError(message(reason)); return }
    }
    locked.current = false
    generation.current += 1
    setReview(null)
    setQuantities({})
    setSubmissionUnknown(false)
    setSubmitted(null)
    submissionStarted.current = false
    tx.reset()
  }
  const count = Object.values(quantities).reduce((sum, value) => sum + value, 0)
  const allowed = shop.protocol === 'defifa' && shop.phase !== undefined && defifaPhaseAllowsPay(shop.phase)
  const selectedTiers = shop.tiers.filter(tier => quantities[tier.id] > 0)
  const selectedAmount = shopCartTotal(shop.tiers, quantities)
  const amountValue = formatUnits(review?.prepared.amount ?? selectedAmount, review?.prepared.inventory.pricing.decimals ?? shop.pricing.decimals)
  const amountSymbol = review?.symbol ?? shop.pricing.symbol
  const frozenAmount = review ? `${formatUnits(review.prepared.amount, review.prepared.inventory.pricing.decimals)} ${review.symbol}` : ''
  const busy = tx.busy || checking
  return <DefifaRecovery chainId={chainId} projectId={projectId} account={address} hook={shop.hook} actions={['pay']} active={!!review}><div className="space-y-4">
    <p className="text-sm text-smoke-600">Protocol phase: {defifaPhaseLabel(shop.phase)}</p>
      <div className="mt-4">
        <span className="field-label">Shop</span>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-3">
          {visibleTiers.map(tier => {
            const quantity = quantities[tier.id] ?? 0
            const name = tier.name ?? `Tier #${tier.id}`
            const canAdd = count < MAX_DEFIFA_ACTION_NFTS && quantity < tier.remaining
            return <NftCheckoutCard key={tier.id} tierId={tier.id} name={name} image={mediaById?.[tier.id]?.image} qty={quantity}
              priceLabel={`${formatTokenAmount(effectiveTierPrice(tier.price, tier.discountPercent), shop.pricing.decimals)} ${shop.pricing.symbol}`}
              soldOut={tier.remaining === 0} busy={!allowed || !!review || preparing} canAdd={canAdd}
              onSelect={() => { if (canAdd) setQuantities(q => ({ ...q, [tier.id]: 1 })) }}
              onAdd={() => setQuantities(q => ({ ...q, [tier.id]: quantity + 1 }))}
              onRemove={() => setQuantities(q => ({ ...q, [tier.id]: quantity - 1 }))} />
          })}
        </div>
        {pageCount > 1 ? <div className="flex items-center justify-between gap-3 text-xs text-smoke-600">
          <button type="button" className="btn-secondary px-3 py-1" disabled={!!review || preparing || visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>Previous NFTs</button>
          <span>Page {visiblePage + 1} of {pageCount}</span>
          <button type="button" className="btn-secondary px-3 py-1" disabled={!!review || preparing || visiblePage + 1 >= pageCount} onClick={() => setPage(visiblePage + 1)}>Next NFTs</button>
        </div> : null}
      </div>
    {allowed ? <>
      <label className="block text-sm">Voting delegate, optional<input className="input-well mt-1 w-full px-3 py-2" value={delegate} placeholder="Use the contract default" disabled={!!review || preparing} onChange={event => setDelegate(event.target.value)} /></label>
      <CheckoutAmountRow
        amount={<input type="text" readOnly aria-label="NFT amount" value={amountValue} className={CHECKOUT_AMOUNT_INPUT_CLASS} />}
        currency={<span className="text-sm font-medium text-ink">{amountSymbol}</span>}
        action={isConnected ? <button className={CHECKOUT_ACTION_BUTTON_CLASS} disabled={!count || preparing || !!review} onClick={() => void prepare()}>{preparing ? 'Preparing mint…' : 'Review mint'}</button> : <button className={CHECKOUT_ACTION_BUTTON_CLASS} onClick={openSignIn}>Connect wallet</button>} />
      {selectedTiers.length ? <div aria-label="Selected NFTs" className="mt-2 space-y-2 rounded-lg border border-smoke-200 bg-smoke-50 p-2.5">
        {selectedTiers.map(tier => {
          const quantity = quantities[tier.id]
          return <NftCartLine key={tier.id} tierId={tier.id} name={tier.name ?? `Tier #${tier.id}`} image={mediaById?.[tier.id]?.image} quantity={quantity}
            onRemove={() => setQuantities(q => ({ ...q, [tier.id]: quantity - 1 }))}
            onAdd={() => setQuantities(q => ({ ...q, [tier.id]: quantity + 1 }))}
            removeDisabled={preparing || !!review} addDisabled={preparing || !!review || count >= MAX_DEFIFA_ACTION_NFTS || quantity >= tier.remaining} />
        })}
        <div className="space-y-1 border-t border-smoke-200 pt-2 text-xs">
          <div className="flex items-center justify-between gap-3"><span>{count} NFTs</span><span>{amountValue} {amountSymbol}</span></div>
        </div>
      </div> : null}
    </> : <p className="text-sm text-smoke-600">NFT minting is {shop.phase === undefined ? 'unavailable while the protocol phase is unknown' : 'not open in this phase'}.</p>}
    {previousFailedTransaction ? <p className="wrap-anywhere text-xs text-smoke-600">
      Previous {previousFailedTransaction.kind === 'approval' ? 'payment approval' : 'NFT mint'} failed onchain, project {previousFailedTransaction.projectId}, chain {previousFailedTransaction.chainId}.{' '}
      {explorerTxUrl(previousFailedTransaction.chainId, previousFailedTransaction.hash) ? <a href={explorerTxUrl(previousFailedTransaction.chainId, previousFailedTransaction.hash)!} target="_blank" rel="noopener noreferrer" className="text-bluebs-600 underline">{previousFailedTransaction.hash}</a> : previousFailedTransaction.hash}
    </p> : null}
    {!review && error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    <TxProgress open={!!review} title="Mint Defifa NFTs" onClose={closeReview} rows={review ? [
      { label: 'Account', value: review.account, mono: true },
      { label: 'Chain ID', value: review.chainId },
      { label: 'Project ID', value: review.projectId },
      { label: 'NFT collection', value: review.hook, mono: true },
      ...review.prepared.selectedTiers.map(tier => ({ label: `Tier ${tier.tierId}: ${review.selection.find(selected => BigInt(selected.id) === tier.tierId)?.name ?? 'NFT'}`, value: `${tier.count} NFTs × ${formatUnits(tier.unitPrice, review.prepared.inventory.pricing.decimals)} ${review.symbol}` })),
      { label: 'Payment', value: frozenAmount, strong: true },
      ...(review.approval ? [{ label: 'Payment approval spender', value: review.prepared.transaction.address, mono: true }] : []),
      ...review.prepared.effectiveDelegates.map(effect => ({ label: `Tier ${effect.tierId} voting delegate`, value: effect.delegate, mono: true })),
    ] : []} steps={[...(review?.approval ? [{ title: 'Approve Defifa mint payment' }] : []), { title: 'Mint Defifa NFTs' }]} activeIndex={liveStep(tx, review?.approval ? [0, 1] : [0], review?.approval && step !== 'mint' && approvalBlock === undefined ? 0 : review?.approval ? 1 : 0)} start={!submitted && !submissionUnknown && step !== 'failed' ? () => void confirm() : undefined} startKey={approvalBlock} next={step === 'failed' ? { label: 'Close review', onClick: closeReview } : submitted ? { label: 'Recheck confirmation', onClick: () => void verify(), disabled: submissionUnknown || !active.receipt } : (error || tx.error) && !submissionUnknown ? { label: 'Try again', onClick: () => void confirm() } : null} busy={busy} complete={step === 'verified'} status={submissionUnknown ? 'The wallet submission is unconfirmed. Check your wallet before taking further action. This mint has not been verified.' : step === 'verified' ? 'NFT mint verified onchain.' : submitted ? active.notice ?? `${submitted.safe ? 'Safe proposal' : 'Submitted transaction'} ${active.hash ?? submitted.hash}` : approvalBlock !== undefined ? 'Payment approval verified. Confirm the NFT mint.' : undefined} error={error ?? tx.error}>
      <p className="text-sm text-smoke-600">Minting to your account updates voting delegation for all your NFTs in each selected tier, including NFTs you already hold. A blank delegate preserves the native contract default.</p>
      <WriteRecoveryInTabNote />
    </TxProgress>
  </div></DefifaRecovery>
}
