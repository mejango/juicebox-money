import {
  JBBuybackHookContracts,
  JBRouterTerminalContracts,
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jbBuybackHookAbi,
  jbBuybackHookRegistryAbi,
  jbContractAddress,
  jbRouterTerminalRegistryAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import {
  buildStep,
  type BatchStep,
  type BatchStepKind,
  type MirrorResolution,
} from '@/lib/safe-batch'
import { chainName } from '@/lib/urn'

/**
 * Presets are data: a target hook/terminal pair and the step kinds that move
 * a project onto them. `resolvePreset` turns one into concrete steps for one
 * chain from live reads, skipping whatever is already applied.
 */
export type SafeBatchPreset = {
  id: string
  title: string
  description: string
  targets: { hook: Address; terminal: Address }
  steps: readonly BatchStepKind[]
}

export const SAFE_BATCH_PRESETS: readonly SafeBatchPreset[] = [
  {
    id: 'buyback-1-4-0-gateway',
    title: 'Move to buyback 1.4.0 + gateway',
    description:
      'Points the project at the current buyback hook and router gateway, carrying its live pool onto the new hook.',
    targets: {
      hook: '0xB222Da5A71e8FB89a5A38b7c920EaB5DfbC74B91',
      terminal: '0x4a56AEf5b6A5b9742AbB02cA67C5a85ba183D901',
    },
    steps: ['setHookFor', 'setPoolFor', 'setTerminalFor'],
  },
]

/** `JBBuybackHook._requireValidTwapWindow`: 5 minutes to 2 days. */
export const MIN_TWAP_WINDOW = 300n
/** `JBBuybackHook.MAX_TWAP_WINDOW`, also the deployer's default registration window. */
export const MAX_TWAP_WINDOW = 172_800n
/** The window stored when a pool is registered at exactly the maximum. */
const DEFAULT_TWAP_WINDOW = 1_800n
export const DEPLOYER_DEFAULT_TWAP_NOTE =
  'The old window was the deployer default (48h); 30 minutes will be stored.'

export type PresetChainResolution = {
  status: 'unavailable' | 'nothing' | 'ready'
  message: string | null
  steps: BatchStep[]
}

function registryAddress(
  contract: JBBuybackHookContracts | JBRouterTerminalContracts,
  chainId: JBChainId,
): Address | null {
  const deployments = jbContractAddress['6'][contract] as unknown as
    | Partial<Record<JBChainId, Address>>
    | undefined
  return deployments?.[chainId] ?? null
}

/** True when the chain has buyback/router infrastructure a preset can target. */
export function presetInfraAvailable(chainId: JBChainId): boolean {
  return (
    !!registryAddress(JBBuybackHookContracts.JBBuybackHookRegistry, chainId) &&
    !!registryAddress(JBRouterTerminalContracts.JBRouterTerminalRegistry, chainId)
  )
}

async function hasCode(client: PublicClient, address: Address): Promise<boolean> {
  const code = await client.getCode({ address })
  return !!code && code !== '0x'
}

/** Pools the hook reads under address(0) for native and the USDC address otherwise. */
function poolProbes(chainId: JBChainId): { read: Address; write: Address }[] {
  const probes: { read: Address; write: Address }[] = [
    { read: zeroAddress, write: NATIVE_TOKEN },
  ]
  const usdc = USDC_ADDRESSES[chainId]
  if (usdc) probes.push({ read: usdc, write: usdc })
  return probes
}

type PoolRead = {
  read: Address
  write: Address
  fee: number
  tickSpacing: number
  twapWindow: bigint
}

async function readPool(
  client: PublicClient,
  hook: Address,
  projectId: bigint,
  probe: { read: Address; write: Address },
): Promise<PoolRead | null> {
  const [key, twapWindow] = await Promise.all([
    client.readContract({
      address: hook,
      abi: jbBuybackHookAbi,
      functionName: 'poolKeyOf',
      args: [projectId, probe.read],
    }),
    client.readContract({
      address: hook,
      abi: jbBuybackHookAbi,
      functionName: 'twapWindowOf',
      args: [projectId, probe.read],
    }),
  ])
  if (twapWindow <= 0n) return null
  return {
    ...probe,
    fee: Number(key.fee),
    tickSpacing: Number(key.tickSpacing),
    twapWindow,
  }
}

/** The pool-registration values carried from an old hook; the max window is stored as 30 minutes. */
function carriedPoolValues(pool: PoolRead) {
  const defaulted = pool.twapWindow === MAX_TWAP_WINDOW
  return {
    values: {
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      twapWindow: defaulted ? DEFAULT_TWAP_WINDOW : pool.twapWindow,
      terminalToken: pool.write,
    },
    note: defaulted ? DEPLOYER_DEFAULT_TWAP_NOTE : undefined,
  }
}

export async function resolvePreset(
  preset: SafeBatchPreset,
  {
    chainId,
    projectId,
    client,
  }: { chainId: JBChainId; projectId: number; client: PublicClient },
): Promise<PresetChainResolution> {
  const name = chainName(chainId)
  const buybackRegistry = registryAddress(
    JBBuybackHookContracts.JBBuybackHookRegistry,
    chainId,
  )
  const routerRegistry = registryAddress(
    JBRouterTerminalContracts.JBRouterTerminalRegistry,
    chainId,
  )
  if (!buybackRegistry || !routerRegistry) {
    return {
      status: 'unavailable',
      message: `Not deployed on ${name} yet.`,
      steps: [],
    }
  }
  const [hookDeployed, terminalDeployed] = await Promise.all([
    hasCode(client, preset.targets.hook),
    hasCode(client, preset.targets.terminal),
  ])
  if (!hookDeployed || !terminalDeployed) {
    return {
      status: 'unavailable',
      message: `Not deployed on ${name} yet.`,
      steps: [],
    }
  }
  const pid = BigInt(projectId)
  const [currentHookRaw, currentTerminalRaw] = await Promise.all([
    client.readContract({
      address: buybackRegistry,
      abi: jbBuybackHookRegistryAbi,
      functionName: 'hookOf',
      args: [pid],
    }),
    client.readContract({
      address: routerRegistry,
      abi: jbRouterTerminalRegistryAbi,
      functionName: 'terminalOf',
      args: [pid],
    }),
  ])
  const currentHook = getAddress(currentHookRaw)
  const currentTerminal = getAddress(currentTerminalRaw)
  const steps: BatchStep[] = []

  if (
    preset.steps.includes('setHookFor') &&
    !isAddressEqual(currentHook, preset.targets.hook)
  ) {
    steps.push(
      buildStep({
        kind: 'setHookFor',
        chainId,
        projectId,
        values: { hook: preset.targets.hook },
      }),
    )
  }

  if (preset.steps.includes('setPoolFor') && !isAddressEqual(currentHook, zeroAddress)) {
    for (const probe of poolProbes(chainId)) {
      const pool = await readPool(client, currentHook, pid, probe)
      if (!pool) continue
      const carried = await client.readContract({
        address: preset.targets.hook,
        abi: jbBuybackHookAbi,
        functionName: 'twapWindowOf',
        args: [pid, probe.read],
      })
      // A second registration reverts with PoolAlreadySet.
      if (carried > 0n) continue
      const { values, note } = carriedPoolValues(pool)
      steps.push(buildStep({ kind: 'setPoolFor', chainId, projectId, values, note }))
    }
  }

  if (
    preset.steps.includes('setTerminalFor') &&
    !isAddressEqual(currentTerminal, preset.targets.terminal)
  ) {
    steps.push(
      buildStep({
        kind: 'setTerminalFor',
        chainId,
        projectId,
        values: { terminal: preset.targets.terminal },
      }),
    )
  }

  if (!steps.length) {
    return {
      status: 'nothing',
      message: `Nothing to do on ${name}: already on the current hook and gateway.`,
      steps: [],
    }
  }
  return { status: 'ready', message: null, steps }
}

/** The target chain's spelling of a step's terminal token: native stays native, USDC maps to that chain's USDC. */
function mirroredToken(
  token: string,
  fromChainId: JBChainId,
  toChainId: JBChainId,
): Address | null {
  if (token.toLowerCase() === NATIVE_TOKEN.toLowerCase()) return NATIVE_TOKEN
  const fromUsdc = USDC_ADDRESSES[fromChainId]
  const toUsdc = USDC_ADDRESSES[toChainId]
  if (fromUsdc && toUsdc && token.toLowerCase() === fromUsdc.toLowerCase()) {
    return toUsdc
  }
  return null
}

/**
 * Chain-specific values for mirroring one step onto another chain, re-read
 * there through the same preset reads. Steps whose inputs cannot be derived
 * on the target chain are skipped with the reason shown to the operator.
 */
export async function resolveMirrorValues(
  step: BatchStep,
  to: { chainId: JBChainId; projectId: number; client: PublicClient },
): Promise<MirrorResolution> {
  const name = chainName(to.chainId)
  const pid = BigInt(to.projectId)
  if (step.kind === 'setPoolFor' || step.kind === 'setTwapWindowOf') {
    const token = mirroredToken(String(step.values.terminalToken), step.chainId, to.chainId)
    if (!token) return { skip: `The pool token has no counterpart on ${name}.` }
    const registry = registryAddress(JBBuybackHookContracts.JBBuybackHookRegistry, to.chainId)
    if (!registry) return { skip: `No buyback registry on ${name}.` }
    const hook = getAddress(
      await to.client.readContract({
        address: registry,
        abi: jbBuybackHookRegistryAbi,
        functionName: 'hookOf',
        args: [pid],
      }),
    )
    if (isAddressEqual(hook, zeroAddress)) {
      return { skip: `No buyback hook is set on ${name}.` }
    }
    const read = token === NATIVE_TOKEN ? zeroAddress : token
    const pool = await readPool(to.client, hook, pid, { read, write: token })
    if (!pool) return { skip: `No matching pool on ${name}.` }
    if (step.kind === 'setTwapWindowOf') {
      return {
        values: { hook, terminalToken: token, twapWindow: step.values.twapWindow },
      }
    }
    const { values } = carriedPoolValues(pool)
    return { values: { ...values, twapWindow: step.values.twapWindow } }
  }
  if (step.kind === 'initializePoolFor') {
    return { skip: `The initial price is chain-specific. Add it on ${name} directly.` }
  }
  if (step.kind === 'power') {
    return { skip: `Owner powers take per-chain values. Add them on ${name} directly.` }
  }
  return { values: step.values }
}
