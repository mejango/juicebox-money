import { unstable_cache } from 'next/cache'
import { formatUnits } from 'viem'
import {
  getAddToBalanceInflows,
  getProjectMoments,
  getSuckerGroupMoments,
  suckerGroupAccountingToken,
  type BsAddToBalance,
} from './bendystraw'
import {
  getHomepageBalanceGroups,
  getHomepageEthPrice,
} from './top-projects'

export type ReservePoint = {
  timestamp: number
  valueUsd: number
  /** The point's value split by chain. Absent where no per-chain history is
   *  available — the volume and fee series, or a project whose moments the
   *  indexer didn't return. */
  chains?: Array<{ chainId: number; valueUsd: number }>
}
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
    const [groups, ethPrice, addToBalances] = await Promise.all([
      getHomepageBalanceGroups(),
      getHomepageEthPrice(),
      getAddToBalanceInflows().catch(() => [] as BsAddToBalance[]),
    ])
    // `volume` counts payments only. Funds added straight to a terminal are money
    // that passed through too, and without them a treasury can report holding more
    // than it ever received.
    const addedByGroup = new Map<string, bigint>()
    for (const event of addToBalances) {
      addedByGroup.set(
        event.suckerGroupId,
        (addedByGroup.get(event.suckerGroupId) ?? 0n) + BigInt(event.amount),
      )
    }
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
      const volume = Number(
        formatUnits(
          BigInt(group.volume) + (addedByGroup.get(group.id) ?? 0n),
          decimals,
        ),
      )
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
    const historicalProjects = supported.flatMap(({ group, symbol, decimals }) =>
      group.projects.items.map(project => ({
        key: `${project.chainId}:${project.version}:${project.projectId}`,
        chainId: project.chainId,
        projectId: project.projectId,
        version: project.version,
        symbol,
        decimals,
        currentAmount: Number(formatUnits(BigInt(project.balance), decimals)),
      })),
    )
    const projectHistories = await Promise.all(
      historicalProjects.map(async project => ({
        ...project,
        moments: await getProjectMoments(project).catch(() => []),
      })),
    )
    // A project with no moments would silently read as zero for all of history,
    // so only break out per-chain values when every project either reported
    // moments or holds nothing.
    const chainHistoryIsComplete = projectHistories.every(
      project => project.moments.length > 0 || project.currentAmount === 0,
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

    // Each project's own balance history, plus a final point at the last
    // aggregate moment so the breakdown lands on today's balances.
    const latestAggregateTimestamp = events.at(-1)?.timestamp
    const projectEvents = projectHistories
      .flatMap(project => [
        ...project.moments.map(moment => ({
          key: project.key,
          chainId: project.chainId,
          symbol: project.symbol,
          timestamp: moment.timestamp,
          amount: Number(formatUnits(BigInt(moment.balance), project.decimals)),
        })),
        ...(latestAggregateTimestamp == null
          ? []
          : [
              {
                key: project.key,
                chainId: project.chainId,
                symbol: project.symbol,
                timestamp: latestAggregateTimestamp,
                amount: project.currentAmount,
              },
            ]),
      ])
      .sort((a, b) => a.timestamp - b.timestamp)
    const latestProjects = new Map<
      string,
      { chainId: number; symbol: string; amount: number }
    >()
    let projectEventIndex = 0

    // The same inflows, replayed in order, so the curve reaches the headline.
    const decimalsByGroup = new Map(
      supported.map(item => [item.group.id, item.decimals] as const),
    )
    const inflowEvents = addToBalances
      .filter(event => decimalsByGroup.has(event.suckerGroupId))
      .map(event => ({
        groupId: event.suckerGroupId,
        timestamp: event.timestamp,
        amount: Number(
          formatUnits(
            BigInt(event.amount),
            decimalsByGroup.get(event.suckerGroupId)!,
          ),
        ),
      }))
      .sort((a, b) => a.timestamp - b.timestamp)
    const addedSoFar = new Map<string, number>()
    let inflowIndex = 0

    const rawPoints: ReservePoint[] = []
    const rawVolumePoints: ReservePoint[] = []
    for (const event of events) {
      latest.set(event.groupId, event.amount)
      latestVolume.set(event.groupId, event.volume)
      while (
        inflowIndex < inflowEvents.length &&
        inflowEvents[inflowIndex].timestamp <= event.timestamp
      ) {
        const inflow = inflowEvents[inflowIndex]
        addedSoFar.set(
          inflow.groupId,
          (addedSoFar.get(inflow.groupId) ?? 0) + inflow.amount,
        )
        inflowIndex += 1
      }
      while (
        projectEventIndex < projectEvents.length &&
        projectEvents[projectEventIndex].timestamp <= event.timestamp
      ) {
        const projectEvent = projectEvents[projectEventIndex]
        latestProjects.set(projectEvent.key, {
          chainId: projectEvent.chainId,
          symbol: projectEvent.symbol,
          amount: projectEvent.amount,
        })
        projectEventIndex += 1
      }
      let valueUsd = 0
      let volumeUsd = 0
      for (const item of supported) {
        const amount = latest.get(item.group.id) ?? 0
        const volume =
          (latestVolume.get(item.group.id) ?? 0) +
          (addedSoFar.get(item.group.id) ?? 0)
        if (item.symbol === 'ETH') {
          valueUsd += amount * (ethPrice ?? 0)
          volumeUsd += volume * (ethPrice ?? 0)
        } else if (item.symbol === 'USDC') {
          valueUsd += amount
          volumeUsd += volume
        }
      }
      const chains = chainHistoryIsComplete
        ? RESERVE_CHAIN_IDS.map(chainId => ({
            chainId,
            valueUsd: [...latestProjects.values()].reduce((sum, project) => {
              if (project.chainId !== chainId) return sum
              if (project.symbol === 'ETH')
                return sum + project.amount * (ethPrice ?? 0)
              if (project.symbol === 'USDC') return sum + project.amount
              return sum
            }, 0),
          }))
        : undefined
      rawPoints.push({ timestamp: event.timestamp, valueUsd, chains })
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
