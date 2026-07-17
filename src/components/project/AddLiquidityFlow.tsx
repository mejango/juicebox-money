'use client'

import {
  JB_CHAINS,
  NATIVE_TOKEN,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { getTokenAddress } from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  encodeAbiParameters,
  erc20Abi,
  formatUnits,
  parseUnits,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem'
import { usePublicClient } from 'wagmi'
import { getCashOutContext, getContextCashOutQuote } from '@/lib/cashOut'
import { formatTokenAmount } from '@/lib/format'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import {
  POSITION_MANAGER_BY_CHAIN,
  alignDown,
  alignUp,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  lpCounterpart,
  lpDefaultRange,
  sqrtAtTick,
  type PoolKey,
} from '@/lib/uniswap-v4'
import { formatPrice } from './chartUtils'
import { resolveMarket, type MarketResult } from './MarketSection'

/**
 * "Add market liquidity" — a Uniswap V4 PositionManager MINT (real funds).
 *
 * This is an EXACT port of website/src/discover.js buildAddLiquidityModal /
 * prepareAddLiquidity / buildAddLiquidityPayload. All the Q64.96 tick and
 * liquidity math and the V4 Actions / unlockData encoding are byte-for-byte the
 * same as website (see src/lib/uniswap-v4.ts for the shared bigint helpers, and
 * `buildMint` below for the encoding). Because it moves real funds, anything
 * that can't be verified against website degrades to a note rather than a guess.
 *
 * Difference from website (deliberate, and safer): where website folds a gasless
 * Permit2 signature into a PositionManager.multicall, this app authorizes Permit2
 * with an on-chain Permit2.approve — so EVERY step (ERC-20 → Permit2, Permit2 →
 * PositionManager, then the mint) is its own reviewed useSafeTx transaction that
 * is simulated before it is signed. No signature ever bypasses useSafeTx. The
 * mint calldata (unlockData: MINT_POSITION + CLOSE + CLOSE [+ SWEEP]) and the
 * exact amounts sent are identical to website's.
 */

// The canonical Permit2 singleton (same address every chain) — website line 20630.
const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

const UINT160_MAX = (1n << 160n) - 1n

// Minimal Permit2 AllowanceTransfer ABI — matches website lpPermit2Abi (line 20658).
const permit2Abi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const

// Uniswap V4 PositionManager — matches website lpPositionManagerAbi (line 20669).
const positionManagerAbi = [
  {
    type: 'function',
    name: 'modifyLiquidities',
    stateMutability: 'payable',
    inputs: [
      { name: 'unlockData', type: 'bytes' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

type PoolContext = Extract<MarketResult, { status: 'pool' }>

/** The result of building the mint — the exact bytes and amounts that get sent. */
type Mint = {
  unlockData: `0x${string}`
  /** msg.value: the native pair max (SWEEP refunds the excess), else 0. */
  value: bigint
  /** ERC-20 sides that need a Permit2 allowance (bounded to `max`). */
  erc20: { currency: Address; max: bigint }[]
  tickLower: number
  tickUpper: number
  liquidity: bigint
  need: { amount0: bigint; amount1: bigint }
  amount0Max: bigint
  amount1Max: bigint
}

/**
 * EXACT port of website prepareAddLiquidity (lines 21275-21356): derive the
 * ticks + liquidity from the range and deposit amounts at the live sqrt price,
 * compute the 1%-headroom maxes, and encode the modifyLiquidities unlockData
 * (MINT_POSITION 0x02, CLOSE_CURRENCY 0x12 for each currency, SWEEP 0x14 for the
 * native refund). Pure: no wallet, no I/O.
 */
function buildMint({
  pool,
  pairAmount,
  tokenAmount,
  pa,
  pb,
  account,
}: {
  pool: PoolContext
  /** Pair-token deposit, in the pair token's own decimals. */
  pairAmount: bigint
  /** Project-token deposit, 18-decimal fixed point. */
  tokenAmount: bigint
  /** Range min, pair-per-token. */
  pa: number
  /** Range max, pair-per-token. */
  pb: number
  account: Address
}): Mint {
  const { key, sqrtP, pair, pairIsC0 } = pool
  const pairDec = pair.decimals

  // Map the pair/token deposits onto currency0/currency1 by pool ordering.
  const amount0 = pairIsC0 ? pairAmount : tokenAmount
  const amount1 = pairIsC0 ? tokenAmount : pairAmount

  const s = Number(key.tickSpacing)
  const maxUsable = Math.trunc(887272 / s) * s
  const minUsable = Math.trunc(-887272 / s) * s

  // UI range is pair-per-token (q). Pool price is raw currency1/currency0:
  //   pair=c0 → P_raw = 10^(18−pairDec)/q ; token=c0 → P_raw = q·10^(pairDec−18).
  const pRawFromQ = (q: number) =>
    pairIsC0 ? Math.pow(10, 18 - pairDec) / q : q * Math.pow(10, pairDec - 18)
  const tA = Math.log(pRawFromQ(pa)) / Math.log(1.0001)
  const tB = Math.log(pRawFromQ(pb)) / Math.log(1.0001)
  let tickLower = Math.max(minUsable, alignDown(Math.floor(Math.min(tA, tB)), s))
  let tickUpper = Math.min(maxUsable, alignUp(Math.ceil(Math.max(tA, tB)), s))
  if (tickUpper <= tickLower) tickUpper = Math.min(maxUsable, tickLower + s)

  // Single-sided deposits: keep the current price OUTSIDE the range so the
  // funded side is the only one the position needs (website lines 21303-21311).
  const curTick = Math.floor(
    (2 * Math.log(Number(sqrtP) / Math.pow(2, 96))) / Math.log(1.0001),
  )
  if (amount1 <= 0n && amount0 > 0n && curTick >= tickLower) {
    tickLower = Math.min(maxUsable, alignUp(curTick + 1, s))
  }
  if (amount0 <= 0n && amount1 > 0n && curTick < tickUpper) {
    tickUpper = Math.max(minUsable, alignDown(curTick, s))
  }
  if (tickUpper <= tickLower) tickUpper = Math.min(maxUsable, tickLower + s)

  const sqrtA = sqrtAtTick(tickLower)
  const sqrtB = sqrtAtTick(tickUpper)
  const liquidity = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1)
  if (liquidity <= 0n) throw new Error('Amounts too small for this range')
  const need = getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity)
  // 1% headroom over the exact requirement (SWEEP refunds unused native;
  // Permit2/CLOSE pull the exact ERC-20).
  const amount0Max = need.amount0 + need.amount0 / 100n + 1n
  const amount1Max = need.amount1 + need.amount1 / 100n + 1n

  const c0Native = pairIsC0 && pair.isNative
  const c1Native = !pairIsC0 && pair.isNative
  const value = c0Native ? amount0Max : c1Native ? amount1Max : 0n
  const erc20: { currency: Address; max: bigint }[] = []
  if (!c0Native && amount0Max > 1n) {
    erc20.push({ currency: key.currency0, max: amount0Max })
  }
  if (!c1Native && amount1Max > 1n) {
    erc20.push({ currency: key.currency1, max: amount1Max })
  }
  for (const side of erc20) {
    if (side.max > UINT160_MAX) {
      throw new Error('Amount is too large for Permit2.')
    }
  }

  const mintParams = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { type: 'address' },
          { type: 'address' },
          { type: 'uint24' },
          { type: 'int24' },
          { type: 'address' },
        ],
      },
      { type: 'int24' },
      { type: 'int24' },
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'address' },
      { type: 'bytes' },
    ],
    [
      // uint24 fee and int24 tickSpacing/ticks are <=48-bit, so viem's encoder
      // takes plain numbers here (not bigint).
      [key.currency0, key.currency1, Number(key.fee), Number(key.tickSpacing), key.hooks],
      tickLower,
      tickUpper,
      liquidity,
      amount0Max,
      amount1Max,
      account,
      '0x',
    ],
  )
  const closeC0 = encodeAbiParameters([{ type: 'address' }], [key.currency0])
  const closeC1 = encodeAbiParameters([{ type: 'address' }], [key.currency1])
  const parts: `0x${string}`[] = [mintParams, closeC0, closeC1]
  let actions: `0x${string}` = '0x021212' // MINT_POSITION, CLOSE(c0), CLOSE(c1)
  if (pair.isNative) {
    // Refund unused native (sent as msg.value) to the user. ERC-20 sides need
    // no sweep — CLOSE pulls the exact amount via Permit2.
    const nativeCur = c0Native ? key.currency0 : key.currency1
    parts.push(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }],
        [nativeCur, account],
      ),
    )
    actions = '0x02121214' // … + SWEEP(native)
  }
  const unlockData = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, parts],
  )

  return {
    unlockData,
    value,
    erc20,
    tickLower,
    tickUpper,
    liquidity,
    need,
    amount0Max,
    amount1Max,
  }
}

// ------------------------------------------------------------- execution plan --

type Step =
  | { kind: 'approve-erc20'; token: Address; amount: bigint; label: string }
  | {
      kind: 'permit2-approve'
      token: Address
      amount: bigint
      expiration: number
      label: string
    }
  | { kind: 'mint'; label: string }

type Plan = {
  account: Address
  posm: Address
  steps: Step[]
  mint: Mint
  /** Frozen display figures — must equal what the frozen `mint` sends. */
  display: {
    needTok: bigint
    needPair: bigint
    maxTok: bigint
    maxPair: bigint
    tickLower: number
    tickUpper: number
    liquidity: bigint
    pairSymbol: string
    pairDecimals: number
    pairIsNative: boolean
    fee: number
  }
}

/**
 * Read the live allowances and assemble the ordered step list. Each ERC-20 side
 * needs (1) an ERC-20 → Permit2 allowance and (2) a Permit2 → PositionManager
 * allowance; either is skipped when the current allowance already covers `max`.
 * The mint is always last. Mirrors website runAddLiquidityTxs (lines 21361-21414),
 * but with on-chain Permit2.approve in place of the folded gasless signature.
 */
async function buildPlan(
  client: PublicClient,
  account: Address,
  posm: Address,
  mint: Mint,
  labelFor: (token: Address) => string,
): Promise<Step[]> {
  const now = Math.floor(Date.now() / 1000)
  const steps: Step[] = []
  for (const side of mint.erc20) {
    const erc20Allow = (await client.readContract({
      address: side.currency,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account, PERMIT2_ADDRESS],
    })) as bigint
    if (erc20Allow < side.max) {
      steps.push({
        kind: 'approve-erc20',
        token: side.currency,
        amount: side.max,
        label: `Approve ${labelFor(side.currency)} for Permit2`,
      })
    }
    const p2 = (await client.readContract({
      address: PERMIT2_ADDRESS,
      abi: permit2Abi,
      functionName: 'allowance',
      args: [account, side.currency, posm],
    })) as readonly [bigint, number, number]
    const p2amount = BigInt(p2[0])
    const p2exp = Number(p2[1])
    if (!(p2amount >= side.max && p2exp > now)) {
      steps.push({
        kind: 'permit2-approve',
        token: side.currency,
        amount: side.max,
        // 30-day allowance window, same as website's Permit2 signature.
        expiration: now + 30 * 24 * 3600,
        label: `Authorize the position manager for ${labelFor(side.currency)}`,
      })
    }
  }
  steps.push({ kind: 'mint', label: 'Add liquidity' })
  return steps
}

// ------------------------------------------------------------- number helpers --

/** Trim a float for an input field — EXACT port of website lpTrimNum (line 20558). */
function trimNum(n: number): string {
  if (!isFinite(n) || n <= 0) return '0'
  if (n >= 1) return String(Math.round(n * 1e4) / 1e4)
  return String(Number(n.toPrecision(6)))
}

function parseAmount(str: string, decimals: number): bigint {
  const trimmed = str.trim()
  if (!trimmed) return 0n
  if (!Number.isFinite(Number(trimmed)) || Number(trimmed) < 0) {
    throw new Error('Invalid amount')
  }
  return parseUnits(trimmed, decimals)
}

/** Which side(s) the position needs at the current price + range — EXACT port
 *  of website activeSides (lines 21751-21757). */
function activeSides(
  pa: number,
  pb: number,
  poolP: number,
): { tok: boolean; pair: boolean } {
  if (!(poolP > 0) || !(pa > 0) || !(pb > pa)) return { tok: true, pair: true }
  if (poolP >= pb) return { tok: false, pair: true } // all pair
  if (poolP <= pa) return { tok: true, pair: false } // all project token
  return { tok: true, pair: true }
}

// ----------------------------------------------------------------- component --

export function AddLiquidityFlow({
  chainId,
  projectId,
  tokenSymbol,
}: {
  chainId: JBChainId
  projectId: number
  tokenSymbol: string
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const chainMeta = JB_CHAINS[chainId]
  const nativeSymbol = chainMeta?.nativeTokenSymbol ?? 'ETH'
  const posm = POSITION_MANAGER_BY_CHAIN[chainId]

  // Resolve the pool (shared cache with the Market card).
  const { data: market, isLoading: marketLoading } = useQuery({
    queryKey: ['market', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: () =>
      resolveMarket(publicClient!, chainId, projectId, nativeSymbol),
  })
  const pool = market?.status === 'pool' ? market : null

  // The project's OWN token — required; if there's no deployed ERC-20 there's
  // no pool to seed. Shared cache key with the Market card.
  const { data: projectToken } = useQuery({
    queryKey: ['marketProjectSymbol', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async (): Promise<{ address: Address; symbol: string } | null> => {
      const token = await getTokenAddress(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      })
      if (!token) return null
      const symbol = (await publicClient!
        .readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
        .catch(() => tokenSymbol)) as string
      return { address: token, symbol }
    },
  })
  const sym = projectToken?.symbol || tokenSymbol || 'tokens'

  // Cash-out floor, only used to seed the default range (best-effort).
  const { data: floor } = useQuery({
    queryKey: ['marketFloor', chainId, projectId],
    enabled: !!publicClient && !!pool,
    staleTime: 60_000,
    retry: 0,
    queryFn: async (): Promise<number | null> => {
      const context = await getCashOutContext(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      })
      if (!context) return null
      const quote = await getContextCashOutQuote(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
        cashOutCount: 10n ** 18n,
        context,
      })
      const value = Number(formatUnits(quote.reclaimAmount, context.decimals))
      return Number.isFinite(value) && value > 0 ? value : null
    },
  })

  if (!posm) {
    return (
      <div className="card p-5">
        <span className="field-label">Add market liquidity</span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          Adding liquidity isn&apos;t available on this chain yet.
        </p>
      </div>
    )
  }

  if (marketLoading) {
    return (
      <div className="card p-5">
        <span className="field-label">Add market liquidity</span>
        <p className="mt-2 text-sm text-smoke-500">Loading…</p>
      </div>
    )
  }

  // No buyback hook at all, or no deployed project ERC-20: nothing to seed.
  if (!market || market.status === 'none' || projectToken === null) {
    return null
  }

  if (market.status !== 'pool') {
    return (
      <div className="card p-5">
        <span className="field-label">Add market liquidity</span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          No market pool yet — liquidity can be added once the pool is live.
        </p>
      </div>
    )
  }

  return (
    <AddLiquidityForm
      chainId={chainId}
      projectId={projectId}
      posm={posm}
      pool={market}
      sym={sym}
      nativeSymbol={nativeSymbol}
      floor={floor ?? null}
    />
  )
}

function AddLiquidityForm({
  chainId,
  projectId,
  posm,
  pool,
  sym,
  nativeSymbol,
  floor,
}: {
  chainId: JBChainId
  projectId: number
  posm: Address
  pool: PoolContext
  sym: string
  nativeSymbol: string
  floor: number | null
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { isConnected, address, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)
  const chainMeta = JB_CHAINS[chainId]

  const pair = pool.pair
  const poolP = pool.price
  const ceiling = pool.issuance ?? 0

  // The pair token that names one side of the pool (native ETH or an ERC-20).
  const pairSym = pair.isNative ? nativeSymbol : pair.symbol
  const pairDec = pair.decimals

  // ----- balances ----------------------------------------------------------
  const { data: balances } = useQuery({
    queryKey: ['lpBalances', chainId, projectId, address, pair.tokenOrig],
    enabled: !!publicClient && !!address,
    staleTime: 20_000,
    retry: 0,
    queryFn: async (): Promise<{ tok: bigint; pair: bigint }> => {
      const token = await getTokenAddress(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      })
      const tok = token
        ? ((await publicClient!.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address!],
          })) as bigint)
        : 0n
      const pairBal = pair.isNative
        ? await publicClient!.getBalance({ address: address! })
        : ((await publicClient!.readContract({
            address: pair.tokenOrig,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address!],
          })) as bigint)
      return { tok, pair: pairBal }
    },
  })

  // ----- inputs ------------------------------------------------------------
  const [minStr, setMinStr] = useState('')
  const [maxStr, setMaxStr] = useState('')
  const [tokStr, setTokStr] = useState('')
  const [pairStr, setPairStr] = useState('')
  const seededRef = useRef(false)

  // Seed the default range once the pool price is known (website lpDefaultRange).
  useEffect(() => {
    if (seededRef.current) return
    const basePrice = poolP > 0 ? poolP : ceiling > 0 ? ceiling / 10 : 0
    const dr = lpDefaultRange(basePrice, floor ?? 0, ceiling)
    if (dr.min > 0) setMinStr(trimNum(dr.min))
    if (dr.max > 0) setMaxStr(trimNum(dr.max))
    seededRef.current = true
  }, [poolP, ceiling, floor])

  const range = useMemo(() => {
    const pa = parseFloat(minStr)
    const pb = parseFloat(maxStr)
    return { pa: pa > 0 ? pa : 0, pb: pb > 0 ? pb : 0 }
  }, [minStr, maxStr])
  const sides = useMemo(
    () => activeSides(range.pa, range.pb, poolP),
    [range, poolP],
  )

  // ----- review / execution state -----------------------------------------
  const [plan, setPlan] = useState<Plan | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [running, setRunning] = useState(false)
  const [stepIdx, setStepIdx] = useState(0)
  const [done, setDone] = useState(false)
  const [mintHash, setMintHash] = useState<`0x${string}` | null>(null)

  const planRef = useRef<Plan | null>(null)
  const stepIdxRef = useRef(0)
  const runningRef = useRef(false)
  const processedRef = useRef<string | null>(null)

  const busy =
    quoting ||
    running ||
    tx.phase === 'simulating' ||
    tx.phase === 'signing' ||
    tx.phase === 'pending'

  const invalidatePlan = () => {
    if (planRef.current && !runningRef.current) {
      planRef.current = null
      setPlan(null)
    }
    setReviewError(null)
  }

  // ----- autofill (float math, display only) -------------------------------
  const setTok = (v: string) => {
    setTokStr(v)
    invalidatePlan()
    if (!sides.pair) {
      setPairStr('0')
      return
    }
    if (!sides.tok) return
    const t = parseFloat(v)
    if (!(t > 0)) {
      setPairStr('')
      return
    }
    const e = lpCounterpart(t, false, poolP, range.pa, range.pb)
    if (e != null) setPairStr(trimNum(e))
  }
  const setPairAmt = (v: string) => {
    setPairStr(v)
    invalidatePlan()
    if (!sides.tok) {
      setTokStr('0')
      return
    }
    if (!sides.pair) return
    const e = parseFloat(v)
    if (!(e > 0)) {
      setTokStr('')
      return
    }
    const t = lpCounterpart(e, true, poolP, range.pa, range.pb)
    if (t != null) setTokStr(trimNum(t))
  }
  const onRangeChange = (which: 'min' | 'max', v: string) => {
    if (which === 'min') setMinStr(v)
    else setMaxStr(v)
    invalidatePlan()
  }

  const tokMax = () => {
    if (!balances) return
    setTok(formatUnits(balances.tok, 18))
  }
  const pairMax = () => {
    if (!balances) return
    // Keep ~0.001 native for gas only when the pair IS native.
    const buf = pair.isNative ? 1_000_000_000_000_000n : 0n
    const v = balances.pair > buf ? balances.pair - buf : 0n
    setPairAmt(formatUnits(v, pairDec))
  }

  // Re-label the token symbol for a step's ERC-20 token.
  const labelFor = useCallback(
    (token: Address): string =>
      token.toLowerCase() === pair.tokenOrig.toLowerCase() ? pairSym : sym,
    [pair.tokenOrig, pairSym, sym],
  )

  const chainName = chainMeta?.name ?? `Chain ${chainId}`
  const txUrl = (hash: string) =>
    chainMeta?.etherscanHostname
      ? `https://${chainMeta.etherscanHostname}/tx/${hash}`
      : null

  // ----- review: freeze the exact transaction ------------------------------
  const handleReview = async () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    if (!publicClient || busy) return
    setReviewError(null)
    setQuoting(true)
    try {
      let pairAmount: bigint
      let tokenAmount: bigint
      try {
        pairAmount = parseAmount(pairStr, pairDec)
      } catch {
        throw new FlowError(`Enter a valid ${pairSym} amount.`)
      }
      try {
        tokenAmount = parseAmount(tokStr, 18)
      } catch {
        throw new FlowError(`Enter a valid ${sym} amount.`)
      }
      if (pairAmount <= 0n && tokenAmount <= 0n) {
        throw new FlowError('Enter an amount to add.')
      }
      const pa = range.pa
      const pb = range.pb
      if (!(pa > 0) || !(pb > pa)) {
        throw new FlowError('Set a valid price range.')
      }

      // LIVE re-reads — never trust the rendered numbers. Balances first.
      const token = await getTokenAddress(publicClient, {
        chainId,
        projectId: BigInt(projectId),
      })
      const [tokBal, pairBal] = await Promise.all([
        token
          ? (publicClient.readContract({
              address: token,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [address],
            }) as Promise<bigint>)
          : Promise.resolve(0n),
        pair.isNative
          ? publicClient.getBalance({ address })
          : (publicClient.readContract({
              address: pair.tokenOrig,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [address],
            }) as Promise<bigint>),
      ])
      if (tokenAmount > tokBal) {
        throw new FlowError(`That's more ${sym} than your balance.`)
      }
      if (pairAmount > pairBal) {
        throw new FlowError(`That's more ${pairSym} than your balance.`)
      }

      // LIVE pool state — sqrtP moves, and the encoded amounts depend on it.
      const fresh = await resolveMarket(
        publicClient,
        chainId,
        projectId,
        nativeSymbol,
      )
      if (fresh.status !== 'pool') {
        throw new FlowError('The pool is no longer available on this chain.')
      }

      const mint = buildMint({
        pool: fresh,
        pairAmount,
        tokenAmount,
        pa,
        pb,
        account: address,
      })
      const steps = await buildPlan(
        publicClient,
        address,
        posm,
        mint,
        labelFor,
      )

      const needTok = fresh.pairIsC0 ? mint.need.amount1 : mint.need.amount0
      const needPair = fresh.pairIsC0 ? mint.need.amount0 : mint.need.amount1
      const maxTok = fresh.pairIsC0 ? mint.amount1Max : mint.amount0Max
      const maxPair = fresh.pairIsC0 ? mint.amount0Max : mint.amount1Max

      const built: Plan = {
        account: address,
        posm,
        steps,
        mint,
        display: {
          needTok,
          needPair,
          maxTok,
          maxPair,
          tickLower: mint.tickLower,
          tickUpper: mint.tickUpper,
          liquidity: mint.liquidity,
          pairSymbol: pairSym,
          pairDecimals: pairDec,
          pairIsNative: pair.isNative,
          fee: Number(fresh.key.fee),
        },
      }
      planRef.current = built
      setPlan(built)
    } catch (e) {
      setReviewError(
        e instanceof FlowError
          ? e.message
          : e instanceof Error
            ? shortError(e)
            : 'Something went wrong.',
      )
    } finally {
      setQuoting(false)
    }
  }

  // ----- send one step -----------------------------------------------------
  const sendStep = useCallback(
    (step: Step) => {
      const p = planRef.current
      if (!p) return
      if (step.kind === 'approve-erc20') {
        tx.send({
          chainId,
          address: step.token,
          abi: erc20Abi as Abi,
          functionName: 'approve',
          args: [PERMIT2_ADDRESS, step.amount],
        })
      } else if (step.kind === 'permit2-approve') {
        tx.send({
          chainId,
          address: PERMIT2_ADDRESS,
          abi: permit2Abi as Abi,
          functionName: 'approve',
          args: [step.token, p.posm, step.amount, step.expiration],
        })
      } else {
        // Deadline is set at send time (~20 min), like website — everything
        // that touches funds is frozen inside unlockData.
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
        tx.send({
          chainId,
          address: p.posm,
          abi: positionManagerAbi as Abi,
          functionName: 'modifyLiquidities',
          args: [p.mint.unlockData, deadline],
          value: p.mint.value,
        })
      }
    },
    [tx, chainId],
  )

  // ----- driver: advance through the steps on each receipt -----------------
  useEffect(() => {
    if (!runningRef.current) return
    const p = planRef.current
    if (!p) return
    if (tx.phase === 'success' && tx.hash && tx.hash !== processedRef.current) {
      processedRef.current = tx.hash
      const isLast = stepIdxRef.current >= p.steps.length - 1
      if (isLast) {
        setMintHash(tx.hash)
        runningRef.current = false
        setRunning(false)
        setDone(true)
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
  }, [tx.phase, tx.hash, tx, sendStep])

  const startRun = () => {
    if (!plan || runningRef.current) return
    // Account-unchanged recheck: the mint recipient is baked into unlockData.
    if (!address || address.toLowerCase() !== plan.account.toLowerCase()) {
      planRef.current = null
      setPlan(null)
      setReviewError('Your connected account changed — review again.')
      return
    }
    processedRef.current = null
    stepIdxRef.current = 0
    setStepIdx(0)
    setDone(false)
    setMintHash(null)
    tx.reset()
    runningRef.current = true
    setRunning(true)
    sendStep(plan.steps[0])
  }

  const resume = () => {
    if (!plan || runningRef.current) return
    tx.reset()
    processedRef.current = null
    runningRef.current = true
    setRunning(true)
    sendStep(plan.steps[stepIdxRef.current])
  }

  const startOver = () => {
    runningRef.current = false
    processedRef.current = null
    stepIdxRef.current = 0
    setRunning(false)
    setStepIdx(0)
    setDone(false)
    setMintHash(null)
    planRef.current = null
    setPlan(null)
    setReviewError(null)
    tx.reset()
  }

  // ----- render ------------------------------------------------------------

  if (done) {
    const url = mintHash ? txUrl(mintHash) : null
    return (
      <div className="card p-5">
        <span className="field-label">Add market liquidity</span>
        <p className="mt-2 text-sm font-medium text-ink">
          Liquidity added to the {sym} / {pairSym} pool.
        </p>
        <div className="mt-2 flex gap-3 text-sm font-semibold">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
            >
              View transaction
            </a>
          ) : null}
          <button onClick={startOver} className="text-smoke-700 hover:text-ink">
            Add more
          </button>
        </div>
      </div>
    )
  }

  const disabledCol = (active: boolean) => (active ? '' : 'opacity-45')

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="field-label">Add market liquidity</span>
        <span className="text-xs text-smoke-500">{chainName}</span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Seed the buyback pool so payers can route through the AMM. Liquidity is
        added at the current pool price.
      </p>

      <p className="mt-3 text-sm text-smoke-700">
        Pool price:{' '}
        <span className="font-medium text-ink">
          {poolP > 0 ? `~${formatPrice(poolP)} ${pairSym} / ${sym}` : '—'}
        </span>
      </p>

      {/* Price range */}
      <div className="mt-4">
        <span className="field-label">
          Price range ({pairSym} per {sym})
        </span>
        <p className="mt-1 text-xs text-smoke-500">
          Defaults span the current cash-out floor to the issuance ceiling.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            placeholder="Min"
            value={minStr}
            disabled={busy}
            onChange={e => onRangeChange('min', e.target.value)}
            className="input-well min-h-[40px] w-full px-3 text-sm"
            aria-label={`Range minimum in ${pairSym} per ${sym}`}
          />
          <span className="shrink-0 text-xs text-smoke-500">to</span>
          <input
            type="number"
            inputMode="decimal"
            placeholder="Max"
            value={maxStr}
            disabled={busy}
            onChange={e => onRangeChange('max', e.target.value)}
            className="input-well min-h-[40px] w-full px-3 text-sm"
            aria-label={`Range maximum in ${pairSym} per ${sym}`}
          />
        </div>
      </div>

      {/* Deposit amounts */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className={disabledCol(sides.tok)}>
          <div className="flex items-baseline justify-between">
            <span className="field-label">{sym} to add</span>
            {sides.tok ? (
              <button
                onClick={tokMax}
                disabled={busy || !balances}
                className="text-[11px] font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-50"
              >
                Max
              </button>
            ) : null}
          </div>
          <div className="input-well mt-1.5 flex items-center px-3">
            <input
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              value={tokStr}
              disabled={busy || !sides.tok}
              onChange={e => setTok(e.target.value)}
              className="min-h-[40px] w-full bg-transparent text-sm outline-none placeholder:text-smoke-500 disabled:cursor-not-allowed"
              aria-label={`${sym} amount`}
            />
            <span className="ml-2 shrink-0 text-xs text-smoke-700">{sym}</span>
          </div>
        </div>

        <div className={disabledCol(sides.pair)}>
          <div className="flex items-baseline justify-between">
            <span className="field-label">{pairSym} to add</span>
            {sides.pair ? (
              <button
                onClick={pairMax}
                disabled={busy || !balances}
                className="text-[11px] font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-50"
              >
                Max
              </button>
            ) : null}
          </div>
          <div className="input-well mt-1.5 flex items-center px-3">
            <input
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              value={pairStr}
              disabled={busy || !sides.pair}
              onChange={e => setPairAmt(e.target.value)}
              className="min-h-[40px] w-full bg-transparent text-sm outline-none placeholder:text-smoke-500 disabled:cursor-not-allowed"
              aria-label={`${pairSym} amount`}
            />
            <span className="ml-2 shrink-0 text-xs text-smoke-700">
              {pairSym}
            </span>
          </div>
        </div>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-smoke-700">
        Enter either amount; the other is calculated at the pool price. Near Min
        uses more {sym}; near Max uses more {pairSym}.
      </p>

      {!sides.tok || !sides.pair ? (
        <p className="mt-2 text-xs leading-relaxed text-orange-600">
          {sides.pair
            ? `At the current price (top of your range) the position is single-sided ${pairSym} — add ${pairSym} only.`
            : `At the current price (bottom of your range) the position is single-sided ${sym} — add ${sym} only.`}
        </p>
      ) : null}

      {balances ? (
        <p className="mt-2 text-xs text-smoke-500">
          Your balance: {formatTokenAmount(balances.tok, 18)} {sym} ·{' '}
          {formatTokenAmount(balances.pair, pairDec)} {pairSym}
        </p>
      ) : null}

      {/* Review panel */}
      {plan ? (
        <div className="callout callout-info mt-4 text-xs">
          <p className="font-medium">
            You add ~{formatTokenAmount(plan.display.needTok, 18)} {sym} +{' '}
            {formatTokenAmount(plan.display.needPair, plan.display.pairDecimals)}{' '}
            {plan.display.pairSymbol}
          </p>
          <p className="mt-1">
            Authorizing up to {formatTokenAmount(plan.display.maxTok, 18)} {sym}{' '}
            and{' '}
            {formatTokenAmount(plan.display.maxPair, plan.display.pairDecimals)}{' '}
            {plan.display.pairSymbol} (1% headroom
            {plan.display.pairIsNative
              ? `; unused ${plan.display.pairSymbol} is refunded`
              : ''}
            ).
          </p>
          <p className="mt-1 text-smoke-700">
            Uniswap V4 PositionManager mint · fee tier{' '}
            {(plan.display.fee / 10000).toFixed(2)}% · ticks{' '}
            {plan.display.tickLower} to {plan.display.tickUpper}.
          </p>
          {plan.steps.length > 1 ? (
            <p className="mt-1 text-smoke-700">
              {plan.steps.length} transactions: {plan.steps.length - 1} approval
              {plan.steps.length - 1 > 1 ? 's' : ''} then the mint. Each is
              reviewed and simulated before you sign.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Step progress while running */}
      {running && plan ? (
        <p className="mt-3 text-xs text-smoke-700">
          Step {stepIdx + 1} of {plan.steps.length}:{' '}
          {plan.steps[stepIdx]?.label}
          {tx.phase === 'simulating'
            ? ' — checking…'
            : tx.phase === 'signing'
              ? ' — confirm in your wallet…'
              : tx.phase === 'pending'
                ? ' — sending…'
                : ''}
        </p>
      ) : null}

      <button
        onClick={
          !plan
            ? handleReview
            : running
              ? undefined
              : tx.phase === 'error'
                ? resume // resume at the step that failed, not from the start
                : startRun
        }
        disabled={busy}
        className="btn-primary mt-4 min-h-[44px] w-full text-sm"
      >
        {quoting
          ? 'Checking amounts…'
          : running
            ? 'Adding liquidity…'
            : !isConnected
              ? 'Sign in to continue'
              : plan
                ? tx.phase === 'error'
                  ? `Retry step ${stepIdx + 1} of ${plan.steps.length}`
                  : 'Confirm & add liquidity'
                : 'Review'}
      </button>

      {plan && !running ? (
        <button
          onClick={startOver}
          disabled={busy}
          className="mt-2 w-full text-xs text-smoke-500 hover:text-ink disabled:opacity-50"
        >
          Edit amounts
        </button>
      ) : null}

      {reviewError || tx.error ? (
        <p className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {reviewError ?? tx.error}
        </p>
      ) : null}
    </div>
  )
}

/** A validation failure with user-ready copy. */
class FlowError extends Error {}

function shortError(e: Error): string {
  const message =
    'shortMessage' in e && typeof e.shortMessage === 'string'
      ? e.shortMessage
      : e.message
  if (/denied|rejected/i.test(message)) return 'Transaction cancelled.'
  return message.split('\n')[0]
}
