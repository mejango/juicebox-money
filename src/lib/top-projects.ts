import {
  JBCoreContracts,
  JB_CHAINS,
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jbContractAddress,
  jbMultiTerminalAbi,
  jbTerminalStoreAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { unstable_cache } from 'next/cache'
import { fillIndexedMetadata } from '@/lib/project-metadata-fill'
import { createPublicClient, formatUnits, isAddressEqual, type Address } from 'viem'
import { bendystraw, type BsProject } from './bendystraw'
import { readEthUsdPrice } from './eth-price'
import { indexedAmountsTrusted } from './indexed-amounts-trusted'
import { jbCenterRpcTransport } from './jbcenter-rpc'
import { toUrn } from './urn'

export type TopBalanceProject = {
  key: string
  href: string
  name: string
  tagline: string | null
  logoUri: string | null
  balanceUsd: number
}

export type BalanceGroup = {
  id: string
  balance: string
  volume: string
  projects: { items: BsProject[] }
}

type BalanceGroupsPage = {
  suckerGroups: { items: BalanceGroup[]; totalCount: number }
}

const cachedEthPrice = unstable_cache(
  async () => readEthUsdPrice(),
  ['juicebox-home-eth-price'],
  { revalidate: 1200 },
)

const cachedBalanceGroups = unstable_cache(
  async () => {
    const items: BalanceGroup[] = []
    let totalCount = 0
    do {
      const data = await bendystraw<BalanceGroupsPage>(
        `query($limit: Int!, $offset: Int!) {
          suckerGroups(
            where: { version: 6 }
            orderBy: "balance"
            orderDirection: "desc"
            limit: $limit
            offset: $offset
          ) {
            totalCount
            items {
              id balance volume
              projects(orderBy: "chainId", orderDirection: "asc", limit: 8) {
                items {
                  projectId chainId version name logoUri projectTagline volume volumeUsd balance
                  paymentsCount contributorsCount createdAt suckerGroupId token tokenSymbol
                  decimals currency isRevnet owner metadataUri
                }
              }
            }
          }
        }`,
        { limit: 250, offset: items.length },
        { policy: 'stable' },
      )
      const page = data.suckerGroups.items
      totalCount = data.suckerGroups.totalCount
      items.push(...page)
      if (!page.length) break
    } while (items.length < totalCount)
    return Promise.all(
      items.map(async group => ({
        ...group,
        projects: { items: await fillIndexedMetadata(group.projects.items) },
      })),
    )
  },
  ['juicebox-home-balance-groups-v3'],
  { revalidate: 600 },
)

export async function getHomepageBalanceGroups(): Promise<BalanceGroup[]> {
  try {
    return await cachedBalanceGroups()
  } catch {
    return []
  }
}

/** A deployment's live JBMultiTerminal balance in ETH and USDC. */
type LiveBalance = { chainId: number; eth: number; usdc: number }

/**
 * See indexedAmountsTrusted. The homepage's view of that rule.
 * `trusted` lists `chainId:projectId` for every deployment of a group whose
 * indexed amounts can be shown. `untrusted` maps every other group's id to
 * the live balances of the deployments that could be read, so it can be
 * valued without Bendystraw.
 */
type HomepageIndexedTrust = {
  trusted: string[]
  untrusted: Record<string, LiveBalance[]>
}

export const deploymentKey = (chainId: number, projectId: number) =>
  `${chainId}:${projectId}`

type Context = { token: Address; decimals: number }

/**
 * One multicall per chain. A failed call is null, which the rule never
 * trusts. A failed chain throws, so the cache keeps its last good answer.
 */
async function readPerChain<T, R>(
  items: { chainId: number; projectId: number; arg: T }[],
  contract: (chainId: JBChainId, item: { projectId: number; arg: T }) => {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  } | null,
): Promise<(R | null)[]> {
  const results: (R | null)[] = items.map(() => null)
  const byChain = new Map<number, number[]>()
  items.forEach((item, index) =>
    byChain.set(item.chainId, [...(byChain.get(item.chainId) ?? []), index]),
  )
  await Promise.all(
    [...byChain].map(async ([rawChainId, indexes]) => {
      const chainId = rawChainId as JBChainId
      const chain = JB_CHAINS[chainId]?.chain
      const contracts = indexes.map(index => contract(chainId, items[index]))
      if (!chain || contracts.some(call => !call)) return
      const client = createPublicClient({
        chain,
        transport: jbCenterRpcTransport(chainId, 8_000),
      })
      const answers = await client.multicall({
        contracts: contracts as never[],
        allowFailure: true,
      })
      answers.forEach((answer, position) => {
        if (answer.status === 'success')
          results[indexes[position]] = answer.result as R
      })
    }),
  )
  return results
}

export const getHomepageIndexedTrust = unstable_cache(
  async (): Promise<HomepageIndexedTrust> => {
    const groups = await cachedBalanceGroups()
    const deployments = groups.flatMap(group =>
      group.projects.items.map(project => ({
        chainId: project.chainId,
        projectId: project.projectId,
        arg: null,
      })),
    )
    const contexts = await readPerChain<null, readonly Context[]>(
      deployments,
      (chainId, { projectId }) => {
        const address =
          jbContractAddress['6'][JBCoreContracts.JBMultiTerminal]?.[chainId]
        return address
          ? {
              address,
              abi: jbMultiTerminalAbi,
              functionName: 'accountingContextsOf',
              args: [BigInt(projectId)],
            }
          : null
      },
    )
    const contextsOf = new Map(
      deployments.map((deployment, index) => [
        deploymentKey(deployment.chainId, deployment.projectId),
        contexts[index],
      ]),
    )

    const trusted: string[] = []
    const untrustedGroups: BalanceGroup[] = []
    for (const group of groups) {
      const keys = group.projects.items.map(project =>
        deploymentKey(project.chainId, project.projectId),
      )
      if (
        indexedAmountsTrusted(
          keys.map(key => contextsOf.get(key)?.length ?? null),
        ) === true
      )
        trusted.push(...keys)
      else untrustedGroups.push(group)
    }

    const balanceReads = untrustedGroups.flatMap(group =>
      group.projects.items.flatMap(project =>
        (contextsOf.get(deploymentKey(project.chainId, project.projectId)) ?? []).map(
          context => ({
            groupId: group.id,
            chainId: project.chainId,
            projectId: project.projectId,
            arg: context,
          }),
        ),
      ),
    )
    const balances = await readPerChain<Context, bigint>(
      balanceReads,
      (chainId, { projectId, arg }) => {
        const store =
          jbContractAddress['6'][JBCoreContracts.JBTerminalStore]?.[chainId]
        const terminal =
          jbContractAddress['6'][JBCoreContracts.JBMultiTerminal]?.[chainId]
        return store && terminal
          ? {
              address: store,
              abi: jbTerminalStoreAbi,
              functionName: 'balanceOf',
              args: [terminal, BigInt(projectId), arg.token],
            }
          : null
      },
    )
    const untrusted: Record<string, LiveBalance[]> = Object.fromEntries(
      untrustedGroups.map(group => [group.id, []]),
    )
    const usdc = Object.values(USDC_ADDRESSES).filter(Boolean) as Address[]
    balanceReads.forEach((read, index) => {
      const raw = balances[index]
      if (raw == null) return
      const rows = untrusted[read.groupId]
      let row = rows.find(item => item.chainId === read.chainId)
      if (!row) rows.push((row = { chainId: read.chainId, eth: 0, usdc: 0 }))
      const amount = Number(formatUnits(raw, read.arg.decimals))
      // ponytail: other tokens are left unvalued, as the reserves already do.
      if (isAddressEqual(read.arg.token, NATIVE_TOKEN)) row.eth += amount
      else if (usdc.some(token => isAddressEqual(token, read.arg.token)))
        row.usdc += amount
    })
    return { trusted, untrusted }
  },
  ['juicebox-home-indexed-trust-v1'],
  { revalidate: 600 },
)

export async function getHomepageEthPrice(): Promise<number | null> {
  try {
    return await cachedEthPrice()
  } catch {
    return null
  }
}

/**
 * A group's balance in USD, or null when it can't be stated. An untrusted
 * group is valued by its live balance instead of Bendystraw's raw total.
 */
function groupBalanceUsd(
  group: BalanceGroup,
  project: BsProject,
  ethPrice: number | null,
  trust: HomepageIndexedTrust,
): number | null {
  const live = trust.untrusted[group.id]
  if (live) {
    if (!live.length) return null
    const eth = live.reduce((sum, row) => sum + row.eth, 0)
    if (eth > 0 && ethPrice === null) return null
    return live.reduce((sum, row) => sum + row.usdc, eth * (ethPrice ?? 0))
  }
  if (project.decimals == null) return null
  const symbol = project.tokenSymbol?.toUpperCase()
  const balance = Number(formatUnits(BigInt(group.balance), project.decimals))
  if (symbol === 'USDC') return balance
  if (symbol === 'ETH' && ethPrice !== null) return balance * ethPrice
  return null
}

export async function getTopBalanceProjects(
  limit = 8,
  offset = 0,
): Promise<TopBalanceProject[]> {
  try {
    const [groups, ethPrice, trust] = await Promise.all([
      cachedBalanceGroups(),
      cachedEthPrice().catch(() => null),
      getHomepageIndexedTrust(),
    ])

    return groups
      .flatMap(group => {
        const project = group.projects.items.find(item => item.name) ?? group.projects.items[0]
        if (!project) return []
        const balanceUsd = groupBalanceUsd(group, project, ethPrice, trust)
        if (balanceUsd === null || !Number.isFinite(balanceUsd)) return []
        return [{
          key: group.id,
          href: `/${toUrn(project.chainId, project.projectId)}`,
          name: project.name ?? `Project ${project.projectId}`,
          tagline: project.projectTagline,
          logoUri: project.logoUri,
          balanceUsd,
        }]
      })
      .sort((a, b) => b.balanceUsd - a.balanceUsd)
      .slice(offset, offset + limit)
  } catch {
    return []
  }
}
