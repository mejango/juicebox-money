import { unstable_cache } from 'next/cache'
import { formatUnits } from 'viem'
import {
  getSuckerGroupMoments,
  suckerGroupAccountingToken,
} from './bendystraw'
import {
  getHomepageBalanceGroups,
  getHomepageEthPrice,
} from './top-projects'

export type ReservePoint = { timestamp: number; valueUsd: number }
export type ChainReserveBreakdown = {
  chainId: number
  eth: number
  usdc: number
  otherAssets: string[]
}
export type HomepageReserves = {
  eth: number
  usdc: number
  totalUsd: number
  otherAssets: number
  chains: ChainReserveBreakdown[]
  points: ReservePoint[]
  /** All-time payment volume across V6 projects, valued at the current ETH price. */
  passedThroughUsd: number
  volumePoints: ReservePoint[]
  /** JBP6's cumulative inflows — the fees it collects from payouts, cash outs,
   *  used allowances, and project creation. Measured as the sum of project 1's
   *  balance increases, so its own payouts and cash outs don't subtract. */
  feesUsd: number
  feePoints: ReservePoint[]
}

const RESERVE_CHAIN_IDS = [1, 42161, 8453, 10] as const

function downsample(points: ReservePoint[]): ReservePoint[] {
  const stride = Math.max(1, Math.ceil(points.length / 48))
  return points.filter(
    (_, index) => index % stride === 0 || index === points.length - 1,
  )
}

// Project 1 only has a native-token accounting context, so balances are ETH.
function feePointsFrom(
  histories: { group: { id: string }; decimals: number; moments: { timestamp: number; balance: string }[] }[],
  feeGroupIds: Set<string>,
  ethPrice: number | null,
): ReservePoint[] {
  const events = histories
    .filter(history => feeGroupIds.has(history.group.id))
    .flatMap(({ group, decimals, moments }) =>
      moments.map(moment => ({
        groupId: group.id,
        timestamp: moment.timestamp,
        balance: Number(formatUnits(BigInt(moment.balance), decimals)),
      })),
    )
    .sort((a, b) => a.timestamp - b.timestamp)
  let feeEth = 0
  const lastBalance = new Map<string, number>()
  return events.map(event => {
    const delta = event.balance - (lastBalance.get(event.groupId) ?? 0)
    lastBalance.set(event.groupId, event.balance)
    if (delta > 0) feeEth += delta
    return { timestamp: event.timestamp, valueUsd: feeEth * (ethPrice ?? 0) }
  })
}

const cachedHomepageReserves = unstable_cache(
  async (): Promise<HomepageReserves> => {
    const [groups, ethPrice] = await Promise.all([
      getHomepageBalanceGroups(),
      getHomepageEthPrice(),
    ])
    const supported = groups.flatMap(group => {
      const token = suckerGroupAccountingToken(group.projects.items)
      if (!token) return []
      const symbol = token.symbol.replace(/^\$+/, '').toUpperCase()
      return [{ group, symbol, decimals: token.decimals }]
    })

    let eth = 0
    let usdc = 0
    let passedThroughUsd = 0
    const otherSymbols = new Set<string>()
    const perChain = new Map<
      number,
      { eth: number; usdc: number; otherAssets: Set<string> }
    >(
      RESERVE_CHAIN_IDS.map(chainId => [
        chainId,
        { eth: 0, usdc: 0, otherAssets: new Set<string>() },
      ] as const),
    )
    for (const { group, symbol, decimals } of supported) {
      const amount = Number(formatUnits(BigInt(group.balance), decimals))
      const volume = Number(formatUnits(BigInt(group.volume), decimals))
      if (symbol === 'ETH') {
        eth += amount
        passedThroughUsd += volume * (ethPrice ?? 0)
      } else if (symbol === 'USDC') {
        usdc += amount
        passedThroughUsd += volume
      } else otherSymbols.add(symbol)

      for (const project of group.projects.items) {
        const chain = perChain.get(project.chainId)
        if (!chain) continue
        const chainAmount = Number(
          formatUnits(BigInt(project.balance), decimals),
        )
        if (symbol === 'ETH') chain.eth += chainAmount
        else if (symbol === 'USDC') chain.usdc += chainAmount
        else chain.otherAssets.add(symbol)
      }
    }

    const histories = await Promise.all(
      supported.map(async item => ({
        ...item,
        moments: await getSuckerGroupMoments(item.group.id).catch(() => []),
      })),
    )
    const feeGroupIds = new Set(
      groups
        .filter(group => group.projects.items.some(project => project.projectId === 1))
        .map(group => group.id),
    )
    const rawFeePoints = feePointsFrom(histories, feeGroupIds, ethPrice)
    const latest = new Map<string, number>()
    const latestVolume = new Map<string, number>()
    const events = histories
      .flatMap(({ group, symbol, decimals, moments }) =>
        moments.map(moment => ({
          groupId: group.id,
          symbol,
          timestamp: moment.timestamp,
          amount: Number(formatUnits(BigInt(moment.balance), decimals)),
          volume: Number(formatUnits(BigInt(moment.volume), decimals)),
        })),
      )
      .sort((a, b) => a.timestamp - b.timestamp)

    const rawPoints: ReservePoint[] = []
    const rawVolumePoints: ReservePoint[] = []
    for (const event of events) {
      latest.set(event.groupId, event.amount)
      latestVolume.set(event.groupId, event.volume)
      let valueUsd = 0
      let volumeUsd = 0
      for (const item of supported) {
        const amount = latest.get(item.group.id) ?? 0
        const volume = latestVolume.get(item.group.id) ?? 0
        if (item.symbol === 'ETH') {
          valueUsd += amount * (ethPrice ?? 0)
          volumeUsd += volume * (ethPrice ?? 0)
        } else if (item.symbol === 'USDC') {
          valueUsd += amount
          volumeUsd += volume
        }
      }
      rawPoints.push({ timestamp: event.timestamp, valueUsd })
      rawVolumePoints.push({ timestamp: event.timestamp, valueUsd: volumeUsd })
    }

    return {
      eth,
      usdc,
      totalUsd: eth * (ethPrice ?? 0) + usdc,
      otherAssets: otherSymbols.size,
      chains: RESERVE_CHAIN_IDS.map(chainId => {
        const chain = perChain.get(chainId)!
        return {
          chainId,
          eth: chain.eth,
          usdc: chain.usdc,
          otherAssets: [...chain.otherAssets].sort(),
        }
      }),
      points: downsample(rawPoints),
      passedThroughUsd,
      volumePoints: downsample(rawVolumePoints),
      feesUsd: rawFeePoints.at(-1)?.valueUsd ?? 0,
      feePoints: downsample(rawFeePoints),
    }
  },
  ['juicebox-homepage-reserves-v5'],
  { revalidate: 600 },
)

export async function getHomepageReserves(): Promise<HomepageReserves> {
  try {
    return await cachedHomepageReserves()
  } catch {
    return {
      eth: 0,
      usdc: 0,
      totalUsd: 0,
      otherAssets: 0,
      chains: RESERVE_CHAIN_IDS.map(chainId => ({
        chainId,
        eth: 0,
        usdc: 0,
        otherAssets: [],
      })),
      points: [],
      passedThroughUsd: 0,
      volumePoints: [],
      feesUsd: 0,
      feePoints: [],
    }
  }
}
