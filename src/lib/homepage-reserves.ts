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
}

const RESERVE_CHAIN_IDS = [1, 42161, 8453, 10] as const

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
      if (symbol === 'ETH') eth += amount
      else if (symbol === 'USDC') usdc += amount
      else otherSymbols.add(symbol)

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
    const latest = new Map<string, number>()
    const events = histories
      .flatMap(({ group, symbol, decimals, moments }) =>
        moments.map(moment => ({
          groupId: group.id,
          symbol,
          timestamp: moment.timestamp,
          amount: Number(formatUnits(BigInt(moment.balance), decimals)),
        })),
      )
      .sort((a, b) => a.timestamp - b.timestamp)

    const rawPoints: ReservePoint[] = []
    for (const event of events) {
      latest.set(event.groupId, event.amount)
      let valueUsd = 0
      for (const item of supported) {
        const amount = latest.get(item.group.id) ?? 0
        if (item.symbol === 'ETH') valueUsd += amount * (ethPrice ?? 0)
        else if (item.symbol === 'USDC') valueUsd += amount
      }
      rawPoints.push({ timestamp: event.timestamp, valueUsd })
    }

    const stride = Math.max(1, Math.ceil(rawPoints.length / 48))
    const points = rawPoints.filter(
      (_, index) => index % stride === 0 || index === rawPoints.length - 1,
    )
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
      points,
    }
  },
  ['juicebox-homepage-reserves-v3'],
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
    }
  }
}
