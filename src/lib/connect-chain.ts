import {
  JBCoreContracts,
  JBOmnichainDeployerContracts,
  JBSuckerContracts,
  MappableAsset,
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jbProjectsAbi,
  jbSuckerRegistryAbi,
  jbV6ContractAddress,
  parseSuckerDeployerConfig,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { getAccountingContexts, getCurrentRuleset } from '@bananapus/nana-sdk-core/v6'
import type { Address, Hex, PublicClient } from 'viem'
import type { AuthorityCall } from '@/lib/authority'
import { PRODUCTION_CHAIN_IDS } from '@/lib/chainDisplay'
import { buildDeploySuckersAuthorityCall } from '@/lib/transaction-builders'
import { chainName } from '@/lib/urn'

const TESTNET_CHAIN_IDS = [11155111, 84532, 421614, 11155420] as const

type Member = { chainId: JBChainId; projectId: number; authority: Address | null; error?: string | null }

/** The chains a project could still connect to: its own environment, minus the ones it spans. */
export function connectChainCandidates(memberChainIds: readonly number[]): JBChainId[] {
  const environment: readonly number[] = memberChainIds.some(id => (TESTNET_CHAIN_IDS as readonly number[]).includes(id)) ? TESTNET_CHAIN_IDS : PRODUCTION_CHAIN_IDS
  return environment.filter(id => !memberChainIds.includes(id)) as JBChainId[]
}

const ASSET_NAMES: Record<MappableAsset, string> = { [MappableAsset.NATIVE]: 'ETH', [MappableAsset.USDC]: 'USDC' }
export function connectAssetNames(assets: readonly MappableAsset[]): string {
  return assets.map(asset => ASSET_NAMES[asset]).join(', ')
}

/**
 * One `JBSuckerRegistry.deploySuckersFor` per chain: the new chain deploys a sucker toward every
 * chain the project spans, and each of those deploys one toward the new chain.
 *
 * What the registry dictates: a sucker's address comes from the caller and the salt, and the two
 * ends of a pair find each other by having the same address. So one account sends every call,
 * with one salt, and it must own the project on the new chain too. Only tokens every chain
 * accepts are mapped: a claim adds the bridged token to the project's balance there.
 *
 * What the controller dictates: a sucker may create the tokens it bridges in only when the
 * ruleset's data hook says so, and only the omnichain deployer does (it also spares a sucker's
 * cash out the tax). A project whose rules run through anything else would take tokens in on
 * one chain and fail every claim on the other, so it is refused here.
 */
export async function planChainConnection({ members, targetChainId, targetProjectId, salt, clientFor }: {
  members: readonly Member[]
  targetChainId: JBChainId
  targetProjectId: bigint
  salt: Hex
  clientFor: (chainId: JBChainId) => PublicClient
}): Promise<{ calls: AuthorityCall[]; assets: MappableAsset[] }> {
  if (members.some(member => member.chainId === targetChainId)) throw new Error(`This project is already on ${chainName(targetChainId)}.`)
  const authority = members[0]?.authority
  if (!authority || members.some(member => member.error || member.authority?.toLowerCase() !== authority.toLowerCase())) {
    throw new Error('Connecting a chain needs the same owner account on every chain this project is on.')
  }
  const target = clientFor(targetChainId)
  const label = `Project #${targetProjectId} on ${chainName(targetChainId)}`
  const owner = await target
    .readContract({ address: jbV6ContractAddress[JBCoreContracts.JBProjects][targetChainId], abi: jbProjectsAbi, functionName: 'ownerOf', args: [targetProjectId] })
    .catch(() => { throw new Error(`${label} could not be found.`) })
  if (owner.toLowerCase() !== authority.toLowerCase()) throw new Error(`${label} is owned by another account. The same account must own the project on every chain.`)
  const registry = (chainId: JBChainId) => jbV6ContractAddress[JBSuckerContracts.JBSuckerRegistry][chainId] as Address
  const existing = await target.readContract({ address: registry(targetChainId), abi: jbSuckerRegistryAbi, functionName: 'suckersOf', args: [targetProjectId] })
  // ponytail: joining two existing groups is refused; add it when someone needs to merge groups.
  if (existing.length) throw new Error(`${label} is already connected to other chains.`)

  const every = [...members.map(member => ({ chainId: member.chainId, projectId: BigInt(member.projectId) })), { chainId: targetChainId, projectId: targetProjectId }]
  const accepted = await Promise.all(every.map(async ({ chainId, projectId }) => {
    const { metadata } = await getCurrentRuleset(clientFor(chainId), { chainId, projectId })
    const deployer = jbV6ContractAddress[JBOmnichainDeployerContracts.JBOmnichainDeployer][chainId]
    if (metadata.dataHook.toLowerCase() !== deployer?.toLowerCase() || !metadata.useDataHookForCashOut) {
      throw new Error(`Project #${projectId} on ${chainName(chainId)} cannot connect: its rules do not let moved tokens be created there. Only projects launched with linked chains can.`)
    }
    const contexts = await getAccountingContexts(clientFor(chainId), { chainId, projectId })
    return new Set(contexts.map(context => context.token.toLowerCase()))
  }))
  const assets = [MappableAsset.NATIVE, MappableAsset.USDC].filter(asset =>
    every.every(({ chainId }, index) => {
      const token = asset === MappableAsset.NATIVE ? NATIVE_TOKEN : USDC_ADDRESSES[chainId]
      return !!token && accepted[index].has(token.toLowerCase())
    }))
  if (!assets.length) throw new Error('These projects accept no token in common that can move between chains (ETH or USDC).')

  const memberChains = members.map(member => member.chainId)
  const calls = every.map(({ chainId, projectId }) => {
    const peers = chainId === targetChainId ? memberChains : [targetChainId]
    // ponytail: CCIP connects any pair and carries both assets; offer native bridges when asked.
    const { deployerConfigurations } = parseSuckerDeployerConfig(chainId, [chainId, ...peers], assets, { version: 6, bridge: 'ccip' })
    if (deployerConfigurations.length !== peers.length) throw new Error(`${chainName(chainId)} has no bridge to every chain in this connection.`)
    return buildDeploySuckersAuthorityCall({ chainId, authority, registry: registry(chainId), projectId, salt, configurations: deployerConfigurations })
  })
  return { calls, assets }
}
