import {
  MULTICALL3,
  buildSafeInitializer,
  resolveSafeAddress,
  validateSafeDeploymentPlan,
  checkSafeDeployments,
  verifySafeDeployments,
  bundleSafeLaunch,
  unbundleSafeLaunch,
  verifySafeLaunchSimulation,
  type SafeDeploymentPlan,
} from '@bananapus/nana-sdk-core/safe'
import { encodePacked, getAddress, isAddressEqual, keccak256, type Address, type Hex, type PublicClient } from 'viem'
import type { LaunchPlan } from '@/lib/launch'
import type { RelayrEntry } from '@/lib/relayr'

function authorityPolicy(owners: string[], threshold: number) {
  if (!Array.isArray(owners) || owners.length < 2 || owners.length > 20) {
    throw new Error('Add 2–20 unique wallet addresses and choose an approval policy.')
  }
  // AddressField accepts mixed-case hex input. Normalize it before the SDK's
  // strict checksum validation, while preserving the signers' original order.
  const policy = { owners: owners.map(owner => getAddress(owner.trim())), threshold }
  buildSafeInitializer(policy)
  return policy
}

export function validateAuthorityPolicy(owners: string[], threshold: number): boolean {
  try { authorityPolicy(owners, threshold); return true } catch { return false }
}

/** Contract wallets, including delegated EOAs, use the direct setup path. */
export async function canRelayrCreateFromAccount(account: Address, clients: PublicClient[]): Promise<boolean> {
  if (!clients.length) return false
  const codes = await Promise.all(clients.map(client => client.getCode({ address: account })))
  return codes.every(code => !code || code === '0x')
}

async function requireCreationBatch(client: PublicClient): Promise<void> {
  const code = await client.getCode({ address: MULTICALL3 })
  if (!code || code === '0x') throw new Error('Safe creation is unavailable on this network.')
}

/** One deterministic Safe policy is frozen across the selected launch chains. */
export async function resolveLaunchMultisig({ owners, threshold, role, salt, clients }: {
  owners: string[]
  threshold: number
  role: 'owner' | 'operator'
  salt: Hex
  clients: PublicClient[]
}): Promise<SafeDeploymentPlan> {
  const policy = authorityPolicy(owners, threshold)
  await Promise.all(clients.map(requireCreationBatch))
  const result = await resolveSafeAddress({ kind: 'create', ...policy,
    saltNonce: keccak256(encodePacked(['bytes32', 'string'], [salt, role])),
  }, clients)
  return result.plan!
}

export function validateLaunchMultisigs(plan: LaunchPlan): void {
  if (plan.multisigs === undefined) return // Legacy launches have no Safe setup.
  if (!Array.isArray(plan.multisigs) || plan.multisigs.length > 1) {
    throw new Error('The saved launch has an invalid Safe deployment plan.')
  }
  for (const safe of plan.multisigs) {
    authorityPolicy(safe.owners, safe.threshold)
    validateSafeDeploymentPlan(safe)
    const authority = plan.flavor === 'revnet' ? plan.operator : plan.owner
    if (!authority || !isAddressEqual(safe.address, authority)) {
      throw new Error('The saved Safe does not match the launch authority.')
    }
  }
}

export async function checkLaunchMultisigs(client: PublicClient, plan: LaunchPlan): Promise<void> {
  validateLaunchMultisigs(plan)
  if (!plan.multisigs?.length) return
  await requireCreationBatch(client)
  await checkSafeDeployments(client, plan.multisigs)
}

export async function verifyCreatedLaunchMultisigs(client: PublicClient, plan: LaunchPlan, blockNumber?: bigint): Promise<void> {
  validateLaunchMultisigs(plan)
  await verifySafeDeployments(client, plan.multisigs ?? [], { blockNumber })
}

/** The inner call is already authenticated by the ERC-2771 forwarder. */
export function bundleLaunchMultisigs(entry: RelayrEntry, plan: LaunchPlan): RelayrEntry {
  validateLaunchMultisigs(plan)
  const call = bundleSafeLaunch({ to: entry.target, data: entry.data, value: BigInt(entry.value) }, plan.multisigs)
  return { ...entry, target: call.to, data: call.data }
}

export function unbundleLaunchMultisigs(entry: RelayrEntry, plan: LaunchPlan): RelayrEntry {
  validateLaunchMultisigs(plan)
  const call = unbundleSafeLaunch({ to: entry.target, data: entry.data, value: BigInt(entry.value) }, plan.multisigs)
  return { ...entry, target: call.to, data: call.data }
}

export async function verifyLaunchMultisigSimulation(client: PublicClient, plan: LaunchPlan, data?: Hex): Promise<void> {
  validateLaunchMultisigs(plan)
  await verifySafeLaunchSimulation(client, plan.multisigs, data)
}

export function launchMultisigReview(plan: LaunchPlan): string {
  return (plan.multisigs ?? []).map(safe =>
    `Create ${plan.flavor === 'revnet' ? 'Operator' : 'Owner'} Safe ${safe.address} with ${safe.threshold} of ${safe.owners.length} approvals. Signers: ${safe.owners.join(', ')}.`,
  ).join('\n')
}
