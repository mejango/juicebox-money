'use client'

import {
  JB_CHAINS,
  JBBuybackHookContracts,
  JBCoreContracts,
  JBOmnichainDeployerContracts,
  NATIVE_TOKEN,
  RevnetCoreContracts,
  jbBuybackHookAbi,
  jbBuybackHookRegistryAbi,
  jbControllerAbi,
  jbDirectoryAbi,
  jbOmnichainDeployerAbi,
  jbPricesAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { getAccountingContexts } from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  type Address,
  type PublicClient,
} from 'viem'
import { usePublicClient } from 'wagmi'
import { AddressLink } from '@/components/ui/AddressLink'
import { useCashOutFloor } from '@/hooks/useCashOutFloor'
import {
  LiquidityBodySkeleton,
  MarketSectionSkeleton,
} from '@/components/LoadingSkeletons'
import { useProjectTokenSymbol } from '@/hooks/useProjectTokenSymbol'
import { addrOf } from '@/lib/contracts'
import { formatTokenAmount } from '@/lib/format'
import { tokenSymbol } from '@/lib/token-symbol'
import {
  MODIFY_LIQUIDITY_TOPIC,
  INITIALIZE_TOPIC,
  POOL_MANAGER_BY_CHAIN,
  POSITION_MANAGER_BY_CHAIN,
  ZERO_ADDRESS,
  computePoolId,
  getAmountsForLiquidity,
  modifyLiquidityTokenId,
  poolPriceFromSqrt,
  poolStateSlot,
  sqrtAtTick,
  sqrtPriceX96FromSlot0,
  tickLowerOf,
  tickUpperOf,
  type PoolKey,
} from '@/lib/uniswap-v4'
import { formatPrice } from './chartUtils'

/**
 * Market subtab (website/ parity: renderOwnersAmm). The AMM (buyback) pool's
 * live price + LP composition + a liquidity-by-price depth chart. READ-ONLY —
 * no swaps or liquidity writes here; those live elsewhere.
 *
 * The buyback pool is resolved exactly the way website/ does it (its
 * projectBuybackHook / readAmmPrice / readLpPositions): the project's ruleset
 * dataHook is recognized against the buyback registry / REVOwner / omnichain
 * deployer / concrete hook — never `hookOf`'s default — then poolKeyOf gives the
 * Uniswap V4 pool, and the PoolManager's slot0 (extsload) gives sqrtPriceX96.
 *
 * The sqrtPriceX96 -> price math and all Q64.96 tick/liquidity math are exact
 * line-by-line ports (see src/lib/uniswap-v4.ts). Wrong price math is worse
 * than omitting the card, so any read that can't be verified degrades to a note
 * rather than rendering a guess.
 */

// PoolManager.extsload(bytes32) -> bytes32 — the only PoolManager call we make.
const extsloadAbi = [
  {
    type: 'function',
    name: 'extsload',
    stateMutability: 'view',
    inputs: [{ name: 'slot', type: 'bytes32' }],
    outputs: [{ type: 'bytes32' }],
  },
] as const

// Uniswap V4 PositionManager reads (website lpPositionViewAbi ~line 20769).
const positionViewAbi = [
  {
    type: 'function',
    name: 'positionInfo',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getPoolAndPositionInfo',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: 'poolKey',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'info', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getPositionLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: 'owner', type: 'address' }],
  },
] as const

function lc(a: string | undefined | null): string {
  return (a ?? '').toLowerCase()
}

// -------------------------------------------------------------- resolution --

type PairToken = {
  /** Pool-currency form: native ETH is the zero address, else the ERC-20. */
  addr: Address
  /** The accounting-context token as returned (for symbol reads). */
  tokenOrig: Address
  decimals: number
  symbol: string
  isNative: boolean
}

export type MarketResult =
  | { status: 'none' }
  | { status: 'nopool' }
  | {
      status: 'pool'
      hook: Address
      pair: PairToken
      key: PoolKey
      sqrtP: bigint
      poolId: `0x${string}`
      pairIsC0: boolean
      /** Pair token per project token (market price). */
      price: number
      /** Issuance ceiling in pair tokens per project token, converted from
       *  the ruleset weight's base currency via JBPrices; null when there is
       *  no usable feed (the ceiling is then omitted rather than guessed). */
      issuance: number | null
    }

/**
 * The issuance ceiling on the PAIR-TOKEN price axis, in pair tokens per
 * project token. The ruleset weight prices tokens against the ruleset's
 * `baseCurrency` (a standard id like ETH=1/USD=2 — or a token-keyed id),
 * while the market card's axis is the accounting/pair token, so the
 * base-per-token figure must be converted through the same project-scoped
 * JBPrices feed the terminal itself uses on every payment
 * (`pricePerUnitOf(projectId, pricingCurrency: pairCurrency, unitCurrency:
 * baseCurrency)` — pair tokens per base unit). Returns null when there is no
 * usable feed: a missing ceiling is honest, a wrongly-denominated one is not.
 */
export async function issuanceCeilingOf(
  client: PublicClient,
  {
    chainId,
    projectId,
    weight,
    baseCurrency,
    pairCurrency,
  }: {
    chainId: JBChainId
    projectId: bigint
    /** Ruleset weight: tokens per base-currency unit, 18-dec fixed point. */
    weight: bigint
    baseCurrency: number
    pairCurrency: number
  },
): Promise<number | null> {
  if (weight <= 0n) return null
  const basePerToken = 1 / (Number(weight) / 1e18)
  if (baseCurrency === pairCurrency) return basePerToken
  const prices = addrOf(JBCoreContracts.JBPrices, chainId)
  if (!prices) return null
  try {
    const price = (await client.readContract({
      address: prices,
      abi: jbPricesAbi,
      functionName: 'pricePerUnitOf',
      args: [projectId, BigInt(pairCurrency), BigInt(baseCurrency), 18n],
    })) as bigint
    const pairPerBase = Number(price) / 1e18
    if (!(pairPerBase > 0) || !isFinite(pairPerBase)) return null
    return basePerToken * pairPerBase
  } catch {
    // No feed (JBPrices_PriceFeedNotFound) or a read failure: omit the line.
    return null
  }
}

/**
 * Resolve the project's buyback pool + live price. Port of website's
 * projectBuybackHook + readAmmPrice. Returns `none` when the project has no
 * buyback pool at all, `nopool` when a hook is set but the pool isn't
 * price-initialized. Throws only on an unexpected RPC failure.
 */
export async function resolveMarket(
  client: PublicClient,
  chainId: JBChainId,
  projectId: number,
  nativeSymbol: string,
): Promise<MarketResult> {
  const pid = BigInt(projectId)

  const directory = addrOf(JBCoreContracts.JBDirectory, chainId)
  if (!directory) return { status: 'none' }

  // The controller is resolved PER-PROJECT from the Directory (never assumed) —
  // reading currentRulesetOf off the wrong controller would misfire.
  const controller = (await client.readContract({
    address: directory,
    abi: jbDirectoryAbi,
    functionName: 'controllerOf',
    args: [pid],
  })) as Address
  if (!controller || lc(controller) === ZERO_ADDRESS) return { status: 'none' }

  const [ruleset, metadata] = await client.readContract({
    address: controller,
    abi: jbControllerAbi,
    functionName: 'currentRulesetOf',
    args: [pid],
  })
  let dataHook = metadata.dataHook as Address
  if (!dataHook || lc(dataHook) === ZERO_ADDRESS) return { status: 'none' }

  const registry = addrOf(
    JBBuybackHookContracts.JBBuybackHookRegistry,
    chainId,
  )
  const concrete = addrOf(JBBuybackHookContracts.JBBuybackHook, chainId)
  const revOwner = addrOf(RevnetCoreContracts.REVOwner, chainId)
  const omni = addrOf(JBOmnichainDeployerContracts.JBOmnichainDeployer, chainId)

  // The omnichain deployer inserts ITSELF as the dataHook and stores the real
  // hook as an "extra hook" — unwrap it (website ~line 2867).
  if (omni && lc(dataHook) === lc(omni)) {
    const cfg = await client.readContract({
      address: omni as Address,
      abi: jbOmnichainDeployerAbi,
      functionName: 'extraDataHookOf',
      args: [pid, BigInt(ruleset.id)],
    })
    dataHook = cfg.dataHook as Address
    if (!dataHook || lc(dataHook) === ZERO_ADDRESS) return { status: 'none' }
  }

  // Recognize the (unwrapped) data hook against the known singletons. hookOf /
  // the default hook must NOT be trusted for a project that doesn't route
  // through the registry (website ~line 2853).
  let hook: Address | null = null
  const d = lc(dataHook)
  if ((registry && d === lc(registry)) || (revOwner && d === lc(revOwner))) {
    const h = (await client.readContract({
      address: registry as Address,
      abi: jbBuybackHookRegistryAbi,
      functionName: 'hookOf',
      args: [pid],
    })) as Address
    hook = h && lc(h) !== ZERO_ADDRESS ? h : null
  } else if (concrete && d === lc(concrete)) {
    hook = dataHook
  }
  if (!hook) return { status: 'none' }

  // The pool's pair (terminal) token = the project's primary accounting token
  // (website lpPairFor). Native ETH maps to the zero-address pool currency.
  const contexts = await getAccountingContexts(client, {
    chainId,
    projectId: pid,
  })
  const primary = contexts[0]
  if (!primary) return { status: 'none' }
  const isNative = lc(primary.token) === lc(NATIVE_TOKEN)
  const symbol = await tokenSymbol(client, primary.token, { nativeSymbol })
  const pair: PairToken = {
    addr: (isNative ? ZERO_ADDRESS : lc(primary.token)) as Address,
    tokenOrig: primary.token,
    decimals: primary.decimals,
    symbol,
    isNative,
  }

  const pm = POOL_MANAGER_BY_CHAIN[chainId]
  if (!pm) return { status: 'nopool' }

  // The buyback hook keys its pool by (projectId, terminalToken) — pass the
  // actual pair token, not a hard-coded native 0x0, or a USDC pool is missed.
  const key = (await client.readContract({
    address: hook,
    abi: jbBuybackHookAbi,
    functionName: 'poolKeyOf',
    args: [pid, pair.addr],
  })) as PoolKey
  const c0 = lc(key.currency0)
  const c1 = lc(key.currency1)
  if (c0 === ZERO_ADDRESS && c1 === ZERO_ADDRESS) return { status: 'nopool' }

  const poolId = computePoolId(key)
  const slot0 = (await client.readContract({
    address: pm,
    abi: extsloadAbi,
    functionName: 'extsload',
    args: [poolStateSlot(poolId)],
  })) as `0x${string}`
  const sqrtP = sqrtPriceX96FromSlot0(slot0)
  if (sqrtP === 0n) return { status: 'nopool' }

  const pairIsC0 = c0 === pair.addr
  const price = poolPriceFromSqrt(sqrtP, pairIsC0, pair.decimals)
  if (price == null) return { status: 'nopool' }

  // The ceiling must land on the pair-token axis: convert the weight's
  // base-currency denomination through JBPrices exactly like the terminal.
  const issuance = await issuanceCeilingOf(client, {
    chainId,
    projectId: pid,
    weight: ruleset.weight as bigint,
    baseCurrency: Number(metadata.baseCurrency),
    pairCurrency: Number(primary.currency),
  })

  return {
    status: 'pool',
    hook,
    pair,
    key,
    sqrtP,
    poolId,
    pairIsC0,
    price,
    issuance,
  }
}

// -------------------------------------------------------- LP position reads --

type LpPositionsResult =
  | { status: 'unavailable' }
  | { status: 'empty' }
  | {
      status: 'positions'
      owners: LpOwner[]
      totalPair: bigint
      totalTok: bigint
      positions: LpPosition[]
      poolPrice: number
      pairIsC0: boolean
      pairDecimals: number
      pairSymbol: string
      sqrtP: bigint
    }

type LpOwner = {
  address: Address
  valuePair: number
  pair: bigint
  tok: bigint
  positions: number
}

type LpPosition = {
  tokenId: bigint
  owner: Address
  tickLower: number
  tickUpper: number
  liquidity: bigint
  pair: bigint
  tok: bigint
}

type RawLog = {
  topics?: (string | null)[]
  data?: string
  blockNumber?: string | bigint
}

const LP_LOG_WINDOW = 45_000n
const LP_LOG_BATCH_WINDOWS = 8
const LP_LOG_REORG_OVERLAP = 128n
// Bounds RPC load: the buyback pools are recent, so their Initialize event sits
// well within this many windows of the chain tip. Beyond it, we degrade to a
// note rather than issue an unbounded number of eth_getLogs requests.
const LP_MAX_WINDOWS = 80

function hexBlock(n: bigint): string {
  return '0x' + n.toString(16)
}

async function getPoolLogs(
  client: PublicClient,
  pm: Address,
  poolId: `0x${string}`,
  from: bigint,
  to: bigint,
  onlyInitialize: boolean,
): Promise<RawLog[]> {
  const topics = [
    onlyInitialize
      ? INITIALIZE_TOPIC
      : [INITIALIZE_TOPIC, MODIFY_LIQUIDITY_TOPIC],
    poolId,
  ]
  return (await client.request({
    method: 'eth_getLogs',
    params: [
      {
        address: pm,
        topics,
        fromBlock: hexBlock(from),
        toBlock: hexBlock(to),
      },
    ],
  } as never)) as RawLog[]
}

type ScanState = {
  initBlock: bigint | null
  ids: Map<string, { id: bigint; block: bigint }>
}

type PoolHistoryCache = {
  initBlock: bigint
  throughBlock: bigint
  entries: { id: bigint; block: bigint }[]
}

const poolHistoryCache = new Map<string, PoolHistoryCache>()

function collectPoolLog(log: RawLog, posm: Address, state: ScanState): void {
  const t0 = lc(String(log.topics?.[0] ?? ''))
  if (t0 === INITIALIZE_TOPIC) {
    const block =
      typeof log.blockNumber === 'bigint'
        ? log.blockNumber
        : BigInt(log.blockNumber ?? 0)
    if (state.initBlock == null || block < state.initBlock) {
      state.initBlock = block
    }
    return
  }
  if (t0 !== MODIFY_LIQUIDITY_TOPIC) return
  const id = modifyLiquidityTokenId(log, posm)
  if (id == null) return
  const block =
    typeof log.blockNumber === 'bigint'
      ? log.blockNumber
      : BigInt(log.blockNumber ?? 0)
  const known = state.ids.get(id.toString())
  if (!known || block < known.block) {
    state.ids.set(id.toString(), { id, block })
  }
}

async function scanKnownPoolRange(
  client: PublicClient,
  pm: Address,
  posm: Address,
  poolId: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  state: ScanState,
): Promise<void> {
  let cursor = fromBlock
  while (cursor <= toBlock) {
    const spans: { lo: bigint; hi: bigint }[] = []
    for (
      let n = 0;
      n < LP_LOG_BATCH_WINDOWS && cursor <= toBlock;
      n++
    ) {
      const end = cursor + LP_LOG_WINDOW - 1n
      const hi = end > toBlock ? toBlock : end
      spans.push({ lo: cursor, hi })
      cursor = hi + 1n
    }
    const batches = await Promise.all(
      spans.map(({ lo, hi }) =>
        getPoolLogs(client, pm, poolId, lo, hi, false),
      ),
    )
    for (const logs of batches) {
      for (const log of logs) collectPoolLog(log, posm, state)
    }
  }
}

/**
 * Every PositionManager NFT id ever used in this pool. Port of website
 * lpPoolPositionTokenIds: try one wide eth_getLogs (works on archive providers
 * for a single pool's small, topic-filtered result set); on failure, scan
 * backward in bounded windows until the pool's Initialize event is found.
 * Incomplete history throws — it never becomes a silently short list.
 */
async function scanPoolTokenIds(
  client: PublicClient,
  pm: Address,
  posm: Address,
  poolId: `0x${string}`,
): Promise<bigint[]> {
  const latest = await client.getBlockNumber()
  const cacheKey = `${client.chain?.id ?? 'unknown'}:${pm.toLowerCase()}:${posm.toLowerCase()}:${poolId.toLowerCase()}`
  let cached = poolHistoryCache.get(cacheKey)
  if (cached && latest < cached.throughBlock) {
    poolHistoryCache.delete(cacheKey)
    cached = undefined
  }
  const state: ScanState = {
    initBlock: cached?.initBlock ?? null,
    ids: new Map(),
  }

  if (cached) {
    const overlap =
      cached.throughBlock > LP_LOG_REORG_OVERLAP
        ? cached.throughBlock - LP_LOG_REORG_OVERLAP + 1n
        : cached.initBlock
    const overlapStart = overlap < cached.initBlock ? cached.initBlock : overlap
    for (const entry of cached.entries) {
      if (entry.block < overlapStart) state.ids.set(entry.id.toString(), entry)
    }
    await scanKnownPoolRange(
      client,
      pm,
      posm,
      poolId,
      overlapStart,
      latest,
      state,
    )
  } else {
    // Find the single indexed Initialize event first. Unlike an all-history
    // ModifyLiquidity request, this remains cheap even for an old pool.
    try {
      const logs = await getPoolLogs(client, pm, poolId, 0n, latest, true)
      for (const log of logs) collectPoolLog(log, posm, state)
    } catch {
      state.initBlock = null
    }

    if (state.initBlock != null) {
      await scanKnownPoolRange(
        client,
        pm,
        posm,
        poolId,
        state.initBlock,
        latest,
        state,
      )
    } else {
      // Range-limited RPC: walk backwards in parallel batches until the
      // Initialize event proves that the accumulated history is complete.
      let cursor = latest
      let windows = 0
      while (state.initBlock == null && windows < LP_MAX_WINDOWS) {
        const spans: { lo: bigint; hi: bigint }[] = []
        for (
          let n = 0;
          n < LP_LOG_BATCH_WINDOWS && windows < LP_MAX_WINDOWS;
          n++
        ) {
          const lo = cursor >= LP_LOG_WINDOW ? cursor - LP_LOG_WINDOW + 1n : 0n
          spans.push({ lo, hi: cursor })
          windows++
          if (lo === 0n) break
          cursor = lo - 1n
        }
        const batches = await Promise.all(
          spans.map(({ lo, hi }) =>
            getPoolLogs(client, pm, poolId, lo, hi, false),
          ),
        )
        for (const logs of batches) {
          for (const log of logs) collectPoolLog(log, posm, state)
        }
        if (spans.at(-1)?.lo === 0n && state.initBlock == null) {
          throw new Error('Pool initialization log not found')
        }
      }
    }
  }

  if (state.initBlock == null) {
    throw new Error('Could not verify the complete LP history')
  }
  const entries = [...state.ids.values()]
  poolHistoryCache.set(cacheKey, {
    initBlock: state.initBlock,
    throughBlock: latest,
    entries,
  })
  return entries
    .map(entry => entry.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

type PositionDetail = {
  tokenId: bigint
  info: bigint
  owner: Address | null
  liquidity: bigint
}

/** Read each position (info, owner, liquidity) and verify it belongs to the
 *  expected pool. Port of website lpReadPositionDetails (~line 20916). */
async function readPositionDetails(
  client: PublicClient,
  posm: Address,
  tokenIds: bigint[],
  expectedPoolId: `0x${string}`,
): Promise<PositionDetail[]> {
  const details = await Promise.all(
    tokenIds.map(async tokenId => {
      const [info, ownerRes, liquidity] = await Promise.all([
        client
          .readContract({
            address: posm,
            abi: positionViewAbi,
            functionName: 'positionInfo',
            args: [tokenId],
          })
          .then(x => BigInt(x as bigint)),
        client
          .readContract({
            address: posm,
            abi: positionViewAbi,
            functionName: 'ownerOf',
            args: [tokenId],
          })
          .then(owner => ({ owner: owner as Address, error: null }))
          .catch((error: unknown) => ({ owner: null, error })),
        client
          .readContract({
            address: posm,
            abi: positionViewAbi,
            functionName: 'getPositionLiquidity',
            args: [tokenId],
          })
          .then(x => BigInt(x as bigint)),
      ])
      // ownerOf legitimately reverts after a burn; a live position that can't
      // read its owner is incomplete data, not an empty position.
      if (ownerRes.error && info !== 0n && liquidity !== 0n) throw ownerRes.error
      return { tokenId, info, owner: ownerRes.owner, liquidity }
    }),
  )

  await Promise.all(
    details.map(async detail => {
      if (!detail.owner || detail.info === 0n || detail.liquidity === 0n) return
      const res = (await client.readContract({
        address: posm,
        abi: positionViewAbi,
        functionName: 'getPoolAndPositionInfo',
        args: [detail.tokenId],
      })) as readonly [PoolKey, bigint]
      const key = res[0]
      const info = BigInt(res[1])
      if (!key || info !== detail.info) {
        throw new Error('PositionManager returned inconsistent LP position data')
      }
      if (lc(computePoolId(key)) !== lc(expectedPoolId)) {
        throw new Error('PositionManager token does not belong to the pool')
      }
    }),
  )
  return details
}

/**
 * Enumerate + aggregate the pool's V4 LP positions. Port of website
 * readLpPositions: finds tokenIds from ModifyLiquidity logs (salt == tokenId),
 * reads each, then maps liquidity to exact pair/project-token amounts. Null
 * position manager (e.g. OP Sepolia) -> unavailable; incomplete reads throw.
 */
async function readLpPositions(
  client: PublicClient,
  chainId: JBChainId,
  pool: Extract<MarketResult, { status: 'pool' }>,
): Promise<LpPositionsResult> {
  const posm = POSITION_MANAGER_BY_CHAIN[chainId]
  const pm = POOL_MANAGER_BY_CHAIN[chainId]
  if (!posm || !pm) return { status: 'unavailable' }

  const tokenIds = await scanPoolTokenIds(client, pm, posm, pool.poolId)
  if (!tokenIds.length) return { status: 'empty' }
  const details = await readPositionDetails(client, posm, tokenIds, pool.poolId)

  const { sqrtP, pairIsC0, pair, price } = pool
  const pairScale = Math.pow(10, pair.decimals)
  let totalPair = 0n
  let totalTok = 0n
  const positions: LpPosition[] = []
  const byOwner = new Map<string, LpOwner>()

  for (const p of details) {
    if (!p.owner || p.liquidity <= 0n || p.info === 0n) continue
    const tickUpper = tickUpperOf(p.info)
    const tickLower = tickLowerOf(p.info)
    const amounts = getAmountsForLiquidity(
      sqrtP,
      sqrtAtTick(tickLower),
      sqrtAtTick(tickUpper),
      p.liquidity,
    )
    const pairAmt = pairIsC0 ? amounts.amount0 : amounts.amount1
    const tokAmt = pairIsC0 ? amounts.amount1 : amounts.amount0
    totalPair += pairAmt
    totalTok += tokAmt
    positions.push({
      tokenId: p.tokenId,
      owner: p.owner,
      tickLower,
      tickUpper,
      liquidity: p.liquidity,
      pair: pairAmt,
      tok: tokAmt,
    })
    // Value each owner's stake in pair-token terms.
    const val = Number(pairAmt) / pairScale + (Number(tokAmt) / 1e18) * price
    const k = p.owner.toLowerCase()
    const cur =
      byOwner.get(k) ??
      ({
        address: p.owner,
        valuePair: 0,
        pair: 0n,
        tok: 0n,
        positions: 0,
      } as LpOwner)
    cur.valuePair += val
    cur.pair += pairAmt
    cur.tok += tokAmt
    cur.positions += 1
    byOwner.set(k, cur)
  }

  if (!positions.length) return { status: 'empty' }
  const owners = [...byOwner.values()].sort((a, b) => b.valuePair - a.valuePair)
  return {
    status: 'positions',
    owners,
    totalPair,
    totalTok,
    positions,
    poolPrice: price,
    pairIsC0,
    pairDecimals: pair.decimals,
    pairSymbol: pair.symbol,
    sqrtP,
  }
}

/** One of the connected wallet's own positions in a pool. */
export interface UserLpPosition {
  tokenId: bigint
  tickLower: number
  tickUpper: number
  liquidity: bigint
  /** Pair-token amount at the current price (raw, pair decimals). */
  pairAmount: bigint
  /** Project-token amount at the current price (raw, 18 decimals). */
  tokenAmount: bigint
}

/**
 * The positions in this pool owned by one wallet, freshly read.
 *
 * Shares the pool-wide scan: tokenIds come from ModifyLiquidity logs (salt ==
 * tokenId), and every position is verified to belong to this pool before it is
 * shown. An incomplete log scan throws rather than presenting a short list as
 * "you have no positions".
 */
export async function readUserLpPositions(
  client: PublicClient,
  chainId: JBChainId,
  pool: Extract<MarketResult, { status: 'pool' }>,
  owner: Address,
): Promise<UserLpPosition[]> {
  const posm = POSITION_MANAGER_BY_CHAIN[chainId]
  const pm = POOL_MANAGER_BY_CHAIN[chainId]
  if (!posm || !pm) return []

  const tokenIds = await scanPoolTokenIds(client, pm, posm, pool.poolId)
  if (!tokenIds.length) return []
  const details = await readPositionDetails(client, posm, tokenIds, pool.poolId)

  const mine: UserLpPosition[] = []
  for (const p of details) {
    if (!p.owner || p.liquidity <= 0n || p.info === 0n) continue
    if (lc(p.owner) !== lc(owner)) continue
    const tickLower = tickLowerOf(p.info)
    const tickUpper = tickUpperOf(p.info)
    const amounts = getAmountsForLiquidity(
      pool.sqrtP,
      sqrtAtTick(tickLower),
      sqrtAtTick(tickUpper),
      p.liquidity,
    )
    mine.push({
      tokenId: p.tokenId,
      tickLower,
      tickUpper,
      liquidity: p.liquidity,
      pairAmount: pool.pairIsC0 ? amounts.amount0 : amounts.amount1,
      tokenAmount: pool.pairIsC0 ? amounts.amount1 : amounts.amount0,
    })
  }
  return mine
}

// ------------------------------------------------------------- component --

export function MarketSection({
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
  const etherscanHost = chainMeta?.etherscanHostname
  const nativeSymbol = chainMeta?.nativeTokenSymbol ?? 'ETH'

  // The project's OWN token symbol — the passed-in prop is the bendystraw
  // accounting-token symbol (e.g. "ETH"), which is NOT the project token.
  const { data: projectToken } = useProjectTokenSymbol(chainId, projectId)
  const sym = projectToken?.symbol || tokenSymbol || 'tokens'

  const {
    data: market,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['market', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => resolveMarket(publicClient!, chainId, projectId, nativeSymbol),
  })

  const hasPool = market?.status === 'pool'

  const { data: floor } = useCashOutFloor(chainId, projectId, hasPool)

  const {
    data: lp,
    isLoading: lpLoading,
    isError: lpError,
  } = useQuery({
    queryKey: ['marketLp', chainId, projectId],
    enabled: !!publicClient && hasPool,
    staleTime: 60_000,
    retry: 0,
    queryFn: () =>
      readLpPositions(
        publicClient!,
        chainId,
        market as Extract<MarketResult, { status: 'pool' }>,
      ),
  })

  if (isLoading) {
    return <MarketSectionSkeleton />
  }

  if (isError) {
    return (
      <div className="card p-5">
        <div>
          <span className="field-label">Market</span>
          <p className="mt-2 text-sm leading-relaxed text-smoke-700">
            Couldn&apos;t read the market pool right now — try again in a moment.
          </p>
        </div>
      </div>
    )
  }

  if (!market || market.status !== 'pool') {
    return (
      <div className="card p-5">
        <div>
          <span className="field-label">Market</span>
          <p className="mt-2 text-sm leading-relaxed text-smoke-700">
            No market pool yet — this token trades only through the project.
          </p>
        </div>
      </div>
    )
  }

  const pm = POOL_MANAGER_BY_CHAIN[chainId]
  const inverse = market.price > 0 ? 1 / market.price : 0
  const pairSym = market.pair.symbol

  return (
    <div className="space-y-5">
      {/* AMM price */}
      <div className="card p-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="field-label">Market price</span>
            <span
              className="rounded-full bg-bluebs-50 px-2 py-0.5 text-[11px] font-medium text-bluebs-700"
              title="Uniswap V4 buyback pool"
            >
              AMM
            </span>
            {pm && etherscanHost ? (
              <AddressLink
                address={pm}
                host={etherscanHost}
                className="text-xs text-smoke-500 hover:text-ink"
              />
            ) : null}
          </div>

          <p className="mt-3 text-lg font-medium text-ink">
            1 {sym} = {formatPrice(market.price)} {pairSym}
          </p>
          <p className="mt-0.5 text-sm text-smoke-700">
            1 {pairSym} = {formatPrice(inverse)} {sym}
          </p>

          {(market.issuance && market.issuance > 0) ||
          (floor && floor > 0) ? (
            <dl className="mt-5 space-y-1.5 border-t border-smoke-100 pt-3 text-sm">
              {market.issuance && market.issuance > 0 ? (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-smoke-700">Issuance price (ceiling)</dt>
                  <dd className="font-medium text-ink">
                    {formatPrice(market.issuance)} {pairSym}
                  </dd>
                </div>
              ) : null}
              {floor && floor > 0 ? (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-smoke-700">Cash-out price (floor)</dt>
                  <dd className="font-medium text-ink">
                    {formatPrice(floor)} {pairSym}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>
        <p className="mt-4 border-t border-smoke-100 pt-3 text-xs leading-relaxed text-smoke-500">
          The market fills orders that would give payers more {sym} than
          issuance. Arbitrage keeps its price between the issuance ceiling and
          the cash-out floor.
        </p>
      </div>

      {/* LP composition + depth */}
      <div className="card p-5">
        <span className="field-label">Liquidity</span>

        {lpLoading ? (
          <LiquidityBodySkeleton />
        ) : lpError ? (
          <p className="mt-3 text-sm leading-relaxed text-smoke-700">
            Couldn&apos;t read the pool&apos;s liquidity positions here right
            now. The market price above is still live.
          </p>
        ) : !lp || lp.status === 'unavailable' ? (
          <p className="mt-3 text-sm leading-relaxed text-smoke-700">
            The detailed liquidity breakdown isn&apos;t available on this chain.
            The market price above is still live.
          </p>
        ) : lp.status === 'empty' ? (
          <p className="mt-3 text-sm leading-relaxed text-smoke-700">
            The pool is seeded but has no LP positions yet.
          </p>
        ) : (
          <div className="mt-4 space-y-5">
            <CompositionBar lp={lp} sym={sym} />
            <DepthChart
              lp={lp}
              sym={sym}
              amm={market.price}
              issuance={market.issuance}
              cashout={floor ?? null}
            />
          </div>
        )}
        {lp?.status === 'positions' ? (
          <LiquidityProviders lp={lp} sym={sym} chainId={chainId} />
        ) : null}
      </div>
    </div>
  )
}

// ------------------------------------------------------- liquidity providers --

/** Donut slice colors, cycled per provider. */
const PROVIDER_COLORS = [
  '#5777EB',
  '#F5A312',
  '#3BAA9A',
  '#D2528F',
  '#8B5CF6',
  '#EF6C4D',
]

/**
 * Who supplies this pool: one donut slice and one row per provider, sized by
 * the pair-token value of their positions. Amounts are the exact reserves each
 * provider's liquidity represents at the current price.
 */
function LiquidityProviders({
  lp,
  sym,
  chainId,
}: {
  lp: Extract<LpPositionsResult, { status: 'positions' }>
  sym: string
  chainId: JBChainId
}) {
  const total = lp.owners.reduce((sum, owner) => sum + owner.valuePair, 0)
  if (!(total > 0)) return null

  // Cumulative offsets around a 100-unit circumference give each provider one
  // slice without a charting dependency.
  const slices = lp.owners.reduce<
    { pct: number; offset: number; color: string }[]
  >((acc, owner, index) => {
    const pct = (owner.valuePair / total) * 100
    const offset = acc.length ? acc[acc.length - 1].offset + acc[acc.length - 1].pct : 0
    acc.push({
      pct,
      offset,
      color: PROVIDER_COLORS[index % PROVIDER_COLORS.length],
    })
    return acc
  }, [])

  return (
    <div className="mt-5 border-t border-smoke-200 pt-4">
      <span className="text-xs font-medium text-smoke-700">
        Liquidity providers
      </span>
      <div className="mt-3 flex flex-wrap items-center gap-6">
        <div className="relative h-32 w-32 shrink-0">
          <svg viewBox="0 0 42 42" className="h-32 w-32 -rotate-90">
            {slices.map((slice, index) => (
              <circle
                key={index}
                cx="21"
                cy="21"
                r="15.915"
                fill="transparent"
                stroke={slice.color}
                strokeWidth="6"
                strokeDasharray={`${slice.pct} ${100 - slice.pct}`}
                strokeDashoffset={`${100 - slice.offset}`}
              />
            ))}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-xl font-medium text-ink">
              {lp.owners.length}
            </span>
            <span className="text-[11px] text-smoke-500">
              {lp.owners.length === 1 ? 'LP' : 'LPs'}
            </span>
          </div>
        </div>

        <div className="min-w-[260px] flex-1 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-smoke-500">
                <th className="py-1.5 pr-3 font-normal">Account</th>
                <th className="py-1.5 pr-3 text-right font-normal">
                  {lp.pairSymbol}
                </th>
                <th className="py-1.5 pr-3 text-right font-normal">{sym}</th>
                <th className="py-1.5 text-right font-normal">Share</th>
              </tr>
            </thead>
            <tbody className="text-smoke-700">
              {lp.owners.map((owner, index) => (
                <tr key={owner.address}>
                  <td className="py-1.5 pr-3">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          background:
                            PROVIDER_COLORS[index % PROVIDER_COLORS.length],
                        }}
                      />
                      <AddressLink
                        address={owner.address}
                        chainId={chainId}
                        className="font-mono text-xs text-ink"
                        title={owner.address}
                      />
                    </span>
                    {owner.positions > 1 ? (
                      <span className="block text-[11px] text-smoke-500">
                        {owner.positions} positions
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-right">
                    {formatTokenAmount(owner.pair, lp.pairDecimals)}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-right">
                    {formatTokenAmount(owner.tok, 18)}
                  </td>
                  <td className="whitespace-nowrap py-1.5 text-right font-medium text-ink">
                    {((owner.valuePair / total) * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------- composition bar --

const PAIR_COLOR = '#5777EB' // bluebs-500
const TOK_COLOR = '#F5A312' // split-500

function CompositionBar({
  lp,
  sym,
}: {
  lp: Extract<LpPositionsResult, { status: 'positions' }>
  sym: string
}) {
  const pairScale = Math.pow(10, lp.pairDecimals)
  const pairF = Number(lp.totalPair) / pairScale
  const tokVal = (Number(lp.totalTok) / 1e18) * lp.poolPrice
  const total = pairF + tokVal

  if (!(total > 0)) {
    return (
      <p className="text-sm text-smoke-700">
        The pool holds no reserves at the current price.
      </p>
    )
  }

  const pairPct = (pairF / total) * 100
  const tokPct = (tokVal / total) * 100

  return (
    <div>
      <span className="text-xs font-medium text-smoke-700">Composition</span>
      <div className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-smoke-100">
        <div style={{ width: `${pairPct}%`, background: PAIR_COLOR }} />
        <div style={{ width: `${tokPct}%`, background: TOK_COLOR }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-smoke-700">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: PAIR_COLOR }}
          />
          {lp.pairSymbol} {formatPrice(pairF)} ({pairPct.toFixed(1)}%)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: TOK_COLOR }}
          />
          {sym} {formatTokenAmount(lp.totalTok)} ({tokPct.toFixed(1)}%)
        </span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------- depth chart --

// Plot geometry (jbm chart language: 320-wide viewBox, gutter-less bars).
const DVW = 320
const DPAD_T = 22 // room for marker labels
const DPAD_B = 16
const DN = 56 // liquidity bands

const BUY_COLOR = '#9AAEF5' // bluebs-300 — below the current price (support)
const SELL_COLOR = '#FFD27A' // split-300 — above the current price
const FLOOR_COLOR = '#E0561B' // orange-500
const PRICE_COLOR = '#F5A312' // split-500
const CEILING_COLOR = '#4FA270' // green-600

type Band = {
  mid: number
  liq: number
  pair: bigint
  tok: bigint
}

/**
 * Liquidity-by-price depth histogram. Port of website renderLpDepthChart:
 * log-scaled price axis, per-band active liquidity (bar height) + the pair/
 * project-token amounts each band holds at the current price (hover). Bars are
 * colored by side of the current AMM price; dashed markers flag the cash-out
 * floor, AMM price, and issuance ceiling. All tick/liquidity math is the exact
 * Q64.96 bigint port (src/lib/uniswap-v4.ts).
 */
function DepthChart({
  lp,
  sym,
  amm,
  issuance,
  cashout,
}: {
  lp: Extract<LpPositionsResult, { status: 'positions' }>
  sym: string
  amm: number
  issuance: number | null
  cashout: number | null
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const model = useMemo(() => {
    const { positions, sqrtP, pairIsC0, pairDecimals, pairSymbol } = lp
    const decFactor = Math.pow(10, 18 - pairDecimals)
    const priceAtTick = (t: number) =>
      (pairIsC0 ? 1 / Math.pow(1.0001, t) : Math.pow(1.0001, t)) * decFactor
    const tickAtPrice = (p: number) =>
      Math.log(pairIsC0 ? decFactor / p : p / decFactor) / Math.log(1.0001)

    let pmin = Infinity
    let pmax = -Infinity
    for (const p of positions) {
      const a = priceAtTick(p.tickLower)
      const b = priceAtTick(p.tickUpper)
      pmin = Math.min(pmin, a, b)
      pmax = Math.max(pmax, a, b)
    }
    for (const v of [amm, issuance, cashout]) {
      if (v && v > 0) {
        pmin = Math.min(pmin, v)
        pmax = Math.max(pmax, v)
      }
    }
    if (!(pmax > pmin) || !isFinite(pmin) || !isFinite(pmax) || pmin <= 0) {
      return null
    }
    const lmin = Math.log(pmin)
    const lmax = Math.log(pmax)
    const span = lmax - lmin || 1

    const bands: Band[] = []
    for (let i = 0; i < DN; i++) {
      const mid = Math.exp(lmin + ((i + 0.5) / DN) * span)
      const pLo = Math.exp(lmin + (i / DN) * span)
      const pHi = Math.exp(lmin + ((i + 1) / DN) * span)
      // Pair/token price falls with tick when pair is currency0 and rises when
      // it is currency1. Normalize both orientations before intersecting.
      const bandTickA = tickAtPrice(pLo)
      const bandTickB = tickAtPrice(pHi)
      const bTickLo = Math.min(bandTickA, bandTickB)
      const bTickHi = Math.max(bandTickA, bandTickB)
      let liq = 0
      let pairW = 0n
      let tokW = 0n
      for (const p of positions) {
        const positionPriceA = priceAtTick(p.tickLower)
        const positionPriceB = priceAtTick(p.tickUpper)
        const plo = Math.min(positionPriceA, positionPriceB)
        const phi = Math.max(positionPriceA, positionPriceB)
        if (mid >= plo && mid <= phi) liq += Number(p.liquidity)
        const oLo = Math.max(bTickLo, p.tickLower)
        const oHi = Math.min(bTickHi, p.tickUpper)
        if (oLo < oHi) {
          const am = getAmountsForLiquidity(
            sqrtP,
            sqrtAtTick(Math.round(oLo)),
            sqrtAtTick(Math.round(oHi)),
            p.liquidity,
          )
          pairW += pairIsC0 ? am.amount0 : am.amount1
          tokW += pairIsC0 ? am.amount1 : am.amount0
        }
      }
      bands.push({ mid, liq, pair: pairW, tok: tokW })
    }
    const maxL = Math.max(...bands.map(b => b.liq), 1)

    const xOf = (price: number) =>
      ((Math.log(price) - lmin) / span) * DVW

    const markers = (
      [
        { price: cashout, color: FLOOR_COLOR, label: 'floor' },
        { price: amm, color: PRICE_COLOR, label: 'price' },
        { price: issuance, color: CEILING_COLOR, label: 'ceiling' },
      ] as { price: number | null; color: string; label: string }[]
    )
      .filter(
        m =>
          m.price != null &&
          m.price > 0 &&
          m.price >= pmin * (1 - 1e-9) &&
          m.price <= pmax * (1 + 1e-9),
      )
      .map(m => ({
        ...m,
        x: Math.max(0.8, Math.min(DVW - 0.8, xOf(m.price as number))),
      }))

    // Default hover = the band nearest the current AMM price.
    const currentIdx = Math.max(
      0,
      Math.min(DN - 1, Math.round(((Math.log(amm) - lmin) / span) * DN - 0.5)),
    )

    return {
      bands,
      maxL,
      lmin,
      lmax,
      span,
      pairSymbol,
      currentIdx,
      markers,
    }
  }, [lp, amm, issuance, cashout])

  if (!model) return null

  const { bands, maxL, lmin, lmax, currentIdx, markers, pairSymbol } = model
  const plotTop = DPAD_T
  const plotH = 130 - DPAD_T
  const bw = DVW / DN
  const shownIdx = hoverIdx ?? currentIdx
  const shown = bands[shownIdx]
  const hasLiq = shown && (shown.pair > 0n || shown.tok > 0n || shown.liq > 0)
  const side =
    shown && shown.mid < amm ? ' | buy-side' : shown ? ' | sell-side' : ''

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const vx = ((e.clientX - rect.left) / rect.width) * DVW
    const idx = Math.floor(vx / bw)
    setHoverIdx(idx >= 0 && idx < DN ? idx : null)
  }

  return (
    <div>
      <span className="text-xs font-medium text-smoke-700">Depth</span>
      <svg
        viewBox={`0 0 ${DVW} ${130 + DPAD_B}`}
        className="mt-2 h-auto w-full cursor-crosshair touch-none"
        role="img"
        aria-label={`${sym} pool liquidity by price`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        {/* Liquidity bars, colored by side of the current price. */}
        {bands.map((b, j) => {
          if (b.liq <= 0) return null
          const h = (b.liq / maxL) * plotH
          const x = j * bw
          const highlight = j === shownIdx
          return (
            <rect
              key={j}
              x={x.toFixed(1)}
              y={(plotTop + plotH - h).toFixed(1)}
              width={Math.max(0.5, bw - 0.5).toFixed(1)}
              height={h.toFixed(1)}
              fill={b.mid < amm ? BUY_COLOR : SELL_COLOR}
              opacity={highlight ? 0.95 : 0.6}
            />
          )
        })}
        {/* Markers: floor / price / ceiling. */}
        {markers.map(m => (
          <g key={m.label}>
            <line
              x1={m.x.toFixed(1)}
              y1={plotTop}
              x2={m.x.toFixed(1)}
              y2={plotTop + plotH}
              stroke={m.color}
              strokeWidth="1.5"
              strokeDasharray="3 2"
            />
            <text
              x={Math.max(14, Math.min(DVW - 14, m.x)).toFixed(1)}
              y={plotTop - 6}
              fontSize="8"
              fill="#575344"
              textAnchor="middle"
            >
              {m.label}
            </text>
          </g>
        ))}
        {/* Price-axis end labels. */}
        <text x={0} y={130 + DPAD_B - 4} fontSize="8" fill="#9C9580">
          {formatPrice(Math.exp(lmin))}
        </text>
        <text
          x={DVW}
          y={130 + DPAD_B - 4}
          fontSize="8"
          fill="#9C9580"
          textAnchor="end"
        >
          {formatPrice(Math.exp(lmax))}
        </text>
      </svg>
      <p className="mt-1 text-xs leading-relaxed text-smoke-700" aria-live="polite">
        {shown ? (
          <>
            <span className="font-medium text-ink">
              ~{formatPrice(shown.mid)} {pairSymbol}/{sym}
            </span>
            {side}
            {' — '}
            {hasLiq
              ? `${formatTokenAmount(shown.tok)} ${sym} + ${formatPrice(
                  Number(shown.pair) / Math.pow(10, lp.pairDecimals),
                )} ${pairSymbol}`
              : 'no liquidity here'}
          </>
        ) : null}
      </p>
    </div>
  )
}
