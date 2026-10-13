'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import {
  getDefifaHoldings, prepareDefifaCashOut, prepareDefifaTransfer,
  defifaPhaseAllowsCashOut, MAX_DEFIFA_ACTION_NFTS, DefifaNftTransactionRevertedError,
  slippageFloor, verifyDefifaNftTransaction,
} from '@bananapus/nana-sdk-core/v6'
import type { ReviewedWriteRecoveryRecord } from '@bananapus/nana-sdk-core/review'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { encodeFunctionData, isAddress, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { useConfig, usePublicClient } from 'wagmi'
import { getAccount } from 'wagmi/actions'
import { DefifaRecovery } from '@/components/project/DefifaRecovery'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'
import { useWallet } from '@/hooks/useWallet'
import { DEFIFA_HOLDINGS_QUERY_PREFIX, SHOP_721_QUERY_PREFIX, type Shop } from '@/hooks/useShop721'
import { clearDefifaWriteRecovery, readDefifaWriteRecovery, sendRecoverableDefifaWrite, DEFIFA_RECOVERY_QUERY_PREFIX } from '@/lib/defifa-write-recovery'
import { etherscanTxUrl, formatTokenAmount } from '@/lib/format'

type CashOut = Awaited<ReturnType<typeof prepareDefifaCashOut>>
type Transfer = Awaited<ReturnType<typeof prepareDefifaTransfer>>
type Plan = {
  account: Address
  tokenIds: bigint[]
  minimum: bigint
  result: CashOut | Transfer
  kind: 'cash-out' | 'transfer'
  recipient: Address
  chainId: JBChainId
  projectId: number
  symbol: string
}
const message = (error: unknown) => error instanceof Error ? error.message : 'Could not verify this action.'
const requestKey = (result: CashOut | Transfer) => {
  const request = result.transaction
  const data = request.functionName === 'safeTransferFrom' ? encodeFunctionData(request) : encodeFunctionData(request)
  return `${request.chainId}:${request.address.toLowerCase()}:${data}:${'value' in request ? request.value : 0n}`
}
const rewardsKey = (result: CashOut) => {
  const rewards = result.protocolRewards
  return `${rewards.defifaToken.toLowerCase()}:${rewards.defifaAmount}:${rewards.defifaDecimals}:${rewards.baseProtocolToken.toLowerCase()}:${rewards.baseProtocolAmount}:${rewards.baseProtocolDecimals}`
}

export function DefifaOwnedNfts({ chainId, projectId, shop }: { chainId: JBChainId; projectId: number; shop: Shop }) {
  return <OwnedNfts chainId={chainId} projectId={projectId} shop={shop} />
}

function OwnedNfts({ chainId, projectId, shop }: { chainId: JBChainId; projectId: number; shop: Shop }) {
  const { address, openSignIn } = useWallet()
  const config = useConfig()
  const flowSignal = useUnmountSignal()
  const holdingsClient = usePublicClient({ chainId }) as PublicClient | undefined
  const queries = useQueryClient()
  const [continuation, setContinuation] = useState<{ cursor: string; blockNumber: bigint }>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [manual, setManual] = useState('')
  const [recipient, setRecipient] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const tx = useSafeTx(plan?.chainId ?? chainId)
  const client = usePublicClient({ chainId: plan?.chainId ?? chainId }) as PublicClient | undefined
  const [proof, setProof] = useState<'idle' | 'checking' | 'verified' | 'reverted' | 'error'>('idle')
  const [failedTransaction, setFailedTransaction] = useState<{ hash: Hex; chainId: JBChainId }>()
  const [proposalHash, setProposalHash] = useState<Hex>()
  const recovery = useRef<ReviewedWriteRecoveryRecord | null>(null)
  const sending = useRef(false)
  const sent = useRef(false)
  const [writeStarted, setWriteStarted] = useState(false)
  const markWrite = (value: boolean) => { sent.current = value; setWriteStarted(value) }
  const identity = `${chainId}:${projectId}:${shop.hook.toLowerCase()}:${address?.toLowerCase() ?? ''}`
  const actorContext = useRef({ identity, generation: 0 })
  if (actorContext.current.identity !== identity) actorContext.current = { identity, generation: actorContext.current.generation + 1 }
  const actorChanged = !!plan && (plan.chainId !== chainId || plan.projectId !== projectId || plan.result.inventory.hook.toLowerCase() !== shop.hook.toLowerCase() || plan.account.toLowerCase() !== address?.toLowerCase())
  const held = (writeStarted && proof !== 'verified') || tx.busy || tx.phase === 'submitted' || (!!tx.hash && tx.phase !== 'error') || proof === 'checking'
  const busy = preparing || held
  useEffect(() => {
    setSelected(new Set())
    setManual('')
    setContinuation(undefined)
    if (!sent.current && !tx.hash && tx.phase !== 'pending' && tx.phase !== 'unconfirmed' && tx.phase !== 'submitted' && !sending.current) {
      setPlan(null)
      setPreparing(false)
      setError(null)
      setProof('idle')
      tx.reset()
    }
    // Preserve submitted context for recovery; clear only preparations belonging to the previous actor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])
  const holdings = useQuery({
    queryKey: [...DEFIFA_HOLDINGS_QUERY_PREFIX, chainId, projectId, shop.hook, address, continuation?.blockNumber.toString(), continuation?.cursor],
    enabled: !!holdingsClient && !!address,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => getDefifaHoldings(holdingsClient!, {
      chainId, projectId: BigInt(projectId), account: address!, expectedHook: shop.hook, limit: 100,
      ...continuation,
    }),
  })

  const verifyReceipt = async () => {
    if (!client || !plan || !tx.receipt) return
    setProof('checking')
    setError(null)
    try {
      await verifyDefifaNftTransaction(client, {
        hook: plan.result.inventory.hook, implementation: plan.result.inventory.implementation,
        account: plan.account, transaction: plan.result.transaction,
        ...(proposalHash ? { safe: { proposalHash } } : {}),
      }, tx.receipt)
      if (recovery.current) await clearDefifaWriteRecovery({ chainId: plan.chainId, projectId: plan.projectId, account: plan.account, action: plan.kind }, recovery.current)
      recovery.current = null
      setProof('verified')
      setContinuation(undefined)
      setSelected(new Set())
      setManual('')
      await queries.cancelQueries({ queryKey: DEFIFA_HOLDINGS_QUERY_PREFIX })
      await Promise.all([
        queries.invalidateQueries({ queryKey: DEFIFA_HOLDINGS_QUERY_PREFIX }),
        queries.invalidateQueries({ queryKey: SHOP_721_QUERY_PREFIX }),
        queries.invalidateQueries({ queryKey: ['payNftProtocol'] }),
      ])
    } catch (reason) {
      if (reason instanceof DefifaNftTransactionRevertedError && reason.chainId === plan.chainId && reason.hash.toLowerCase() === tx.receipt.transactionHash.toLowerCase()) {
        try {
          if (recovery.current) await clearDefifaWriteRecovery({ chainId: plan.chainId, projectId: plan.projectId, account: plan.account, action: plan.kind }, recovery.current)
          recovery.current = null
        } catch (cleanupError) {
          setError(`The failed receipt is authenticated, but recovery could not be cleared. ${message(cleanupError)}`)
          setProof('error')
          return
        }
        setFailedTransaction({ hash: tx.receipt.transactionHash, chainId: plan.chainId })
        markWrite(false)
        setError('The reviewed transaction reverted onchain. Its failed receipt is retained; close this review to prepare a new action.')
        setProof('reverted')
      } else {
        setError(`Transaction submitted, but its NFT effects are not verified. ${message(reason)}`)
        setProof('error')
      }
    }
  }
  useEffect(() => {
    if ((tx.phase === 'success' || tx.phase === 'error') && tx.receipt && plan && proof === 'idle') void verifyReceipt()
    // Verification is bound to the frozen plan and exact receipt; retries are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase, tx.receipt, plan, proposalHash, proof])

  const prepare = async (kind: Plan['kind']) => {
    if (!address || !client || busy || sending.current) return
    const generation = actorContext.current.generation
    const signal = flowSignal()
    if (signal.aborted) return
    setPreparing(true)
    setError(null)
    try {
      const raw = [...selected, ...manual.split(/[\s,]+/).filter(Boolean)]
      if (!raw.length || raw.some(value => !/^[1-9]\d{0,77}$/.test(value))) throw new Error('Select NFTs or enter valid positive token IDs.')
      const tokenIds = [...new Set(raw)].map(BigInt)
      if (tokenIds.length > MAX_DEFIFA_ACTION_NFTS) throw new Error(`Select at most ${MAX_DEFIFA_ACTION_NFTS} NFTs per action.`)
      if (kind === 'cash-out' && shop.phase !== undefined && !defifaPhaseAllowsCashOut(shop.phase)) throw new Error('NFT cash-out is not available in this phase.')
      if (kind === 'transfer' && tokenIds.length !== 1) throw new Error('Select exactly one NFT to transfer.')
      if (kind === 'transfer' && (!isAddress(recipient) || recipient === zeroAddress)) throw new Error('Enter a valid nonzero recipient address.')
      const to = kind === 'transfer' ? recipient as Address : address
      const context = { chainId, projectId: BigInt(projectId), account: address, expectedHook: shop.hook }
      let result: CashOut | Transfer
      let minimum = 0n
      if (kind === 'cash-out') {
        const quote = await prepareDefifaCashOut(client, { ...context, tokenIds })
        if (signal.aborted || actorContext.current.generation !== generation) return
        if (quote.reclaimAmount === 0n && quote.protocolRewards.defifaAmount === 0n && quote.protocolRewards.baseProtocolAmount === 0n) throw new Error('These NFTs have nothing to claim right now.')
        minimum = quote.reclaimAmount > 0n ? slippageFloor(quote.reclaimAmount) : 0n
        result = minimum > 0n ? await prepareDefifaCashOut(client, { ...context, tokenIds, minimumReclaim: minimum }) : quote
      } else result = await prepareDefifaTransfer(client, { ...context, tokenId: tokenIds[0], recipient: to })
      if (signal.aborted || actorContext.current.generation !== generation) return
      if (getAccount(config).address?.toLowerCase() !== address.toLowerCase()) throw new Error('Your account changed. Review again.')
      tx.reset()
      setProof('idle')
      markWrite(false)
      setProposalHash(undefined)
      setPlan({ kind, account: address, tokenIds, recipient: to, minimum, result, chainId, projectId, symbol: shop.pricing.symbol })
    } catch (reason) { if (!signal.aborted && actorContext.current.generation === generation) setError(message(reason)) } finally { if (!signal.aborted && actorContext.current.generation === generation) setPreparing(false) }
  }
  const confirm = async () => {
    if (!plan || !client || busy || sending.current || proof !== 'idle') return
    if (plan.chainId !== chainId || plan.projectId !== projectId || plan.result.inventory.hook.toLowerCase() !== shop.hook.toLowerCase()) {
      setError('The project changed. Return to the reviewed project before continuing.')
      return
    }
    const generation = actorContext.current.generation
    const signal = flowSignal()
    const assertWriteState = () => {
      if (signal.aborted) throw new Error('This NFT action closed before submission. Prepare it again.')
      if (actorContext.current.generation !== generation) throw new Error('Your account or project changed before submission. Prepare this action again.')
    }
    sending.current = true
    setError(null)
    try {
      const hash = await sendRecoverableDefifaWrite({
        scope: { chainId: plan.chainId, projectId: plan.projectId, account: plan.account, action: plan.kind },
        request: plan.result.transaction, safe: tx.isSafe, send: (request, options) => tx.send(request, options),
        onRecord: record => { recovery.current = record; markWrite(record !== null) },
        options: {
        reviewedAccount: plan.account,
        assertWriteState,
        beforeWrite: () => {
          assertWriteState()
          markWrite(true)
        },
        onBeforeWriteAborted: () => markWrite(false),
        onWriteRejected: () => markWrite(false),
        reverify: async () => {
          assertWriteState()
          const context = { chainId: plan.chainId, projectId: BigInt(plan.projectId), account: plan.account, expectedHook: plan.result.inventory.hook }
          const fresh = plan.kind === 'cash-out'
            ? await prepareDefifaCashOut(client, { ...context, tokenIds: plan.tokenIds, minimumReclaim: plan.minimum })
            : await prepareDefifaTransfer(client, { ...context, tokenId: plan.tokenIds[0], recipient: plan.recipient })
          assertWriteState()
          if (requestKey(fresh) !== requestKey(plan.result) || fresh.inventory.implementation.toLowerCase() !== plan.result.inventory.implementation.toLowerCase() || fresh.inventory.phase !== plan.result.inventory.phase ||
            ('reclaimAmount' in fresh && 'reclaimAmount' in plan.result && (fresh.reclaimAmount !== plan.result.reclaimAmount || rewardsKey(fresh) !== rewardsKey(plan.result)))) {
            throw new Error('The NFT action changed. Close this review and prepare it again.')
          }
        },
        },
      })
      if (hash) {
        markWrite(true)
        if (tx.isSafe) setProposalHash(hash)
      }
    } catch (reason) { setError(message(reason)) } finally {
      sending.current = false
      if (!sent.current && actorContext.current.generation !== generation) { setPlan(null); setPreparing(false) }
    }
  }
  const close = () => {
    if (tx.busy || proof === 'checking') return
    // Dismiss the local review only after the SDK confirms its unresolved intent remains recoverable.
    if (proof !== 'verified' && proof !== 'reverted' && (tx.hash || tx.phase === 'submitted' || sent.current)) {
      try {
        if (!plan || !recovery.current) throw new Error('The original action is not yet saved for recovery.')
        const retained = readDefifaWriteRecovery({ chainId: plan.chainId, projectId: plan.projectId, account: plan.account, action: plan.kind })
        if (!retained || retained.id !== recovery.current.id) throw new Error('The original action could not be confirmed in recovery storage.')
        void queries.invalidateQueries({ queryKey: DEFIFA_RECOVERY_QUERY_PREFIX })
      } catch (reason) { setError(message(reason)); return }
    }
    markWrite(false)
    setPlan(null)
    setSelected(new Set())
    setManual('')
    setProof('idle')
    tx.dismiss()
  }
  const empty = holdings.data?.complete === true && holdings.data.totalOwned === 0n
  const cash = plan && 'reclaimAmount' in plan.result ? plan.result : null
  const status = writeStarted && !tx.hash && tx.phase !== 'submitted' && !tx.busy && proof !== 'verified' ? 'Wallet submission outcome is unknown. Verify its outcome before submitting another action.' : sent.current && actorChanged && proof !== 'verified' ? 'Account or project changed. The in-flight action is retained for recovery; confirm its outcome before submitting another action.' : proof === 'reverted' ? 'The reviewed transaction reverted onchain.' : proof === 'verified' ? 'NFT effects verified onchain.' : proof === 'checking' ? 'Verifying NFT effects…' : tx.notice ?? (tx.phase === 'pending' ? 'Transaction submitted. Awaiting confirmation.' : tx.phase === 'success' ? 'Receipt received. NFT verification is pending.' : undefined)
  return <DefifaRecovery chainId={chainId} projectId={projectId} account={address} hook={shop.hook} actions={['cash-out', 'transfer']} active={!!plan}><div className="card mt-5 space-y-4 p-5">
    <span className="field-label">Your Defifa NFTs</span>
    {!address ? <><p className="text-sm">Connect a wallet to see and manage your NFTs.</p><button type="button" onClick={openSignIn} className="btn-primary px-4 py-2">Connect wallet</button></> : <>
      {holdings.isLoading ? <p role="status">Checking NFT ownership…</p> : holdings.isError ? <div role="alert">{message(holdings.error)} <button type="button" onClick={() => void holdings.refetch()} disabled={busy}>Retry</button></div> : holdings.data ? <>
        <p className="text-sm">{empty ? 'You do not own any NFTs from this collection.' : `${holdings.data.totalOwned.toString()} NFTs owned. ${holdings.data.complete ? 'Ownership scan complete.' : 'Partial ownership scan. Load more candidates to find remaining NFTs.'}`}</p>
        {!empty ? <div className="flex max-h-64 flex-wrap gap-3 overflow-y-auto">
          {holdings.data.tokens.map(token => <label key={token.tokenId.toString()} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy || !!plan} checked={selected.has(token.tokenId.toString())} onChange={() => setSelected(previous => {
            const next = new Set(previous); const id = token.tokenId.toString(); if (next.has(id)) next.delete(id); else next.add(id); return next
          })} />{shop.tiers.find(tier => tier.id === token.tierId)?.name ?? `Tier ${token.tierId}`}, token {token.tokenId.toString()}</label>)}
        </div> : null}
        {holdings.data.nextCursor ? <button type="button" disabled={busy || !!plan} onClick={() => { setSelected(new Set()); setContinuation({ cursor: holdings.data!.nextCursor!, blockNumber: holdings.data!.blockNumber }) }}>Load next ownership page</button> : null}
      </> : null}
      <button type="button" disabled={busy || !!plan} onClick={() => { setSelected(new Set()); if (continuation) setContinuation(undefined); else void holdings.refetch() }}>Refresh ownership</button>
      {!empty ? <>
      <label className="block text-sm">Token IDs, optional manual selection<input className="input-well mt-1 w-full px-3 py-2" value={manual} disabled={busy || !!plan} onChange={event => setManual(event.target.value)} placeholder="Token IDs separated by commas" /></label>
      <p className="text-xs text-smoke-700">Manual IDs are verified against current ownership before review.</p>
      <label className="block text-sm">Transfer recipient<input className="input-well mt-1 w-full px-3 py-2" value={recipient} disabled={busy || !!plan} onChange={event => setRecipient(event.target.value)} placeholder="0x…" /></label>
      <div className="flex flex-wrap gap-3">{shop.phase === undefined || defifaPhaseAllowsCashOut(shop.phase) ? <button type="button" className="btn-primary px-4 py-2" disabled={busy || !!plan} onClick={() => void prepare('cash-out')}>Cash out Defifa NFTs</button> : <p className="text-sm">NFT cash-out is not available in this phase.</p>}<button type="button" className="btn-secondary px-4 py-2" disabled={busy || !!plan} onClick={() => void prepare('transfer')}>Transfer Defifa NFT</button></div>
      </> : null}
    </>}
    {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    {proof === 'error' ? <button type="button" onClick={() => void verifyReceipt()}>Retry receipt verification</button> : null}
    {tx.hash ? <a className="block text-sm underline" href={etherscanTxUrl(plan?.chainId ?? chainId, tx.hash) ?? undefined} target="_blank" rel="noopener noreferrer">View transaction</a> : null}
    {failedTransaction && failedTransaction.hash !== tx.hash ? <a className="block text-sm underline" href={etherscanTxUrl(failedTransaction.chainId, failedTransaction.hash) ?? undefined} target="_blank" rel="noopener noreferrer">View previous failed transaction</a> : null}
    {plan ? <TxConfirmDialog open title={plan.kind === 'cash-out' ? 'Cash out Defifa NFTs' : 'Transfer Defifa NFT'} rows={[
      { label: 'Account', value: plan.account, mono: true }, { label: 'NFTs', value: plan.tokenIds.map(String).join(', ') },
      { label: 'Recipient', value: plan.recipient, mono: true },
      ...(cash ? [{ label: 'Reclaimed', value: `${formatTokenAmount(cash.reclaimAmount, cash.inventory.pricing.decimals)} ${plan.symbol}` },
        { label: 'Minimum', value: `${formatTokenAmount(plan.minimum, cash.inventory.pricing.decimals)} ${plan.symbol}` },
        { label: 'Protocol rewards', value: `${formatTokenAmount(cash.protocolRewards.defifaAmount, cash.protocolRewards.defifaDecimals)} at ${cash.protocolRewards.defifaToken}, ${formatTokenAmount(cash.protocolRewards.baseProtocolAmount, cash.protocolRewards.baseProtocolDecimals)} at ${cash.protocolRewards.baseProtocolToken}` }] : []),
    ]} steps={[{ title: 'Review and submit' }, { title: 'Verify NFT effects' }]} activeIndex={tx.phase === 'success' ? 1 : 0} action="Confirm NFT action" onConfirm={() => void confirm()} onClose={close} busy={tx.busy || proof === 'checking'} actionDisabled={held || proof !== 'idle'} complete={proof === 'verified' || proof === 'reverted'} status={status} error={error ?? tx.error} /> : null}
  </div></DefifaRecovery>
}
