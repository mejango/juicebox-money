import {
  JBBuybackHookContracts,
  JBRouterTerminalContracts,
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  jbBuybackHookAbi,
  jbBuybackHookRegistryAbi,
  jbV6ContractAddress,
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
  stepKey,
  type BatchStep,
  type BatchStepKind,
  type BatchStepRef,
  type BatchStepValues,
  type MirrorResolution,
} from '@/lib/safe-batch'
import { chainName } from '@/lib/urn'
import {
  migratedPoolKey,
  poolMove,
  poolSqrtPriceX96,
  poolTwapSqrtPriceX96,
  pricesAgree,
  type V4PoolKey,
} from '@/lib/buyback-pool-migration'
import { rolloutAddress, rolloutTargets } from '@/lib/protocol-rollout'

/**
 * Presets are data: a target hook/terminal pair and the step kinds that move
 * a project onto them. `resolvePreset` turns one into concrete steps for one
 * chain from live reads, skipping whatever is already applied.
 */
export type SafeBatchPreset = {
  id: string
  title: string
  description: string
  steps: readonly BatchStepKind[]
}

export const SAFE_BATCH_PRESETS: readonly SafeBatchPreset[] = [
  {
    id: 'buyback-2-0-0-gateway',
    title: 'Move to buyback 2.0.0 + gateway',
    description:
      "Points the project at the current buyback hook and router gateway, and opens its pool on the new hook at the old pool's price.",
    steps: ['setHookFor', 'setPoolFor', 'setTerminalFor'],
  },
]

/** `JBBuybackHook._requireValidTwapWindow`: 5 minutes to 2 days. */
export const MIN_TWAP_WINDOW = 300n
/** `JBBuybackHook.MAX_TWAP_WINDOW`, also the deployer's default registration window. */
export const MAX_TWAP_WINDOW = 172_800n
/**
 * The window every migrated pool is registered with, whatever the old hook held.
 * Must match revnet-money's preset: Safe co-signers on either client only meet on identical calldata.
 */
const PRESET_TWAP_WINDOW = 1_800n
/** "30 minutes" for 1800 seconds; seconds when not whole minutes. */
function windowLabel(seconds: bigint | number): string {
  const value = BigInt(seconds)
  return value % 60n === 0n ? `${value / 60n} minute${value === 60n ? '' : 's'}` : `${value}s`
}
export function deployerDefaultTwapNote(stored = PRESET_TWAP_WINDOW): string {
  return `The old window was the deployer default (48h); ${windowLabel(stored)} will be stored.`
}
export const DEPLOYER_DEFAULT_TWAP_NOTE = deployerDefaultTwapNote()
export function replacedTwapNote(window: bigint, stored = PRESET_TWAP_WINDOW): string {
  return `The old window was ${window}s; ${windowLabel(stored)} will be stored.`
}
const NEW_POOL_NOTE_START = "Starts at the old pool's average price over"
export function newPoolNote(observed: number): string {
  return `${NEW_POOL_NOTE_START} ${windowLabel(observed)} with no TWAP history; LPs move their own liquidity.`
}
/** An initialization note without its window note, for a step whose window was edited. */
export function newPoolNoteOf(note: string | undefined): string | undefined {
  const start = note?.indexOf(NEW_POOL_NOTE_START) ?? -1
  return start < 0 ? undefined : note!.slice(start)
}
export const NO_POOL_PRICE_NOTE = 'has no price to carry; set it up on the new hook directly.'
export const NO_POOL_HISTORY_NOTE = "pool: the old pool's price history can't be read; not carried."
export const NEW_POOL_PRICE_OFF_NOTE = 'pool: the new pool is priced more than 1% off the old one; not registered.'

export type PresetChainResolution = {
  status: 'unavailable' | 'nothing' | 'ready'
  message: string | null
  steps: BatchStep[]
  /** Queued pool registrations this resolution refuses, removed when it is added. */
  dropped?: BatchStepRef[]
}

function registryAddress(
  contract: JBBuybackHookContracts | JBRouterTerminalContracts,
  chainId: JBChainId,
): Address | null {
  const deployments = jbV6ContractAddress[contract] as unknown as
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

async function selectionAllowed(client: PublicClient, chainId: JBChainId, kind: 'hook' | 'terminal', target: Address): Promise<boolean> {
  const registry = registryAddress(kind === 'hook' ? JBBuybackHookContracts.JBBuybackHookRegistry : JBRouterTerminalContracts.JBRouterTerminalRegistry, chainId)
  if (!registry) return false
  // Read errors remain unknown and abort resolution instead of becoming permission.
  return kind === 'hook'
    ? client.readContract({ address: registry, abi: jbBuybackHookRegistryAbi, functionName: 'isHookAllowed', args: [target] })
    : client.readContract({ address: registry, abi: jbRouterTerminalRegistryAbi, functionName: 'isTerminalAllowed', args: [target] })
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

/** The pool-registration values carried from an old hook, with the window reset to 30 minutes. */
function carriedPoolValues(pool: PoolRead) {
  const twapWindow = PRESET_TWAP_WINDOW
  return {
    values: {
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      twapWindow,
      terminalToken: pool.write,
    },
    note:
      pool.twapWindow === MAX_TWAP_WINDOW
        ? deployerDefaultTwapNote(twapWindow)
        : pool.twapWindow !== twapWindow
          ? replacedTwapNote(pool.twapWindow, twapWindow)
          : undefined,
  }
}

type PoolStep =
  | { kind: 'setPoolFor' | 'initializePoolFor'; values: BatchStepValues; note?: string }
  | { kind: 'skip'; note?: string }

/**
 * One terminal token's pool carried onto the target hook, from this chain's own state: an existing
 * new pool is registered only when it trades within 1% of the old pool's TWAP, otherwise the pool
 * opens at that TWAP. Null when the old hook has no pool for the token. Mirrors revnet-money's
 * `poolStepOn`.
 */
async function poolStepOn(
  client: PublicClient,
  chainId: JBChainId,
  pid: bigint,
  currentHook: Address,
  targetHook: Address,
  poolHook: Address,
  probe: { read: Address; write: Address },
): Promise<PoolStep | null> {
  const pool = await readPool(client, currentHook, pid, probe)
  if (!pool) return null
  const carried = await client.readContract({
    address: targetHook,
    abi: jbBuybackHookAbi,
    functionName: 'twapWindowOf',
    args: [pid, probe.read],
  })
  // A second registration reverts with PoolAlreadySet.
  if (carried > 0n) return { kind: 'skip' }
  const oldKey = (await client.readContract({
    address: currentHook,
    abi: jbBuybackHookAbi,
    functionName: 'poolKeyOf',
    args: [pid, probe.read],
  })) as V4PoolKey
  const newKey = migratedPoolKey(oldKey, poolHook)
  const [reference, newPrice] = await Promise.all([
    poolTwapSqrtPriceX96(client, chainId, oldKey, Number(PRESET_TWAP_WINDOW)),
    poolSqrtPriceX96(client, chainId, newKey),
  ])
  const label = probe.read === zeroAddress ? 'Native' : 'USDC'
  if (!reference) return { kind: 'skip', note: `${label} ${NO_POOL_HISTORY_NOTE}` }
  const move = poolMove(reference.sqrtPriceX96, newPrice)
  if (move.kind === 'none') return { kind: 'skip', note: `${label} pool ${NO_POOL_PRICE_NOTE}` }
  if (move.kind === 'setPoolFor' && !pricesAgree(newPrice, reference.sqrtPriceX96)) {
    return { kind: 'skip', note: `${label} ${NEW_POOL_PRICE_OFF_NOTE}` }
  }
  const carriedValues = carriedPoolValues(pool)
  if (move.kind === 'setPoolFor') return { kind: 'setPoolFor', ...carriedValues }
  return {
    kind: 'initializePoolFor',
    values: {
      fee: carriedValues.values.fee,
      tickSpacing: carriedValues.values.tickSpacing,
      twapWindow: carriedValues.values.twapWindow,
      pairToken: carriedValues.values.terminalToken,
      sqrtPriceX96: move.sqrtPriceX96,
    },
    note: [carriedValues.note, newPoolNote(reference.window)].filter(Boolean).join(' '),
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
  const targets = rolloutTargets(chainId)
  const buybackRegistry = registryAddress(
    JBBuybackHookContracts.JBBuybackHookRegistry,
    chainId,
  )
  const routerRegistry = registryAddress(
    JBRouterTerminalContracts.JBRouterTerminalRegistry,
    chainId,
  )
  if (!targets || !buybackRegistry || !routerRegistry) {
    return {
      status: 'unavailable',
      message: `Not deployed on ${name} yet.`,
      steps: [],
    }
  }
  const [hookDeployed, terminalDeployed] = await Promise.all([
    hasCode(client, targets.hook),
    hasCode(client, targets.terminal),
  ])
  if (!hookDeployed || !terminalDeployed) {
    return {
      status: 'unavailable',
      message: `Not deployed on ${name} yet.`,
      steps: [],
    }
  }
  const allowed = await Promise.all([
    selectionAllowed(client, chainId, 'hook', targets.hook),
    selectionAllowed(client, chainId, 'terminal', targets.terminal),
  ])
  if (allowed.some(value => !value)) {
    return { status: 'unavailable', message: `The current hook or gateway is not allowed by the registries on ${name}.`, steps: [] }
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
    !isAddressEqual(currentHook, targets.hook)
  ) {
    steps.push(
      buildStep({
        kind: 'setHookFor',
        chainId,
        projectId,
        values: { hook: targets.hook },
      }),
    )
  }

  const poolNotes: string[] = []
  const dropped: BatchStepRef[] = []
  if (preset.steps.includes('setPoolFor') && !isAddressEqual(currentHook, zeroAddress)) {
    const poolHook = rolloutAddress('JBUniswapV4Hook', chainId)
    for (const probe of poolProbes(chainId)) {
      if (!poolHook) {
        if (!(await readPool(client, currentHook, pid, probe))) continue
        return { status: 'unavailable', message: `The current V4 hook is not recorded on ${name}.`, steps: [] }
      }
      const pool = await poolStepOn(client, chainId, pid, currentHook, targets.hook, poolHook, probe)
      if (!pool) continue
      if (pool.kind === 'skip') {
        if (pool.note) poolNotes.push(pool.note)
        const key = { kind: 'setPoolFor' as const, to: buybackRegistry, functionName: 'setPoolFor', values: { terminalToken: probe.write } }
        dropped.push({ chainId, projectId, id: `${chainId}:${stepKey(key)}` })
        continue
      }
      steps.push(buildStep({ kind: pool.kind, chainId, projectId, values: pool.values, note: pool.note }))
    }
  }

  if (
    preset.steps.includes('setTerminalFor') &&
    !isAddressEqual(currentTerminal, targets.terminal)
  ) {
    steps.push(
      buildStep({
        kind: 'setTerminalFor',
        chainId,
        projectId,
        values: { terminal: targets.terminal },
      }),
    )
  }

  if (!steps.length) {
    return {
      status: 'nothing',
      message: poolNotes.join(' ') || `Nothing to do on ${name}: already on the current hook and gateway.`,
      steps: [],
    }
  }
  return { status: 'ready', message: poolNotes.join(' ') || null, steps, dropped }
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

/** Shared with revnet-money: a migration step is never mirrored. */
export const MIGRATION_MIRROR_LINE = `Use the "${SAFE_BATCH_PRESETS[0].title}" preset; it resolves every chain at once.`

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
  const sourceTargets = rolloutTargets(step.chainId)
  if (step.kind === 'setHookFor' || step.kind === 'setTerminalFor') {
    const key = step.kind === 'setHookFor' ? 'hook' : 'terminal'
    // The move to the rollout targets is resolved per chain by its preset, never copied; the pool
    // registrations after this selection are dropped with it.
    if (sourceTargets && String(step.values[key]).toLowerCase() === sourceTargets[key].toLowerCase()) {
      return { skip: MIGRATION_MIRROR_LINE }
    }
    return { skip: `Choose the ${key} on ${name} directly; this selection has no verified counterpart.` }
  }
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
