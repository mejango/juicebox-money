'use client'

import { TxSteps } from '@/components/ui/TxSteps'
import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import { UNISWAP_PERMIT2_ADDRESS } from '@bananapus/nana-sdk-core/v6'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { erc20Abi, formatUnits, type Address, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { TxError } from '@/components/ui/TxError'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useViewedAccount } from '@/hooks/useViewedAccount'
import { bandPrices } from '@/lib/edit-liquidity'
import { FlowError, shortError } from '@/lib/errors'
import { formatTokenAmount } from '@/lib/format'
import {
  buildMarketEdit,
  marketEditStillFits,
  type MarketCorridor,
  type MarketEditPlan,
  type MarketSideEdit,
  type MarketSides,
} from '@/lib/market-liquidity'
import { isSafeConnection, swapDeadline } from '@/lib/safe-connector'
import {
  buildErc20ApproveRequest,
  buildModifyLiquiditiesRequest,
  buildPermit2ApproveRequest,
} from '@/lib/transaction-builders'
import { wagmiConfig } from '@/providers/Providers'
import { chainName } from '@/lib/urn'
import { buildPlan, type Step } from './AddLiquidityFlow'
import { formatPrice } from './chartUtils'
import { LiquidityRangePreview } from './LiquidityRangePreview'
import {
  readUserLpPositions,
  resolveMarket,
  type MarketResult,
  type UserLpPosition,
} from './MarketSection'

type Pool = Extract<MarketResult, { status: 'pool' }>

const SIDE_VERB: Record<MarketSideEdit['kind'], string> = {
  increase: 'tops up',
  decrease: 'frees part of',
  remove: 'removes',
  move: 're-fits',
  mint: 'mints',
  keep: 'keeps',
}

type Reviewed = {
  account: Address
  pool: Pool
  plan: MarketEditPlan
  steps: Step[]
}

function parseAmount(text: string, decimals: number, symbol: string): bigint {
  const trimmed = text.trim()
  if (trimmed === '') return 0n
  try {
    const amount = BigInt(Math.round(Number(trimmed) * 10 ** Math.min(decimals, 6)))
    if (!Number.isFinite(Number(trimmed)) || amount < 0n) throw new Error()
    // Exact parse for the full decimals; the float above only validates.
    const [whole, fraction = ''] = trimmed.split('.')
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals))
  } catch {
    throw new FlowError(`Enter a valid ${symbol} amount.`)
  }
}

/** Whether either side's band no longer matches the corridor: the stage moved the ceiling or the floor. */
function corridorMoved(pool: Pool, sides: MarketSides, corridor: MarketCorridor): boolean {
  const off = (actual: number, expected: number) => Math.abs(actual - expected) / expected > 0.005
  if (sides.tokenSide) {
    const band = bandPrices(pool, sides.tokenSide.tickLower, sides.tokenSide.tickUpper)
    if (off(band.max, corridor.ceiling)) return true
  }
  if (sides.pairSide) {
    const band = bandPrices(pool, sides.pairSide.tickLower, sides.pairSide.tickUpper)
    if (off(band.min, corridor.floor)) return true
  }
  return false
}

/**
 * Edit a market: what each side holds, and whether both sides get re-fit to
 * the corridor as it stands now. Each side is its own position, so a change
 * on one side never burns the other. Approvals a top-up needs are queued
 * ahead of the edit as reviewed transactions, the plan is sized from a fresh
 * pool and position read at review time, and it is re-checked right before
 * the wallet asks.
 */
export function MarketEditPanel({
  chainId,
  projectId,
  pool,
  positionManager,
  sides,
  sym,
  floor,
  startEmpty = false,
  onClose,
  onDone,
}: {
  chainId: JBChainId
  projectId: number
  pool: Pool
  positionManager: Address
  sides: MarketSides
  sym: string
  floor: number | null
  /** Open with both sides at 0 — the market's Remove action. */
  startEmpty?: boolean
  onClose: () => void
  onDone: (hash: `0x${string}` | null) => void
}) {
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const { connectedAddress, isViewAs } = useViewedAccount()
  const tx = useSafeTx(chainId)
  const queryClient = useQueryClient()
  const nativeSymbol = JB_CHAINS[chainId]?.nativeTokenSymbol ?? 'ETH'
  const pairSym = pool.pair.symbol
  const pairDec = pool.pair.decimals
  const projectToken = pool.pairIsC0 ? pool.key.currency1 : pool.key.currency0
  const corridor = useMemo<MarketCorridor | null>(
    () => (floor && pool.issuance && pool.issuance > floor ? { floor, ceiling: pool.issuance } : null),
    [floor, pool.issuance],
  )

  const [tokText, setTokText] = useState(
    startEmpty ? '0' : formatUnits(sides.tokenSide?.tokenAmount ?? 0n, 18),
  )
  const [pairText, setPairText] = useState(
    startEmpty ? '0' : formatUnits(sides.pairSide?.pairAmount ?? 0n, pairDec),
  )
  const moved = corridor ? corridorMoved(pool, sides, corridor) : false
  const [refit, setRefit] = useState(moved)
  const [reviewed, setReviewed] = useState<Reviewed | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [running, setRunning] = useState(false)
  const [stepIdx, setStepIdx] = useState(0)
  const [done, setDone] = useState<`0x${string}` | null>(null)

  const planRef = useRef<Reviewed | null>(null)
  const runningRef = useRef(false)
  const stepIdxRef = useRef(0)
  const processedRef = useRef<string | null>(null)
  const approvalBlockRef = useRef<bigint | undefined>(undefined)

  const balances = useQuery({
    queryKey: ['lpEditBalances', chainId, pool.poolId, connectedAddress],
    enabled: !!client && !!connectedAddress,
    queryFn: async () => {
      const [tok, pair] = await Promise.all([
        client!.readContract({
          address: projectToken,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [connectedAddress!],
        }) as Promise<bigint>,
        pool.pair.isNative
          ? client!.getBalance({ address: connectedAddress! })
          : (client!.readContract({
              address: pool.pair.tokenOrig,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [connectedAddress!],
            }) as Promise<bigint>),
      ])
      return { tok, pair }
    },
  })

  const labelFor = useCallback(
    (token: Address): string =>
      token.toLowerCase() === projectToken.toLowerCase() ? sym : pairSym,
    [projectToken, sym, pairSym],
  )

  const busy = quoting || running || tx.busy
  const editing = busy || reviewed !== null

  const preview = useMemo(() => {
    if (!corridor) return null
    try {
      return buildMarketEdit({
        pool,
        sides,
        targets: {
          tokenAmount: parseAmount(tokText, 18, sym),
          pairAmount: parseAmount(pairText, pairDec, pairSym),
        },
        corridor,
        refit,
        account: connectedAddress ?? '0x0000000000000000000000000000000000000000',
      })
    } catch {
      return null
    }
  }, [corridor, tokText, pairText, refit, pool, sides, connectedAddress, sym, pairSym, pairDec])

  // Fresh pool and both positions, read together so neither is sized stale.
  const readLive = async (account: Address) => {
    const market = await resolveMarket(client!, chainId, projectId, nativeSymbol)
    if (market.status !== 'pool' || market.poolId !== pool.poolId) {
      throw new FlowError('The pool changed while this list was open. Reopen it and try again.')
    }
    const positions = await readUserLpPositions(client!, chainId, market, account)
    const find = (side: UserLpPosition | null) =>
      side ? (positions.find(p => p.tokenId === side.tokenId) ?? null) : null
    const fresh: MarketSides = { tokenSide: find(sides.tokenSide), pairSide: find(sides.pairSide) }
    if ((sides.tokenSide && !fresh.tokenSide) || (sides.pairSide && !fresh.pairSide)) {
      throw new FlowError('A position in this market is no longer owned by your wallet.')
    }
    return { market, fresh, positions }
  }

  const handleReview = async () => {
    if (!connectedAddress || !client || busy || !corridor) return
    setReviewError(null)
    setQuoting(true)
    try {
      const tokenAmount = parseAmount(tokText, 18, sym)
      const pairAmount = parseAmount(pairText, pairDec, pairSym)
      const { market, fresh } = await readLive(connectedAddress)
      const plan = buildMarketEdit({
        pool: market,
        sides: fresh,
        targets: { tokenAmount, pairAmount },
        corridor,
        refit,
        account: connectedAddress,
      })
      const held = balances.data ?? (await balances.refetch()).data
      if (!held) throw new FlowError('Could not read your wallet balances.')
      if (plan.tokenFlow > held.tok) throw new FlowError(`That's more ${sym} than your balance.`)
      if (plan.pairFlow > held.pair) throw new FlowError(`That's more ${pairSym} than your balance.`)
      const steps = await buildPlan(
        client,
        connectedAddress,
        positionManager,
        { erc20: plan.erc20 },
        labelFor,
        'Edit the market',
      )
      const built: Reviewed = { account: connectedAddress, pool: market, plan, steps }
      planRef.current = built
      setReviewed(built)
    } catch (e) {
      setReviewError(
        e instanceof FlowError ? e.message : e instanceof Error ? shortError(e) : 'Something went wrong.',
      )
    } finally {
      setQuoting(false)
    }
  }

  const sendStep = useCallback(
    (step: Step) => {
      const p = planRef.current
      if (!p) return
      if (step.kind === 'approve-erc20') {
        tx.send(
          buildErc20ApproveRequest({
            chainId,
            token: step.token,
            spender: UNISWAP_PERMIT2_ADDRESS,
            amount: step.amount,
          }),
        )
      } else if (step.kind === 'permit2-approve') {
        tx.send(
          buildPermit2ApproveRequest({
            chainId,
            token: step.token,
            positionManager,
            amount: step.amount,
            expiration: step.expiration,
          }),
        )
      } else {
        tx.send(
          buildModifyLiquiditiesRequest({
            chainId,
            positionManager,
            unlockData: p.plan.unlockData,
            deadline: swapDeadline(isSafeConnection(wagmiConfig)),
            value: p.plan.value,
          }),
          {
            simulationBlockNumber: approvalBlockRef.current,
            reviewNotice: describeMarketEdit(p.pool, p.plan, sym),
            reverify: async () => {
              if (!client) return
              const { market, positions } = await readLive(p.account)
              const problem = marketEditStillFits(p.plan, {
                sqrtP: market.sqrtP,
                liquidityOf: id => positions.find(pos => pos.tokenId === id)?.liquidity,
              })
              if (problem) throw new FlowError(problem)
            },
          },
        )
      }
    },
    // readLive closes over stable props; the plan itself is read from the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tx, chainId, positionManager, client, sym],
  )

  useEffect(() => {
    if (!runningRef.current) return
    const p = planRef.current
    if (!p) return
    if (tx.phase === 'success' && tx.hash && tx.hash !== processedRef.current) {
      processedRef.current = tx.hash
      const block = tx.receipt?.blockNumber
      if (block !== undefined && (approvalBlockRef.current === undefined || block > approvalBlockRef.current)) {
        approvalBlockRef.current = block
      }
      const isLast = stepIdxRef.current >= p.steps.length - 1
      if (isLast) {
        runningRef.current = false
        setRunning(false)
        setDone(tx.hash)
        void queryClient.invalidateQueries({ queryKey: ['userLpPositions'] })
        void queryClient.invalidateQueries({ queryKey: ['userLpFees'] })
        void queryClient.invalidateQueries({ queryKey: ['market'] })
        onDone(tx.hash)
      } else {
        const next = stepIdxRef.current + 1
        stepIdxRef.current = next
        setStepIdx(next)
        tx.reset()
        sendStep(p.steps[next])
      }
    } else if (tx.phase === 'error') {
      runningRef.current = false
      setRunning(false)
    }
  }, [tx.phase, tx.hash, tx, sendStep, queryClient, onDone])

  const startRun = () => {
    if (!reviewed || runningRef.current) return
    if (!connectedAddress || connectedAddress.toLowerCase() !== reviewed.account.toLowerCase()) {
      planRef.current = null
      setReviewed(null)
      setReviewError('Your connected account changed — review again.')
      return
    }
    processedRef.current = null
    stepIdxRef.current = 0
    setStepIdx(0)
    tx.reset()
    runningRef.current = true
    setRunning(true)
    sendStep(reviewed.steps[0])
  }

  const resume = () => {
    if (!reviewed || runningRef.current) return
    tx.reset()
    processedRef.current = null
    runningRef.current = true
    setRunning(true)
    sendStep(reviewed.steps[stepIdxRef.current])
  }

  const back = () => {
    runningRef.current = false
    processedRef.current = null
    stepIdxRef.current = 0
    setRunning(false)
    setStepIdx(0)
    planRef.current = null
    setReviewed(null)
    setReviewError(null)
    tx.reset()
  }

  const amountsText = (token: bigint, pair: bigint) =>
    [
      token > 0n ? `${formatTokenAmount(token, 18)} ${sym}` : null,
      pair > 0n ? `${formatTokenAmount(pair, pairDec)} ${pairSym}` : null,
    ]
      .filter(Boolean)
      .join(' + ')
  const positive = (amount: bigint) => (amount > 0n ? amount : 0n)
  const sideLine = (side: MarketSideEdit | null, own: 'token' | 'pair') => {
    if (!side) return null
    const symbol = own === 'token' ? sym : pairSym
    const decimals = own === 'token' ? 18 : pairDec
    const id = side.tokenId !== null ? ` #${side.tokenId.toString()}` : ''
    return `${SIDE_VERB[side.kind]}${id}, holds ~${formatTokenAmount(side.holding, decimals)} ${symbol}`
  }
  const ids = [sides.tokenSide, sides.pairSide]
    .filter((side): side is UserLpPosition => side !== null)
    .map(side => `#${side.tokenId.toString()}`)
    .join(' + ')
  const inWallet = (amount: bigint | undefined, decimals: number, symbol: string) =>
    amount == null ? null : (
      <span className="mt-1 block text-right text-xs text-smoke-500">
        {formatTokenAmount(amount, decimals)} {symbol} in wallet
      </span>
    )

  if (done) {
    return (
      <div className="mt-3 border border-smoke-200 p-3">
        <p className="text-xs font-medium text-ink">
          Market {ids} on {chainName(chainId)} updated.
        </p>
        <p className="mt-1 text-xs text-smoke-500">The table above reflects it.</p>
        <button type="button" className="btn-secondary mt-3 min-h-[32px] px-3 text-xs" onClick={onClose}>
          Close
        </button>
      </div>
    )
  }

  return (
    <div className="mt-3 border border-smoke-200 p-3">
      <p className="text-xs font-medium text-ink">
        Edit market {ids} on {chainName(chainId)}
      </p>
      <p className="mt-1 text-xs text-smoke-500">
        {sym} sells from the current price up to the ceiling; {pairSym} buys from the current
        price down to the floor. Each side is its own position, so each amount is used in full
        and a change on one side never touches the other. Anything added comes from your wallet
        and anything freed returns to it, with unclaimed fees, in one transaction.
      </p>
      <LiquidityRangePreview
        floor={floor}
        ceiling={pool.issuance ?? null}
        current={pool.price}
        minimum={corridor?.floor ?? 0}
        maximum={corridor?.ceiling ?? 0}
        pairSymbol={pairSym}
        tokenSymbol={sym}
      />
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-xs text-smoke-500">
          {sym} to sell above the price
          <input
            className="input-well mt-1 min-h-[40px] w-full px-3 text-sm"
            type="number"
            min="0"
            placeholder="0"
            value={tokText}
            disabled={editing}
            onChange={event => setTokText(event.target.value)}
          />
          {inWallet(balances.data?.tok, 18, sym)}
        </label>
        <label className="text-xs text-smoke-500">
          {pairSym} to buy with below the price
          <input
            className="input-well mt-1 min-h-[40px] w-full px-3 text-sm"
            type="number"
            min="0"
            placeholder="0"
            value={pairText}
            disabled={editing}
            onChange={event => setPairText(event.target.value)}
          />
          {inWallet(balances.data?.pair, pairDec, pairSym)}
        </label>
      </div>
      {corridor ? (
        <label className="mt-2 flex items-start gap-2 text-xs text-smoke-700">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={refit}
            disabled={editing}
            onChange={event => setRefit(event.target.checked)}
          />
          <span>
            Re-fit both sides to the current corridor ({formatPrice(corridor.floor)} –{' '}
            {formatPrice(corridor.ceiling)} {pairSym}/{sym}).
            {moved
              ? ' The floor or ceiling moved since these positions were minted, so their edges are stale.'
              : ' Not needed right now — the positions already match it.'}
          </span>
        </label>
      ) : (
        <p className="mt-2 text-xs text-smoke-500">
          This project has no floor and ceiling to fit a market to, so the sides can only be
          topped up, freed or removed as they are.
        </p>
      )}
      {preview ? (
        <p className="mt-1.5 text-xs leading-relaxed text-smoke-700" role="status">
          {[sideLine(preview.token, 'token'), sideLine(preview.pair, 'pair')]
            .filter(Boolean)
            .map((line, index) => `${index === 0 ? sym : pairSym} side ${line}`)
            .join('. ')}
          .
        </p>
      ) : null}
      <p className="mt-1.5 text-xs leading-relaxed text-smoke-500">
        Set a side to 0 to remove that position. Both at 0 removes the market.
      </p>

      {reviewed ? (
        <div className="mt-3 space-y-4">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <span className="text-smoke-500">Market</span>
            <span className="text-right text-ink">
              {ids} on {chainName(chainId)}
            </span>
            <span className="text-smoke-500">Corridor</span>
            <span className="text-right text-ink">
              {corridor ? `${formatPrice(corridor.floor)} – ${formatPrice(corridor.ceiling)} ${pairSym}/${sym}` : '—'}
              {reviewed.plan.refit ? ' (re-fit)' : ' (kept)'}
            </span>
            {reviewed.plan.token ? (
              <>
                <span className="text-smoke-500">{sym} side</span>
                <span className="text-right text-ink">{sideLine(reviewed.plan.token, 'token')}</span>
              </>
            ) : null}
            {reviewed.plan.pair ? (
              <>
                <span className="text-smoke-500">{pairSym} side</span>
                <span className="text-right text-ink">{sideLine(reviewed.plan.pair, 'pair')}</span>
              </>
            ) : null}
            {reviewed.plan.tokenFlow > 0n || reviewed.plan.pairFlow > 0n ? (
              <>
                <span className="text-smoke-500">From your wallet</span>
                <span className="text-right text-ink">
                  {amountsText(positive(reviewed.plan.tokenFlow), positive(reviewed.plan.pairFlow))}
                </span>
              </>
            ) : null}
            <span className="text-smoke-500">Back to your wallet</span>
            <span className="text-right text-ink">
              {reviewed.plan.tokenFlow < 0n || reviewed.plan.pairFlow < 0n
                ? `${amountsText(positive(-reviewed.plan.tokenFlow), positive(-reviewed.plan.pairFlow))} + unclaimed fees`
                : 'Unclaimed fees'}
            </span>
            {reviewed.plan.tokenFunding > 0n || reviewed.plan.pairFunding > 0n ? (
              <>
                <span className="text-smoke-500">Authorizes up to</span>
                <span className="text-right text-ink">
                  {amountsText(reviewed.plan.tokenFunding, reviewed.plan.pairFunding)} (1% price headroom)
                </span>
              </>
            ) : null}
            {reviewed.plan.tokenMinimum > 0n || reviewed.plan.pairMinimum > 0n ? (
              <>
                <span className="text-smoke-500">Enforced onchain</span>
                <span className="text-right text-ink">
                  At least {amountsText(reviewed.plan.tokenMinimum, reviewed.plan.pairMinimum)} back (95% floors)
                </span>
              </>
            ) : null}
          </div>
          {balances.data &&
          (reviewed.plan.tokenFunding > balances.data.tok || reviewed.plan.pairFunding > balances.data.pair) ? (
            <p className="text-sm text-orange-600">
              Heads up: your balance does not cover the 1% price headroom, so this edit reverts if
              the price moves against it. Lower the amount to be safe.
            </p>
          ) : null}
          <TxSteps
            steps={reviewed.steps.map((step, index) => ({ key: `${step.kind}:${index}`, title: step.label }))}
            activeIndex={running || tx.phase === 'error' ? stepIdx : -1}
            className="rounded-xl border border-smoke-200 bg-white p-3"
          />
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="btn-secondary min-h-[44px] px-5 text-sm"
          disabled={busy}
          onClick={reviewed ? back : onClose}
        >
          {reviewed ? 'Back' : 'Cancel'}
        </button>
        <button
          type="button"
          className="btn-primary min-h-[44px] px-5 text-sm"
          disabled={busy || isViewAs || !connectedAddress || !corridor}
          onClick={
            !reviewed
              ? () => void handleReview()
              : running
                ? undefined
                : tx.phase === 'error'
                  ? resume
                  : startRun
          }
        >
          {quoting
            ? 'Checking…'
            : running
              ? 'Editing the market…'
              : reviewed
                ? tx.phase === 'error'
                  ? `Retry step ${stepIdx + 1} of ${reviewed.steps.length}`
                  : 'Edit the market'
                : 'Review edit'}
        </button>
      </div>
      <TxError
        error={reviewError ?? tx.error}
        className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
      />
      {tx.safeNonceGuidance ? <p className="mt-2 text-xs text-smoke-500">{tx.safeNonceGuidance}</p> : null}
    </div>
  )
}

/** The safety-check notice: each side's change in one line, then the wallet flows. */
function describeMarketEdit(pool: Pool, plan: MarketEditPlan, sym: string): string {
  const side = (edit: MarketSideEdit | null, own: 'token' | 'pair') => {
    if (!edit) return null
    const symbol = own === 'token' ? sym : pool.pair.symbol
    const decimals = own === 'token' ? 18 : pool.pair.decimals
    const id = edit.tokenId !== null ? ` position #${edit.tokenId.toString()}` : ' a new position'
    return `${symbol} side: ${SIDE_VERB[edit.kind]}${id}, holding about ${formatTokenAmount(edit.holding, decimals)} ${symbol} afterwards.`
  }
  const pulls = [
    plan.tokenFlow > 0n ? `${formatTokenAmount(plan.tokenFlow, 18)} ${sym}` : null,
    plan.pairFlow > 0n ? `${formatTokenAmount(plan.pairFlow, pool.pair.decimals)} ${pool.pair.symbol}` : null,
  ].filter(Boolean)
  return [
    side(plan.token, 'token'),
    side(plan.pair, 'pair'),
    pulls.length ? `Your wallet pays about ${pulls.join(' + ')}.` : null,
    'Unclaimed fees and anything freed return to your wallet in the same transaction. If the price moves too far before it lands, the whole edit reverts and every position stays as it is.',
  ]
    .filter(Boolean)
    .join(' ')
}
