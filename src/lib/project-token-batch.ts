'use client'

import {
  JBCoreContracts, RevnetCoreContracts, jbContractAddress, jbControllerAbi,
  jbDirectoryAbi, jbProjectsAbi, revOwnerAbi, type JBChainId,
} from '@bananapus/nana-sdk-core'
import { buildAutoIssueTx, buildClaimTokensTx, getAmountToAutoIssue, getCreditBalance, getTokenAddress } from '@bananapus/nana-sdk-core/v6'
import { encodeFunctionData, isAddress, isAddressEqual, type Address } from 'viem'
import { clientFor } from '@/lib/authority'
import { isKnownController } from '@/lib/manage'
import { tokenSymbol } from '@/lib/token-symbol'
import type { ProjectBatchCall } from '@/lib/project-batch'

export type ProjectTokenDestination = readonly [number, number]

type TokenContext = {
  controller: Address
  token: Address | null
  symbol: string
}

export type ClaimContext = TokenContext & {
  kind: 'claim-credits'
  holder: Address
  amount: string
}

export type AutoIssueContext = TokenContext & {
  kind: 'auto-issuance'
  owner: Address
  stageId: string
  stageStart: number
  beneficiary: Address
  amount: string
}

function sameAddress(a: Address | null, b: Address | null): boolean {
  return a === null || b === null ? a === b : isAddressEqual(a, b)
}

async function readTokenContext(chainId: JBChainId, projectId: number): Promise<TokenContext> {
  const client = clientFor(chainId)
  const [controller, token] = await Promise.all([
    client.readContract({ address: jbContractAddress['6'][JBCoreContracts.JBDirectory][chainId],
      abi: jbDirectoryAbi, functionName: 'controllerOf', args: [BigInt(projectId)] }),
    getTokenAddress(client, { chainId, projectId: BigInt(projectId) }),
  ])
  if (!isKnownController(chainId, controller)) throw new Error(`Project ${projectId} on chain ${chainId} uses an unsupported controller.`)
  return { controller, token, symbol: token ? await tokenSymbol(client, token, { chainId }) : 'credits' }
}

async function readClaimContext(chainId: JBChainId, projectId: number, holder: Address): Promise<ClaimContext> {
  const [token, amount] = await Promise.all([
    readTokenContext(chainId, projectId),
    getCreditBalance(clientFor(chainId), { chainId, projectId: BigInt(projectId), holder }),
  ])
  return { ...token, kind: 'claim-credits', holder, amount: amount.toString() }
}

export async function readClaimCalls(chains: readonly ProjectTokenDestination[], holder: Address): Promise<ProjectBatchCall[]> {
  const calls: ProjectBatchCall[] = []
  for (const [cid, projectId] of chains) {
    const chainId = cid as JBChainId
    const context = await readClaimContext(chainId, projectId, holder)
    if (!context.token || BigInt(context.amount) <= 0n) continue
    const request = buildClaimTokensTx({ chainId, projectId: BigInt(projectId), holder,
      tokenCount: BigInt(context.amount), beneficiary: holder })
    calls.push({ id: `claim:${chainId}:${projectId}:${holder.toLowerCase()}`, projectId,
      chainId, authority: holder, target: context.controller,
      data: encodeFunctionData(request), abi: jbControllerAbi, functionName: request.functionName,
      args: request.args, label: `Claim project ${projectId} credits`, contractName: 'JBController',
      gas: 500_000n, context })
  }
  if (!calls.length) throw new Error('No selected chain has claimable ERC-20 credits.')
  return calls
}

export async function reverifyClaimCall(call: ProjectBatchCall): Promise<void> {
  const frozen = call.context as ClaimContext
  if (frozen?.kind !== 'claim-credits' || !isAddress(frozen.holder) || !isAddressEqual(call.authority, frozen.holder)) {
    throw new Error('The saved claim holder is invalid.')
  }
  const live = await readClaimContext(call.chainId, call.projectId, frozen.holder)
  const request = buildClaimTokensTx({ chainId: call.chainId, projectId: BigInt(call.projectId),
    holder: frozen.holder, tokenCount: BigInt(frozen.amount), beneficiary: frozen.holder })
  if (!sameAddress(live.controller, frozen.controller) || !sameAddress(live.token, frozen.token) ||
      live.amount !== frozen.amount || live.symbol !== frozen.symbol ||
      !isAddressEqual(call.target, live.controller) || call.data !== encodeFunctionData(request)) {
    throw new Error('The original claim credits, controller, or token changed. Review the saved batch before continuing.')
  }
}

async function readAutoIssueContext(chainId: JBChainId, projectId: number, stageId: string, beneficiary: Address): Promise<AutoIssueContext> {
  const client = clientFor(chainId)
  const owner = jbContractAddress['6'][RevnetCoreContracts.REVOwner][chainId]
  const [token, projectOwner, issuanceController, amount, block] = await Promise.all([
    readTokenContext(chainId, projectId),
    client.readContract({ address: jbContractAddress['6'][JBCoreContracts.JBProjects][chainId], abi: jbProjectsAbi,
      functionName: 'ownerOf', args: [BigInt(projectId)] }),
    client.readContract({ address: owner, abi: revOwnerAbi, functionName: 'CONTROLLER' }),
    getAmountToAutoIssue(client, { chainId, revnetId: BigInt(projectId), stageId: BigInt(stageId), beneficiary }),
    client.getBlock({ blockTag: 'latest' }),
  ])
  if (!isAddressEqual(projectOwner, owner) || !isAddressEqual(token.controller, issuanceController)) {
    throw new Error('The revnet owner or issuance controller changed.')
  }
  const [ruleset] = await client.readContract({ address: issuanceController, abi: jbControllerAbi,
    functionName: 'getRulesetOf', args: [BigInt(projectId), BigInt(stageId)] })
  if (BigInt(ruleset.id) !== BigInt(stageId)) throw new Error('The auto-issuance stage could not be verified.')
  return { ...token, kind: 'auto-issuance', owner, stageId, stageStart: ruleset.start,
    beneficiary, amount: BigInt(ruleset.start) > block.timestamp ? '0' : amount.toString() }
}

function autoIssueCall(chainId: JBChainId, projectId: number, account: Address, context: AutoIssueContext): ProjectBatchCall {
  const request = buildAutoIssueTx({ chainId, revnetId: BigInt(projectId),
    stageId: BigInt(context.stageId), beneficiary: context.beneficiary })
  return { id: `auto:${chainId}:${projectId}:${context.stageId}:${context.beneficiary.toLowerCase()}`,
    projectId, chainId, authority: account, target: request.address,
    data: encodeFunctionData(request), abi: revOwnerAbi, functionName: request.functionName,
    args: request.args, label: `Auto-issue stage ${context.stageId} allocation`,
    contractName: 'REVOwner', gas: 700_000n, context }
}

/** A row has one known allocation; its live read and recovery alias match the aggregate flow. */
export async function readAutoIssueAllocationCall(
  chainId: JBChainId, projectId: number, stageId: string, beneficiary: Address, account: Address,
): Promise<ProjectBatchCall> {
  if (!/^\d+$/u.test(stageId) || !isAddress(beneficiary)) throw new Error('The auto-issuance allocation is invalid.')
  const context = await readAutoIssueContext(chainId, projectId, BigInt(stageId).toString(), beneficiary)
  if (BigInt(context.amount) <= 0n) throw new Error('Nothing left to distribute for this stage, or its allocation has not unlocked yet.')
  return autoIssueCall(chainId, projectId, account, context)
}

/** Indexer events enumerate candidates; every amount, stage unlock, and recipient is checked locally. */
export async function readAutoIssueCalls(chains: readonly ProjectTokenDestination[], account: Address): Promise<ProjectBatchCall[]> {
  const calls: ProjectBatchCall[] = []
  for (const [cid, projectId] of chains) {
    const chainId = cid as JBChainId
    const response = await fetch(`/api/auto-issuances?chainId=${chainId}&projectId=${projectId}`, { cache: 'no-store' })
    if (!response.ok) throw new Error('Could not read every selected chain’s auto-issuance allocations.')
    const body = await response.json() as { stored?: { stageId: string; beneficiary: string }[] }
    if (!Array.isArray(body.stored)) throw new Error('Auto-issuance allocation data is incomplete.')
    const seen = new Set<string>()
    for (const row of body.stored) {
      if (!/^\d+$/u.test(String(row.stageId)) || !isAddress(row.beneficiary)) throw new Error('An auto-issuance allocation is invalid.')
      const stageId = BigInt(row.stageId).toString()
      const key = `${stageId}:${row.beneficiary.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      const context = await readAutoIssueContext(chainId, projectId, stageId, row.beneficiary)
      if (BigInt(context.amount) <= 0n) continue
      calls.push(autoIssueCall(chainId, projectId, account, context))
    }
  }
  if (!calls.length) throw new Error('No unlocked auto-issuance allocations remain on the selected chains.')
  return calls
}

export async function reverifyAutoIssueCall(call: ProjectBatchCall): Promise<void> {
  const frozen = call.context as AutoIssueContext
  if (frozen?.kind !== 'auto-issuance' || !isAddress(frozen.beneficiary)) throw new Error('The saved auto-issuance allocation is invalid.')
  const live = await readAutoIssueContext(call.chainId, call.projectId, frozen.stageId, frozen.beneficiary)
  const request = buildAutoIssueTx({ chainId: call.chainId, revnetId: BigInt(call.projectId),
    stageId: BigInt(frozen.stageId), beneficiary: frozen.beneficiary })
  if (!sameAddress(live.controller, frozen.controller) || !sameAddress(live.token, frozen.token) ||
      !sameAddress(live.owner, frozen.owner) || live.stageStart !== frozen.stageStart ||
      live.amount !== frozen.amount || live.symbol !== frozen.symbol || BigInt(live.amount) <= 0n ||
      !isAddressEqual(call.target, request.address) || call.data !== encodeFunctionData(request)) {
    throw new Error('The original auto-issuance allocation, token, or controller changed. Resume the saved batch before continuing.')
  }
}
