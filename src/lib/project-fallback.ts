import {
  JB_CHAINS,
  JBCoreContracts,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbPermissionsAbi,
  jbProjectsAbi,
  revOwnerAbi,
  RevnetCoreContracts,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  createPublicClient,
  getAbiItem,
  isAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { getProject, type BsProject } from '@/lib/bendystraw'
import { readMatchingAuthorityIdentities } from '@/lib/cross-chain-authority'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'

/**
 * Server-side resilience layer for the project page. Bendystraw is the
 * efficient primary, but it must never be a single point of failure: a
 * just-launched project has no row yet, and an indexer outage would
 * otherwise turn every project page into a 500. Both cases fall back to a
 * minimal on-chain identity read so the page can render a degraded shell
 * instead of crashing or 404ing a project that exists onchain.
 */

export type OnChainProjectShell = {
  owner: Address
  metadataUri: string | null
  /** Whether controllerOf + uriOf completed, including an intentionally empty URI. */
  metadataUriResolved: boolean
}

const V6_ADDRESSES = jbContractAddress['6'] as Record<
  string,
  Record<number, Address | undefined>
>

const JB_PERMISSIONS_DEPLOYMENT_BLOCK: Readonly<Record<number, bigint>> = {
  1: 25_327_931n,
  10: 152_994_030n,
  8453: 47_398_751n,
  42161: 473_987_853n,
  11155111: 11_070_525n,
  11155420: 44_892_020n,
  84532: 42_909_144n,
  421614: 277_723_887n,
}
const PERMISSION_LOG_CHUNK_BLOCKS = 50_000n
export const MAX_PERMISSION_HISTORY_LOGS = 256
export const MAX_PERMISSION_HISTORY_CANDIDATES = 50
export const MAX_PERMISSION_HISTORY_RPC_CALLS = 256
const PERMISSION_HISTORY_TIME_BUDGET_MS = 8_000
export const MAX_LIVE_REVNET_OPERATOR_CANDIDATES = 50
const operatorPermissionsSetEvent = getAbiItem({
  abi: jbPermissionsAbi,
  name: 'OperatorPermissionsSet',
})

/**
 * The smallest read that proves a project exists on a chain: JBProjects
 * ownerOf, plus a best-effort controllerOf + uriOf for metadata. Returns
 * null when the chain is unknown, the project NFT doesn't exist, or the
 * RPC read fails — the caller treats null as "not found on chain".
 */
export async function readOnChainProject(
  chainId: number,
  projectId: number,
): Promise<OnChainProjectShell | null> {
  const chain = JB_CHAINS[chainId as JBChainId]?.chain
  const projects = V6_ADDRESSES[JBCoreContracts.JBProjects]?.[chainId]
  const directory = V6_ADDRESSES[JBCoreContracts.JBDirectory]?.[chainId]
  if (!chain || !projects) return null
  const client = createPublicClient({
    chain,
    transport: jbCenterRpcTransport(chainId, 4_000),
  })
  try {
    const owner = (await client.readContract({
      address: projects,
      abi: jbProjectsAbi,
      functionName: 'ownerOf',
      args: [BigInt(projectId)],
    })) as Address

    // Metadata is decorative here — a shell without a URI still renders.
    let metadataUri: string | null = null
    let metadataUriResolved = false
    if (directory) {
      try {
        const controller = (await client.readContract({
          address: directory,
          abi: jbDirectoryAbi,
          functionName: 'controllerOf',
          args: [BigInt(projectId)],
        })) as Address
        if (controller !== zeroAddress) {
          const uri = (await client.readContract({
            address: controller,
            abi: jbControllerAbi,
            functionName: 'uriOf',
            args: [BigInt(projectId)],
          })) as string
          metadataUri = uri || null
          metadataUriResolved = true
        }
      } catch {
        metadataUri = null
      }
    }
    return { owner, metadataUri, metadataUriResolved }
  } catch {
    // ownerOf reverted (no such project) or the RPC is unreachable.
    return null
  }
}

/**
 * Uncached, fail-closed authority read for a handle trust decision. Custom
 * projects use the live JBProjects owner. Revnets use the indexer only to find
 * a candidate, then require the live REVOwner owner contract to confirm it.
 */
export async function readLiveProjectAuthority({
  chainId,
  projectId,
  revnetOperatorCandidate,
  revnetOperatorCandidates,
}: {
  chainId: number
  projectId: number
  revnetOperatorCandidate?: string | null
  revnetOperatorCandidates?: readonly string[]
}): Promise<Address | null> {
  return (
    await readLiveProjectAuthorityContext({
      chainId,
      projectId,
      revnetOperatorCandidate,
      revnetOperatorCandidates,
    })
  )?.authority ?? null
}

export type LiveProjectAuthorityContext = {
  authority: Address
  isRevnet: boolean
}

/** Live authority plus the NFT-owner-based revnet classification. */
export async function readLiveProjectAuthorityContext({
  chainId,
  projectId,
  revnetOperatorCandidate,
  revnetOperatorCandidates,
}: {
  chainId: number
  projectId: number
  revnetOperatorCandidate?: string | null
  revnetOperatorCandidates?: readonly string[]
}): Promise<LiveProjectAuthorityContext | null> {
  const chain = JB_CHAINS[chainId as JBChainId]?.chain
  const projects = V6_ADDRESSES[JBCoreContracts.JBProjects]?.[chainId]
  if (!chain || !projects) return null
  const client = createPublicClient({
    chain,
    transport: jbCenterRpcTransport(chainId, 4_000),
  })
  const canonicalRevOwner = V6_ADDRESSES[RevnetCoreContracts.REVOwner]?.[
    chainId
  ]
  if (!canonicalRevOwner) return null
  return liveProjectAuthorityContextFrom({
    client,
    projects,
    canonicalRevOwner,
    projectId,
    revnetOperatorCandidate,
    revnetOperatorCandidates,
  })
}

/**
 * A mainnet handle setter is trusted for an L2 authority only when control of
 * that address is chain-independent under the narrow supported policy.
 */
export async function projectAuthorityMatchesMainnet({
  chainId,
  authority,
}: {
  chainId: number
  authority: Address
}): Promise<boolean> {
  if (chainId === 1) return true
  const sourceChain = JB_CHAINS[chainId as JBChainId]?.chain
  const mainnetChain = JB_CHAINS[1]?.chain
  if (!sourceChain || !mainnetChain) return false
  const sourceClient = createPublicClient({
    chain: sourceChain,
    transport: jbCenterRpcTransport(chainId, 4_000),
  })
  const destinationClient = createPublicClient({
    chain: mainnetChain,
    transport: jbCenterRpcTransport(1, 4_000),
  })
  const identities = await readMatchingAuthorityIdentities({
    sourceClient,
    destinationClient,
    authority,
  })
  return identities?.matches ?? false
}

/**
 * Indexer-independent revnet operator discovery. Only REVOwner can mutate its
 * own JBPermissions account, so unlike JBProjectHandles caller events this
 * history cannot be permissionlessly flooded. Scan newest-first and stop once
 * an event candidate passes the canonical live `isOperatorOf` check.
 */
export async function revnetOperatorFromPermissionHistory({
  chainId,
  projectId,
}: {
  chainId: number
  projectId: number
}): Promise<Address | null> {
  const chain = JB_CHAINS[chainId as JBChainId]?.chain
  if (!chain) return null
  const client = createPublicClient({
    chain,
    transport: jbCenterRpcTransport(chainId, 4_000),
  })
  const canonicalRevOwner = V6_ADDRESSES[RevnetCoreContracts.REVOwner]?.[
    chainId
  ]
  const permissions = V6_ADDRESSES[JBCoreContracts.JBPermissions]?.[chainId]
  if (!canonicalRevOwner || !permissions) return null
  return revnetOperatorFromPermissionHistoryFrom({
    client,
    chainId,
    projectId,
    canonicalRevOwner,
    permissions,
  })
}

/** Dependency-injectable permission-history scanner used by route tests. */
export async function revnetOperatorFromPermissionHistoryFrom({
  client,
  chainId,
  projectId,
  canonicalRevOwner,
  permissions,
}: {
  client: PublicClient
  chainId: number
  projectId: number
  canonicalRevOwner: Address
  permissions: Address
}): Promise<Address | null> {
  const deploymentBlock = JB_PERMISSIONS_DEPLOYMENT_BLOCK[chainId]
  if (deploymentBlock === undefined) return null
  try {
    const latest = await client.getBlockNumber()
    if (latest < deploymentBlock) return null
    const seen = new Set<string>()
    let toBlock = latest
    let logReads = 0
    let logsProcessed = 0
    let candidatesChecked = 0
    const startedAt = Date.now()
    while (toBlock >= deploymentBlock) {
      if (
        logReads >= MAX_PERMISSION_HISTORY_RPC_CALLS ||
        Date.now() - startedAt > PERMISSION_HISTORY_TIME_BUDGET_MS
      ) {
        return null
      }
      const candidateFrom = toBlock - PERMISSION_LOG_CHUNK_BLOCKS + 1n
      const fromBlock =
        candidateFrom > deploymentBlock ? candidateFrom : deploymentBlock
      logReads += 1
      const logs = await client.getLogs({
        address: permissions,
        event: operatorPermissionsSetEvent,
        args: {
          account: canonicalRevOwner,
          projectId: BigInt(projectId),
        },
        fromBlock,
        toBlock,
        strict: true,
      })
      logsProcessed += logs.length
      if (logsProcessed > MAX_PERMISSION_HISTORY_LOGS) return null
      const candidates = [...logs].reverse().flatMap(log => {
        const operator = log.args.operator
        if (
          !operator ||
          !isAddress(operator) ||
          isAddressEqual(operator, zeroAddress)
        ) {
          return []
        }
        const key = operator.toLowerCase()
        if (seen.has(key)) return []
        seen.add(key)
        return [operator]
      })
      for (const candidate of candidates) {
        if (candidatesChecked >= MAX_PERMISSION_HISTORY_CANDIDATES) {
          return null
        }
        candidatesChecked += 1
        const live = await client.readContract({
          address: canonicalRevOwner,
          abi: revOwnerAbi,
          functionName: 'isOperatorOf',
          args: [BigInt(projectId), candidate],
        })
        // REVOwner maintains one replacement operator. Once the newest-first
        // history yields the current live address, older rows cannot produce
        // a second legitimate authority.
        if (live) return candidate
      }
      if (fromBlock === deploymentBlock) break
      toBlock = fromBlock - 1n
    }
    return null
  } catch {
    return null
  }
}

/** Dependency-injectable live authority policy used by route tests. */
export async function liveProjectAuthorityFrom({
  client,
  projects,
  canonicalRevOwner,
  projectId,
  revnetOperatorCandidate,
  revnetOperatorCandidates,
}: {
  client: PublicClient
  projects: Address
  canonicalRevOwner: Address
  projectId: number
  revnetOperatorCandidate?: string | null
  revnetOperatorCandidates?: readonly string[]
}): Promise<Address | null> {
  return (
    await liveProjectAuthorityContextFrom({
      client,
      projects,
      canonicalRevOwner,
      projectId,
      revnetOperatorCandidate,
      revnetOperatorCandidates,
    })
  )?.authority ?? null
}

export async function liveProjectAuthorityContextFrom({
  client,
  projects,
  canonicalRevOwner,
  projectId,
  revnetOperatorCandidate,
  revnetOperatorCandidates,
}: {
  client: PublicClient
  projects: Address
  canonicalRevOwner: Address
  projectId: number
  revnetOperatorCandidate?: string | null
  revnetOperatorCandidates?: readonly string[]
}): Promise<LiveProjectAuthorityContext | null> {
  try {
    const owner = (await client.readContract({
      address: projects,
      abi: jbProjectsAbi,
      functionName: 'ownerOf',
      args: [BigInt(projectId)],
    })) as Address
    if (!isAddressEqual(owner, canonicalRevOwner)) {
      return { authority: owner, isRevnet: false }
    }
    const seen = new Set<string>()
    const candidates: Address[] = []
    let overflow = false
    const addCandidate = (candidate: string) => {
      if (!isAddress(candidate) || isAddressEqual(candidate, zeroAddress)) {
        return
      }
      const key = candidate.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      if (candidates.length >= MAX_LIVE_REVNET_OPERATOR_CANDIDATES) {
        overflow = true
        return
      }
      candidates.push(candidate as Address)
    }
    for (const candidate of revnetOperatorCandidates ?? []) {
      addCandidate(candidate)
      if (overflow) return null
    }
    if (revnetOperatorCandidate) addCandidate(revnetOperatorCandidate)
    if (!candidates.length || overflow) return null
    for (const candidate of candidates) {
      const live = await client.readContract({
        address: canonicalRevOwner,
        abi: revOwnerAbi,
        functionName: 'isOperatorOf',
        args: [BigInt(projectId), candidate],
      })
      if (live) return { authority: candidate, isRevnet: true }
    }
    return null
  } catch {
    return null
  }
}

export type ProjectPageData =
  | { project: BsProject; degraded: false }
  | { project: BsProject; degraded: true; reason: 'not-indexed' | 'indexer-error' }

function shellProject(
  chainId: number,
  projectId: number,
  shell: OnChainProjectShell,
): BsProject {
  return {
    projectId,
    chainId,
    version: 6,
    name: null,
    logoUri: null,
    projectTagline: null,
    volume: '0',
    volumeUsd: '0',
    balance: '0',
    paymentsCount: 0,
    contributorsCount: 0,
    createdAt: 0,
    suckerGroupId: null,
    token: null,
    tokenSymbol: null,
    decimals: null,
    currency: null,
    isRevnet: null,
    owner: shell.owner,
    metadataUri: shell.metadataUri,
  }
}

/**
 * The project page's data source. Indexed financial/activity fields stay the
 * efficient primary, while identity and the controller's CURRENT metadata URI
 * are reconciled onchain so a recent name/logo edit does not wait for the
 * indexer. Falls back to a degraded on-chain shell for fresh projects or an
 * indexer outage; null only when the project can't be found either. Never
 * throws.
 */
export async function getProjectPageData(
  chainId: number,
  projectId: number,
  deps: {
    getProject: typeof getProject
    readOnChainProject: typeof readOnChainProject
  } = { getProject, readOnChainProject },
): Promise<ProjectPageData | null> {
  const [indexedResult, shell] = await Promise.all([
    deps
      .getProject(chainId, projectId)
      .then(project => ({ project, failed: false }))
      .catch(() => ({ project: null, failed: true })),
    deps.readOnChainProject(chainId, projectId).catch(() => null),
  ])
  const indexed = indexedResult.project
  if (indexed) {
    return {
      project: shell
        ? {
            ...indexed,
            owner: shell.owner,
            ...(shell.metadataUriResolved
              ? { metadataUri: shell.metadataUri }
              : {}),
          }
        : indexed,
      degraded: false,
    }
  }

  if (!shell) return null
  return {
    project: shellProject(chainId, projectId, shell),
    degraded: true,
    reason: indexedResult.failed ? 'indexer-error' : 'not-indexed',
  }
}
