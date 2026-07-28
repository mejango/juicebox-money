import {
  JB_CHAINS,
  JBCoreContracts,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbProjectsAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { createPublicClient, http, zeroAddress, type Address } from 'viem'
import { getProject, type BsProject } from '@/lib/bendystraw'

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
}

const V6_ADDRESSES = jbContractAddress['6'] as Record<
  string,
  Record<number, Address | undefined>
>

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
  const client = createPublicClient({ chain, transport: http() })
  try {
    const owner = (await client.readContract({
      address: projects,
      abi: jbProjectsAbi,
      functionName: 'ownerOf',
      args: [BigInt(projectId)],
    })) as Address

    // Metadata is decorative here — a shell without a URI still renders.
    let metadataUri: string | null = null
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
        }
      } catch {
        metadataUri = null
      }
    }
    return { owner, metadataUri }
  } catch {
    // ownerOf reverted (no such project) or the RPC is unreachable.
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
 * The project page's data source. Indexed row when available; otherwise a
 * degraded on-chain shell (fresh launch or indexer outage); null only when
 * the project can't be found onchain either — the page's 404. Never throws.
 */
export async function getProjectPageData(
  chainId: number,
  projectId: number,
  deps: {
    getProject: typeof getProject
    readOnChainProject: typeof readOnChainProject
  } = { getProject, readOnChainProject },
): Promise<ProjectPageData | null> {
  let indexed: BsProject | null = null
  let indexerFailed = false
  try {
    indexed = await deps.getProject(chainId, projectId)
  } catch {
    indexerFailed = true
  }
  if (indexed) return { project: indexed, degraded: false }

  const shell = await deps
    .readOnChainProject(chainId, projectId)
    .catch(() => null)
  if (!shell) return null
  return {
    project: shellProject(chainId, projectId, shell),
    degraded: true,
    reason: indexerFailed ? 'indexer-error' : 'not-indexed',
  }
}
