'use client'

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { encodeFunctionData, erc20Abi, formatUnits, isAddress, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import { DefifaNftTransactionRevertedError, defifaPhaseAllowsPay, effectiveTierPrice, MAX_DEFIFA_ACTION_NFTS, prepareDefifaPay, verifyDefifaNftTransaction, type PreparedDefifaPay } from '@bananapus/nana-sdk-core/v6'
import { verifyReviewedWriteReceipt, type ReviewedWriteRecoveryRecord } from '@bananapus/nana-sdk-core/review'
import { useWallet } from '@/hooks/useWallet'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'
import { useSafeTx, type TxRequest, type TxSendOptions } from '@/hooks/useSafeTx'
import { DEFIFA_HOLDINGS_QUERY_PREFIX, NFT_CHECKOUT_PREVIEW_PAGE_SIZE, SHOP_721_QUERY_PREFIX, useShop721Media, type Shop } from '@/hooks/useShop721'
import { NftCheckoutCard } from '@/components/project/NftCheckoutCard'
import { CheckoutAmountRow, CHECKOUT_AMOUNT_INPUT_CLASS, CHECKOUT_ACTION_BUTTON_CLASS } from '@/components/project/CheckoutAmountRow'
import { NftCartLine } from '@/components/project/NftCartLine'
import { shopCartTotal } from '@/lib/shop-cart-total'
import { clearDefifaWriteRecovery, PendingDefifaWriteError, readDefifaWriteRecovery, sendRecoverableDefifaWrite } from '@/lib/defifa-write-recovery'
import { DefifaRecovery } from '@/components/project/DefifaRecovery'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { WriteRecoveryInTabNote } from '@/components/ui/WriteRecoveryInTabNote'
import { formatTokenAmount } from '@/lib/format'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { defifaPhaseLabel } from '@/lib/defifa-phase'

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
const message = (error: unknown) => error instanceof Error ? error.message : 'Unable to prepare this mint.'
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
  const approvalTx = useSafeTx(review?.chainId ?? chainId)
  const mintTx = useSafeTx(review?.chainId ?? chainId)
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
      throw new Error('The connected account or project changed. Review again.')
  }
  const prepareFresh = async (frozen: Review) => {
    assertCurrent(frozen)
    const fresh = await prepareDefifaPay(frozen.client, { chainId: frozen.chainId, projectId: BigInt(frozen.projectId), account: frozen.account, expectedHook: frozen.hook, tierIdsToMint: frozen.tierIds, attestationDelegate: frozen.delegate })
    assertCurrent(frozen)
    if (!samePreparation(frozen.prepared, fresh)) throw new Error('The price or voting delegation changed. Review again.')
    return fresh
  }
  const prepare = async () => {
    if (flowSignal().aborted || preparingRef.current || locked.current || !client || !address) return
    preparingRef.current = true
    const attempt = ++generation.current
    setPreparing(true)
    setError(null)
    try {
      if (delegate && !isAddress(delegate)) throw new Error('Enter a valid voting delegate address.')
      const tierIds = shop.tiers.flatMap(tier => Array<bigint>(quantities[tier.id] ?? 0).fill(BigInt(tier.id))).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      const prepared = await prepareDefifaPay(client, { chainId, projectId: BigInt(projectId), account: address, expectedHook: shop.hook, tierIdsToMint: tierIds, attestationDelegate: (delegate || zeroAddress) as Address })
      const token = prepared.inventory.pricing.token
      const allowance = token.toLowerCase() === NATIVE_TOKEN.toLowerCase() ? prepared.amount : await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [address, prepared.transaction.address] })
      if (flowSignal().aborted || generation.current !== attempt) return
      setReview({ generation: attempt, chainId, projectId, account: address, client, hook: shop.hook, tierIds, delegate: (delegate || zeroAddress) as Address, prepared, symbol: shop.pricing.symbol, selection: shop.tiers.filter(tier => quantities[tier.id]).map(tier => ({ id: tier.id, name: tier.name ?? `Tier #${tier.id}` })), approval: allowance < prepared.amount ? { chainId, address: token, abi: erc20Abi, functionName: 'approve', args: [prepared.transaction.address, prepared.amount], value: 0n, label: 'Approve Defifa mint payment' } : null })
      setStep('review')
      setSubmitted(null)
      submissionStarted.current = false
      setSubmissionUnknown(false)
      setApprovalBlock(undefined)
      approvalTx.reset()
      mintTx.reset()
    } catch (reason) {
      if (generation.current === attempt) setError(message(reason))
    } finally {
      preparingRef.current = false
      if (generation.current === attempt) setPreparing(false)
    }
  }
  const confirm = async () => {
    if (!review || locked.current) return
    locked.current = true
    setError(null)
    const approving = !!review.approval && approvalBlock === undefined
    const engine = approving ? approvalTx : mintTx
    const request = approving ? review.approval! : { ...review.prepared.transaction, label: 'Mint Defifa NFTs' }
    try {
      assertCurrent(review)
      const options: TxSendOptions = { reviewedAccount: review.account, assertWriteState: () => assertCurrent(review), beforeWrite: () => { assertCurrent(review); submissionStarted.current = true }, onBeforeWriteAborted: () => { submissionStarted.current = false }, onWriteRejected: () => { submissionStarted.current = false }, simulationBlockNumber: approving ? undefined : approvalBlock, reverify: async () => {
        await prepareFresh(review)
        if (!approving && review.prepared.inventory.pricing.token.toLowerCase() !== NATIVE_TOKEN.toLowerCase()) {
          const allowance = await review.client.readContract({ address: review.prepared.inventory.pricing.token, abi: erc20Abi, functionName: 'allowance', args: [review.account, review.prepared.transaction.address], ...(approvalBlock === undefined ? {} : { blockNumber: approvalBlock }) })
          if (allowance < review.prepared.amount) throw new Error('Mint payment allowance is insufficient. Review again.')
        }
      } }
      const hash = await sendRecoverableDefifaWrite({
        scope: { chainId: review.chainId, projectId: review.projectId, account: review.account, action: 'pay' },
        request, options, onRecord: record => { recoveryRecord.current = record },
        send: approving ? (request, options) => approvalTx.send(request, options) : (request, options) => mintTx.send(request, options),
      })
      if (hash) {
        setStep(approving ? 'approval' : 'mint')
        setSubmitted({ hash, safe: engine.isSafe })
      } else if (submissionStarted.current) {
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
    if (!record) throw new Error('The original recovery record is unavailable. Keep this action pending.')
    await clearDefifaWriteRecovery({ chainId: frozen.chainId, projectId: frozen.projectId, account: frozen.account, action: 'pay' }, record)
    recoveryRecord.current = null
  }
  const active = step === 'approval' ? approvalTx : mintTx
  const verify = async () => {
    if (!review || !submitted || !active.receipt || checking || step === 'verified' || step === 'failed') return
    setChecking(true)
    setError(null)
    try {
      if (step === 'approval') {
        const request = review.approval!
        const call = { to: request.address, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }), value: '0' }
        const status = await verifyReviewedWriteReceipt(review.client, { version: 1, id: submitted.hash, chainId: review.chainId, account: review.account, safe: submitted.safe, call, hash: submitted.hash }, active.receipt)
        if (status === 'failed') {
          await clearOriginal(review)
          submissionStarted.current = false
          setPreviousFailedTransaction({ hash: active.receipt.transactionHash, chainId: review.chainId, projectId: review.projectId, kind: 'approval' })
          setStep('failed')
          setError(`The payment approval failed onchain (${active.receipt.transactionHash}). Close this review to try again.`)
          return
        }
        const allowance = await review.client.readContract({ address: request.address, abi: erc20Abi, functionName: 'allowance', args: [review.account, review.prepared.transaction.address], blockNumber: active.receipt.blockNumber })
        if (allowance < review.prepared.amount) throw new Error('Confirmed allowance is insufficient for this mint.')
        await clearOriginal(review)
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
    if (submitted && active.receipt && (active.phase === 'success' || active.phase === 'error')) void verify()
    // Keep the exact submitted context. Changes in the current wallet never replace it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted, active.receipt, active.phase])
  const closeReview = () => {
    if (busy) return
    if (review && (submissionUnknown || (submitted && step !== 'verified' && step !== 'failed'))) {
      try {
        const retained = readDefifaWriteRecovery({ chainId: review.chainId, projectId: review.projectId, account: review.account, action: 'pay' })
        if (!retained || retained.id !== recoveryRecord.current?.id) throw new Error('The original recovery record is unavailable. Keep this action pending.')
      } catch (reason) { setError(message(reason)); return }
    }
    locked.current = false
    generation.current += 1
    setReview(null)
    setQuantities({})
    setSubmissionUnknown(false)
    setSubmitted(null)
    submissionStarted.current = false
    approvalTx.reset()
    mintTx.reset()
  }
  const count = Object.values(quantities).reduce((sum, value) => sum + value, 0)
  const allowed = shop.protocol === 'defifa' && shop.phase !== undefined && defifaPhaseAllowsPay(shop.phase)
  const selectedTiers = shop.tiers.filter(tier => quantities[tier.id] > 0)
  const selectedAmount = shopCartTotal(shop.tiers, quantities)
  const amountValue = formatUnits(review?.prepared.amount ?? selectedAmount, review?.prepared.inventory.pricing.decimals ?? shop.pricing.decimals)
  const amountSymbol = review?.symbol ?? shop.pricing.symbol
  const frozenAmount = review ? `${formatUnits(review.prepared.amount, review.prepared.inventory.pricing.decimals)} ${review.symbol}` : ''
  const busy = approvalTx.busy || mintTx.busy || checking
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
    <TxConfirmDialog open={!!review} title="Mint Defifa NFTs" onClose={closeReview} rows={review ? [
      { label: 'Account', value: review.account, mono: true },
      { label: 'Chain ID', value: review.chainId },
      { label: 'Project ID', value: review.projectId },
      { label: 'NFT collection', value: review.hook, mono: true },
      ...review.prepared.selectedTiers.map(tier => ({ label: `Tier ${tier.tierId}: ${review.selection.find(selected => BigInt(selected.id) === tier.tierId)?.name ?? 'NFT'}`, value: `${tier.count} NFTs × ${formatUnits(tier.unitPrice, review.prepared.inventory.pricing.decimals)} ${review.symbol}` })),
      { label: 'Payment', value: frozenAmount, strong: true },
      ...(review.approval ? [{ label: 'Payment approval spender', value: review.prepared.transaction.address, mono: true }] : []),
      ...review.prepared.effectiveDelegates.map(effect => ({ label: `Tier ${effect.tierId} voting delegate`, value: effect.delegate, mono: true })),
    ] : []} steps={[...(review?.approval ? [{ title: 'Approve Defifa mint payment' }] : []), { title: 'Mint Defifa NFTs' }]} activeIndex={approvalBlock === undefined && review?.approval ? 0 : review?.approval ? 1 : 0} action={step === 'failed' ? 'Close review' : submitted ? 'Recheck confirmation' : review?.approval && approvalBlock === undefined ? 'Approve payment' : 'Confirm mint'} onConfirm={() => { if (step === 'failed') closeReview(); else void (submitted ? verify() : confirm()) }} busy={busy} complete={step === 'verified'} actionDisabled={submissionUnknown || (step !== 'failed' && !!submitted && !active.receipt)} status={submissionUnknown ? 'The wallet submission is unconfirmed. Check your wallet before taking further action. This mint has not been verified.' : step === 'verified' ? 'NFT mint verified onchain.' : submitted ? active.notice ?? `${submitted.safe ? 'Safe proposal' : 'Submitted transaction'} ${active.hash ?? submitted.hash}` : approvalBlock !== undefined ? 'Payment approval verified. Confirm the NFT mint.' : undefined} error={error ?? approvalTx.error ?? mintTx.error}>
      <p className="text-sm text-smoke-600">Minting to your account updates voting delegation for all your NFTs in each selected tier, including NFTs you already hold. A blank delegate preserves the native contract default.</p>
      <WriteRecoveryInTabNote />
    </TxConfirmDialog>
  </div></DefifaRecovery>
}
