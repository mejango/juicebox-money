'use client'

import { TxSteps } from '@/components/ui/TxSteps'
import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import { UNISWAP_PERMIT2_ADDRESS } from '@bananapus/nana-sdk-core/v6'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { erc20Abi, formatUnits, parseUnits, type Address, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { TxError } from '@/components/ui/TxError'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useViewedAccount } from '@/hooks/useViewedAccount'
import {
  bandPrices,
  buildEditLiquidityPlan,
  describeEditLiquidityPlan,
  editLiquidityStillFits,
  type EditLiquidityPlan,
} from '@/lib/edit-liquidity'
import { FlowError, shortError } from '@/lib/errors'
import { formatTokenAmount } from '@/lib/format'
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

const FINAL_STEP: Record<EditLiquidityPlan['kind'], string> = {
  increase: 'Increase the position',
  decrease: 'Decrease the position',
  move: 'Move the position',
  remove: 'Remove the position',
}

type Reviewed = {
  account: Address
  pool: Pool
  plan: EditLiquidityPlan
  steps: Step[]
  copy: { lead: string; detail: string; tech: string }
}

/** A target prefilled at full precision, so an untouched field asks for exactly what the position holds. */
function holdingText(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals)
}

function parseAmount(text: string, decimals: number, symbol: string): bigint {
  const trimmed = text.trim()
  if (trimmed === '') return 0n
  try {
    const amount = parseUnits(trimmed, decimals)
    if (amount < 0n) throw new Error()
    return amount
  } catch {
    throw new FlowError(`Enter a valid ${symbol} amount.`)
  }
}

/**
 * One position's edit form: what it should hold and, optionally, a new band.
 * Amounts are ceilings — the band and the current price fix the ratio, so the
 * review states exactly what the position ends up holding and what moves in
 * or out of the wallet. Approvals a top-up needs are queued ahead of the edit
 * itself (each its own reviewed, simulated transaction, like the add flow),
 * the plan is sized from a fresh pool and position read at review time, and
 * it is re-checked against the live price right before the wallet asks.
 */
export function EditPositionPanel({
  chainId,
  projectId,
  pool,
  positionManager,
  position,
  sym,
  floor,
  onClose,
  onDone,
}: {
  chainId: JBChainId
  projectId: number
  pool: Pool
  positionManager: Address
  position: UserLpPosition
  sym: string
  floor: number | null
  onClose: () => void
  /** Called once the edit has landed (or been proposed to a Safe). */
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
  const band = bandPrices(pool, position.tickLower, position.tickUpper)

  const [minText, setMinText] = useState(String(Number(band.min.toPrecision(6))))
  const [maxText, setMaxText] = useState(String(Number(band.max.toPrecision(6))))
  // Only a band the user actually changed re-mints; otherwise the position's
  // own ticks are kept exactly, never re-derived from rounded display prices.
  const [rangeTouched, setRangeTouched] = useState(false)
  const [tokText, setTokText] = useState(holdingText(position.tokenAmount, 18))
  const [pairText, setPairText] = useState(holdingText(position.pairAmount, pairDec))
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
  // The block of the most recent approval receipt: the edit must simulate at
  // or after it, or a lagging RPC rejects it on allowance.
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

  // Fresh pool and position, read together so the plan never sizes a fresh
  // position against a stale price.
  const readLive = async (account: Address) => {
    const market = await resolveMarket(client!, chainId, projectId, nativeSymbol)
    if (market.status !== 'pool' || market.poolId !== pool.poolId) {
      throw new FlowError('The pool changed while this list was open. Reopen it and try again.')
    }
    const fresh = (await readUserLpPositions(client!, chainId, market, account)).find(
      p => p.tokenId === position.tokenId,
    )
    if (!fresh) throw new FlowError('This position is no longer owned by your wallet.')
    return { market, fresh }
  }

  const handleReview = async () => {
    if (!connectedAddress || !client || busy) return
    setReviewError(null)
    setQuoting(true)
    try {
      const tokenAmount = parseAmount(tokText, 18, sym)
      const pairAmount = parseAmount(pairText, pairDec, pairSym)
      let range: { pa: number; pb: number } | null = null
      if (rangeTouched) {
        const pa = Number(minText)
        const pb = Number(maxText)
        if (!(pa > 0) || !(pb > pa)) throw new FlowError('Set a valid price range.')
        range = { pa, pb }
      }
      const { market, fresh } = await readLive(connectedAddress)
      const plan = buildEditLiquidityPlan({
        pool: market,
        position: fresh,
        target: { pairAmount, tokenAmount },
        range,
        account: connectedAddress,
      })
      const held = balances.data ?? (await balances.refetch()).data
      if (!held) throw new FlowError('Could not read your wallet balances.')
      // Gate on what the pool actually pulls, not on the maxima: those carry
      // 1% price headroom that only gets spent if the price moves.
      if (plan.tokenFlow > held.tok) throw new FlowError(`That's more ${sym} than your balance.`)
      if (plan.pairFlow > held.pair) {
        throw new FlowError(`That's more ${pairSym} than your balance.`)
      }
      const steps = await buildPlan(
        client,
        connectedAddress,
        positionManager,
        { erc20: plan.erc20 },
        labelFor,
        FINAL_STEP[plan.kind],
      )
      const resulting = bandPrices(market, plan.tickLower, plan.tickUpper)
      const copy = describeEditLiquidityPlan({
        ...plan,
        tokenSymbol: sym,
        pairSymbol: pairSym,
        pairDecimals: pairDec,
        pairIsNative: pool.pair.isNative,
        band:
          plan.kind === 'move'
            ? `${formatPrice(resulting.min)} – ${formatPrice(resulting.max)} ${pairSym}/${sym}`
            : undefined,
      })
      const built: Reviewed = { account: connectedAddress, pool: market, plan, steps, copy }
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
        // Everything that touches funds is frozen inside unlockData; only the
        // deadline is stamped at send time.
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
            reviewNotice: `${p.copy.lead} ${p.copy.detail}`,
            // Runs after the review, so however long it sat open, a changed
            // position or drift beyond the reviewed maxima still aborts first.
            reverify: async () => {
              if (!client) return
              const { market, fresh } = await readLive(p.account)
              const problem = editLiquidityStillFits(p.plan, {
                sqrtP: market.sqrtP,
                liquidity: fresh.liquidity,
              })
              if (problem) throw new FlowError(problem)
            },
          },
        )
      }
    },
    // readLive closes over stable props; the plan itself is read from the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tx, chainId, positionManager, client],
  )

  // Advance through the steps on each receipt.
  useEffect(() => {
    if (!runningRef.current) return
    const p = planRef.current
    if (!p) return
    if (tx.phase === 'success' && tx.hash && tx.hash !== processedRef.current) {
      processedRef.current = tx.hash
      const block = tx.receipt?.blockNumber
      if (
        block !== undefined &&
        (approvalBlockRef.current === undefined || block > approvalBlockRef.current)
      ) {
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
    // The recipient is baked into unlockData: a changed account must re-review.
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
          Position #{position.tokenId.toString()} on {chainName(chainId)} updated.
        </p>
        <p className="mt-1 text-xs text-smoke-500">The table above reflects it.</p>
        <button
          type="button"
          className="btn-secondary mt-3 min-h-[32px] px-3 text-xs"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    )
  }

  return (
    <div className="mt-3 border border-smoke-200 p-3">
      <p className="text-xs font-medium text-ink">
        Edit position #{position.tokenId.toString()} on {chainName(chainId)}
      </p>
      <p className="mt-1 text-xs text-smoke-500">
        Set what this position should hold and the band it covers. Anything added comes from
        your wallet and anything freed returns to it, with unclaimed fees, in one transaction.
        The band and the current price fix the ratio, so amounts are ceilings. Changing the band
        burns this position and mints a new one; if the price moves too far before it lands,
        the whole edit reverts and the position stays as it is.
      </p>
      <LiquidityRangePreview
        floor={floor}
        ceiling={pool.issuance ?? null}
        current={pool.price}
        minimum={Number(minText) || 0}
        maximum={Number(maxText) || 0}
        pairSymbol={pairSym}
        tokenSymbol={sym}
        onRangeChange={
          editing
            ? undefined
            : (edge, value) => {
                ;(edge === 'min' ? setMinText : setMaxText)(String(value))
                setRangeTouched(true)
              }
        }
      />
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-xs text-smoke-500">
          Min price
          <input
            className="input-well mt-1 min-h-[40px] w-full px-3 text-sm"
            type="number"
            min="0"
            value={minText}
            disabled={editing}
            onChange={event => {
              setMinText(event.target.value)
              setRangeTouched(true)
            }}
          />
        </label>
        <label className="text-xs text-smoke-500">
          Max price
          <input
            className="input-well mt-1 min-h-[40px] w-full px-3 text-sm"
            type="number"
            min="0"
            value={maxText}
            disabled={editing}
            onChange={event => {
              setMaxText(event.target.value)
              setRangeTouched(true)
            }}
          />
        </label>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-xs text-smoke-500">
          {sym} in position
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
          {pairSym} in position
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
      <p className="mt-1.5 text-xs leading-relaxed text-smoke-500">
        Set both to 0 to remove the position. Keep the band and raise or lower the amounts to
        top up or free part of it without a new position id.
      </p>

      {reviewed ? (
        <div className="callout callout-info mt-3 text-xs">
          <p className="font-medium">{reviewed.copy.lead}</p>
          <p className="mt-1">{reviewed.copy.detail}</p>
          {balances.data &&
          (reviewed.plan.tokenFunding > balances.data.tok ||
            reviewed.plan.pairFunding > balances.data.pair) ? (
            <p className="mt-1 font-medium">
              Heads up: your balance does not cover the 1% price headroom, so this edit reverts
              if the price moves against it. Lower the amount to be safe.
            </p>
          ) : null}
          <p className="mt-1 text-smoke-700">{reviewed.copy.tech}</p>
          <TxSteps
            steps={reviewed.steps.map((step, index) => ({
              key: `${step.kind}:${index}`,
              title: step.label,
            }))}
            activeIndex={running || tx.phase === 'error' ? stepIdx : -1}
            intro={
              reviewed.steps.length > 1
                ? `${reviewed.steps.length} transactions: ${reviewed.steps.length - 1} approval${reviewed.steps.length - 1 > 1 ? 's' : ''} then the edit. Each is reviewed and simulated before you sign.`
                : 'One transaction. It is reviewed and simulated before you sign.'
            }
            className="mt-2 rounded-xl border border-smoke-200 bg-white p-3"
          />
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary min-h-[32px] px-3 text-xs"
          disabled={busy || isViewAs || !connectedAddress}
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
              ? 'Editing position…'
              : reviewed
                ? tx.phase === 'error'
                  ? `Retry step ${stepIdx + 1} of ${reviewed.steps.length}`
                  : 'Confirm & edit position'
                : 'Review edit'}
        </button>
        <button
          type="button"
          className="btn-secondary min-h-[32px] px-3 text-xs"
          disabled={busy}
          onClick={reviewed ? back : onClose}
        >
          {reviewed ? 'Back' : 'Cancel'}
        </button>
      </div>
      <TxError
        error={reviewError ?? tx.error}
        className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
      />
      {tx.safeNonceGuidance ? (
        <p className="mt-2 text-xs text-smoke-500">{tx.safeNonceGuidance}</p>
      ) : null}
    </div>
  )
}
