import { unstable_cache } from 'next/cache'
import { formatUnits } from 'viem'
import {
  getAddToBalanceInflows,
  getGroupVolumeMoments,
  getProjectTokenBalanceMoments,
  getProjectTokenBalances,
  type BsAddToBalance,
} from './bendystraw'
import { truncateAddress } from './format'
import { knownTokenSymbol } from './token-symbol'

export type ReservePoint = {
  timestamp: number
  valueUsd: number
  /** The point's value split by chain. Absent on the volume and fee series. */
  chains?: Array<{ chainId: number; valueUsd: number }>
}
type ChainReserveBreakdown = {
  chainId: number
  /** One line per token the chain's projects hold, largest USD value first. */
  tokens: Array<{ symbol: string; amount: number }>
}
export type HomepageReserves = {
  totalUsd: number
  chains: ChainReserveBreakdown[]
  points: ReservePoint[]
  /** All-time payments plus funds added to balances, each valued in USD at its own time. */
  passedThroughUsd: number
  volumePoints: ReservePoint[]
  /** JBP6's cumulative inflows — the fees it collects from payouts, cash outs,
   *  used allowances, and project creation. Measured as the sum of project 1's
   *  balance increases, each valued at its own time, so its own payouts and
   *  cash outs don't subtract. */
  feesUsd: number
  feePoints: ReservePoint[]
}

const RESERVE_CHAIN_IDS = [1, 42161, 8453, 10] as const
const FEE_PROJECT_ID = 1

function downsample(points: ReservePoint[]): ReservePoint[] {
  const stride = Math.max(1, Math.ceil(points.length / 48))
  return points.filter(
    (_, index) => index % stride === 0 || index === points.length - 1,
  )
}

const usd18 = (raw: string | null | undefined) =>
  raw ? Number(formatUnits(BigInt(raw), 18)) : 0

const cachedHomepageReserves = unstable_cache(
  async (): Promise<HomepageReserves> => {
    const [balances, tokenMoments, volumeMoments, addToBalances] =
      await Promise.all([
        getProjectTokenBalances(),
        // A missing history leaves the headline standing.
        getProjectTokenBalanceMoments().catch(() => []),
        getGroupVolumeMoments().catch(() => []),
        getAddToBalanceInflows().catch(() => [] as BsAddToBalance[]),
      ])

    let totalUsd = 0
    const perChain = new Map(
      RESERVE_CHAIN_IDS.map(chainId => [
        chainId as number,
        new Map<string, { symbol: string; amount: number; usd: number }>(),
      ]),
    )
    for (const row of balances) {
      const usd = usd18(row.balanceUsd)
      totalUsd += usd
      const tokens = perChain.get(row.chainId)
      if (!tokens || BigInt(row.balance) === 0n) continue
      const key = row.token.toLowerCase()
      const line = tokens.get(key) ?? {
        symbol:
          row.tokenSymbol?.replace(/^\$+/, '') ||
          knownTokenSymbol(row.token, { chainId: row.chainId }) ||
          truncateAddress(row.token),
        amount: 0,
        usd: 0,
      }
      line.amount += Number(formatUnits(BigInt(row.balance), row.decimals))
      line.usd += usd
      tokens.set(key, line)
    }

    // Each project-token pair holds at its latest balance, valued at the rate
    // recorded with it, so the curve lands on today's per-token balanceUsd.
    const held = new Map<string, { chainId: number; usd: number }>()
    const feeBalances = new Map<string, number>()
    let feesUsd = 0
    const rawPoints: ReservePoint[] = []
    const rawFeePoints: ReservePoint[] = []
    for (const moment of tokenMoments) {
      const key = `${moment.chainId}:${moment.projectId}:${moment.token.toLowerCase()}`
      const amount = Number(formatUnits(BigInt(moment.balance), moment.decimals))
      const rate = usd18(moment.tokenUsdRate)
      held.set(key, { chainId: moment.chainId, usd: amount * rate })
      if (moment.projectId === FEE_PROJECT_ID) {
        const delta = amount - (feeBalances.get(key) ?? 0)
        feeBalances.set(key, amount)
        if (delta > 0) feesUsd += delta * rate
        rawFeePoints.push({ timestamp: moment.timestamp, valueUsd: feesUsd })
      }
      const values = [...held.values()]
      rawPoints.push({
        timestamp: moment.timestamp,
        valueUsd: values.reduce((sum, value) => sum + value.usd, 0),
        chains: RESERVE_CHAIN_IDS.map(chainId => ({
          chainId,
          valueUsd: values.reduce(
            (sum, value) => (value.chainId === chainId ? sum + value.usd : sum),
            0,
          ),
        })),
      })
    }

    // `volumeUsd` counts payments only. Funds added straight to a terminal are
    // money that passed through too, and without them a treasury can report
    // holding more than it ever received. Replayed in order so the curve
    // reaches the headline.
    const inflows = addToBalances
      .map(event => ({ timestamp: event.timestamp, usd: usd18(event.amountUsd) }))
      .sort((a, b) => a.timestamp - b.timestamp)
    const groupVolume = new Map<string, number>()
    let added = 0
    let inflowIndex = 0
    const rawVolumePoints: ReservePoint[] = []
    for (const moment of volumeMoments) {
      groupVolume.set(moment.suckerGroupId, usd18(moment.volumeUsd))
      while (
        inflowIndex < inflows.length &&
        inflows[inflowIndex].timestamp <= moment.timestamp
      ) {
        added += inflows[inflowIndex].usd
        inflowIndex += 1
      }
      rawVolumePoints.push({
        timestamp: moment.timestamp,
        valueUsd: [...groupVolume.values()].reduce((sum, value) => sum + value, added),
      })
    }
    const passedThroughUsd = [...groupVolume.values()].reduce(
      (sum, value) => sum + value,
      inflows.reduce((sum, inflow) => sum + inflow.usd, 0),
    )

    return {
      totalUsd,
      chains: RESERVE_CHAIN_IDS.map(chainId => ({
        chainId,
        tokens: [...perChain.get(chainId)!.values()]
          .sort((a, b) => b.usd - a.usd)
          .map(({ symbol, amount }) => ({ symbol, amount })),
      })),
      points: downsample(rawPoints),
      passedThroughUsd,
      volumePoints: downsample(rawVolumePoints),
      feesUsd,
      feePoints: downsample(rawFeePoints),
    }
  },
  ['juicebox-homepage-reserves-v7'],
  { revalidate: 600 },
)

export async function getHomepageReserves(): Promise<HomepageReserves> {
  try {
    return await cachedHomepageReserves()
  } catch {
    return {
      totalUsd: 0,
      chains: RESERVE_CHAIN_IDS.map(chainId => ({ chainId, tokens: [] })),
      points: [],
      passedThroughUsd: 0,
      volumePoints: [],
      feesUsd: 0,
      feePoints: [],
    }
  }
}
