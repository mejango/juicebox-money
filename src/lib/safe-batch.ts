import {
  JBBuybackHookContracts,
  JBRouterTerminalContracts,
  NATIVE_TOKEN,
  RevnetCoreContracts,
  jbBuybackHookAbi,
  jbBuybackHookRegistryAbi,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  jbRouterTerminalRegistryAbi,
  revOwnerAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  getAddress,
  isAddress,
  size,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { truncateAddress } from '@/lib/format'
import { POWERS, type PowerFlag, type ResolvedValues } from '@/lib/projectPowers'

/**
 * A Safe operator batch: several owner/operator actions queued per chain and
 * submitted once. This module is pure — it builds, orders, encodes and
 * persists steps; routing and wallets live in `safe-batch-submit.ts`.
 */

export type BatchStepKind =
  | 'setHookFor'
  | 'setPoolFor'
  | 'setTerminalFor'
  | 'setTwapWindowOf'
  | 'initializePoolFor'
  | 'setOperatorOf'
  | 'power'

type BatchStepValue =
  | string
  | number
  | boolean
  | bigint
  | readonly string[]
export type BatchStepValues = Record<string, BatchStepValue>

export type BatchStep = {
  id: string
  kind: BatchStepKind
  chainId: JBChainId
  projectId: number
  to: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  data: Hex
  value: 0n
  label: string
  contractName: string
  /** The chain-agnostic inputs the step was built from, so it can be rebuilt for another chain. */
  values: BatchStepValues
  /** Short human detail shown next to the label. */
  detail: string
  /** A caveat attached when the step was built (for example a defaulted TWAP window). */
  note?: string
}

export type BatchCall = { to: Address; data: Hex; value: bigint }

export type BatchProblem = { index: number; message: string }

type PowerTarget = 'controller' | 'directory' | 'terminal'

type StepTarget = {
  to: Address
  abi: Abi
  functionName: string
  contractName: string
}

type StepKindSpec = {
  kind: BatchStepKind
  label: string
  /** The name used for the per-chain address lookup, or where the target comes from. */
  contract:
    | 'JBBuybackHookRegistry'
    | 'JBRouterTerminalRegistry'
    | 'REVOwner'
    | 'values.hook'
    | 'values.target'
  /** True when the values are chain-specific and must be re-resolved before mirroring. */
  perChain?: boolean
  /** Validate and normalize raw values; throws on anything unusable. */
  parse: (values: BatchStepValues) => BatchStepValues
  target: (values: BatchStepValues, chainId: JBChainId) => StepTarget | null
  buildArgs: (values: BatchStepValues, projectId: bigint) => readonly unknown[]
  describe: (values: BatchStepValues) => string
  /** Extra key material for kinds where one contract hosts several independent actions. */
  discriminator?: (values: BatchStepValues, functionName: string) => string
}

const MAX_UINT24 = 0xff_ffffn
const MAX_INT24 = 0x7f_ffffn

function requireAddress(values: BatchStepValues, name: string): Address {
  const value = values[name]
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`Batch step is missing a valid ${name} address.`)
  }
  return getAddress(value)
}

function requireUint(
  values: BatchStepValues,
  name: string,
  max?: bigint,
): bigint {
  const value = values[name]
  let parsed: bigint
  try {
    parsed =
      typeof value === 'bigint'
        ? value
        : typeof value === 'number' && Number.isSafeInteger(value)
          ? BigInt(value)
          : typeof value === 'string' && /^\d+$/.test(value)
            ? BigInt(value)
            : (() => {
                throw new Error('not a whole number')
              })()
  } catch {
    throw new Error(`Batch step field ${name} must be a whole number.`)
  }
  if (parsed < 0n || (max !== undefined && parsed > max)) {
    throw new Error(`Batch step field ${name} is out of range.`)
  }
  return parsed
}

function requireInt24Positive(values: BatchStepValues, name: string): number {
  const parsed = requireUint(values, name, MAX_INT24)
  if (parsed < 1n) throw new Error(`Batch step field ${name} must be positive.`)
  return Number(parsed)
}

function addressBook(
  contract: string,
  chainId: JBChainId,
): Address | null {
  const deployments = (
    jbContractAddress['6'] as unknown as Record<
      string,
      Partial<Record<JBChainId, Address>> | undefined
    >
  )[contract]
  const address = deployments?.[chainId]
  return address ? getAddress(address) : null
}

function registryTarget(
  contract: 'JBBuybackHookRegistry' | 'JBRouterTerminalRegistry',
  chainId: JBChainId,
  abi: Abi,
  functionName: string,
): StepTarget | null {
  const to = addressBook(
    contract === 'JBBuybackHookRegistry'
      ? JBBuybackHookContracts.JBBuybackHookRegistry
      : JBRouterTerminalContracts.JBRouterTerminalRegistry,
    chainId,
  )
  return to ? { to, abi, functionName, contractName: contract } : null
}

function tokenLabel(token: string): string {
  return token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
    ? 'native'
    : truncateAddress(token)
}

function powerDescriptor(values: BatchStepValues) {
  const flag = values.flag
  const power = POWERS.find(candidate => candidate.flag === flag)
  if (!power) throw new Error('Batch step names an unknown owner power.')
  return power
}

function isPowerTarget(value: unknown): value is PowerTarget {
  return value === 'controller' || value === 'directory' || value === 'terminal'
}

/** The power's field values, validated the way the powers card validates them. */
function powerFieldValues(values: BatchStepValues): ResolvedValues {
  const power = powerDescriptor(values)
  const resolved: ResolvedValues = {}
  for (const field of power.fields) {
    if (field.kind === 'address') {
      resolved[field.name] = requireAddress(values, field.name)
    } else if (field.kind === 'addressList') {
      const list = values[field.name]
      if (
        !Array.isArray(list) ||
        !list.length ||
        list.some(entry => typeof entry !== 'string' || !isAddress(entry))
      ) {
        throw new Error(`Batch step field ${field.name} must list valid addresses.`)
      }
      resolved[field.name] = list.map(entry => getAddress(entry))
    } else if (field.kind === 'bool') {
      const value = values[field.name]
      if (typeof value !== 'boolean') {
        throw new Error(`Batch step field ${field.name} must be a boolean.`)
      }
      resolved[field.name] = value
    } else if (field.kind === 'decimals') {
      resolved[field.name] = Number(requireUint(values, field.name, 32n))
    } else {
      resolved[field.name] = requireUint(values, field.name)
    }
  }
  return resolved
}

export const STEP_KINDS: Record<BatchStepKind, StepKindSpec> = {
  setHookFor: {
    kind: 'setHookFor',
    label: 'Set buyback hook',
    contract: 'JBBuybackHookRegistry',
    parse: values => ({ hook: requireAddress(values, 'hook') }),
    target: (_values, chainId) =>
      registryTarget(
        'JBBuybackHookRegistry',
        chainId,
        jbBuybackHookRegistryAbi,
        'setHookFor',
      ),
    buildArgs: (values, projectId) => [projectId, requireAddress(values, 'hook')],
    describe: values => `hook ${truncateAddress(String(values.hook))}`,
  },
  setPoolFor: {
    kind: 'setPoolFor',
    label: 'Register buyback pool',
    contract: 'JBBuybackHookRegistry',
    perChain: true,
    parse: values => ({
      fee: Number(requireUint(values, 'fee', MAX_UINT24)),
      tickSpacing: requireInt24Positive(values, 'tickSpacing'),
      twapWindow: requireUint(values, 'twapWindow'),
      terminalToken: requireAddress(values, 'terminalToken'),
    }),
    target: (_values, chainId) =>
      registryTarget(
        'JBBuybackHookRegistry',
        chainId,
        jbBuybackHookRegistryAbi,
        'setPoolFor',
      ),
    buildArgs: (values, projectId) => [
      projectId,
      Number(requireUint(values, 'fee', MAX_UINT24)),
      requireInt24Positive(values, 'tickSpacing'),
      requireUint(values, 'twapWindow'),
      requireAddress(values, 'terminalToken'),
    ],
    describe: values =>
      `${tokenLabel(String(values.terminalToken))} pool | fee ${String(values.fee)} | spacing ${String(values.tickSpacing)} | TWAP ${String(values.twapWindow)}s`,
    discriminator: values => String(values.terminalToken).toLowerCase(),
  },
  setTerminalFor: {
    kind: 'setTerminalFor',
    label: 'Set router terminal',
    contract: 'JBRouterTerminalRegistry',
    parse: values => ({ terminal: requireAddress(values, 'terminal') }),
    target: (_values, chainId) =>
      registryTarget(
        'JBRouterTerminalRegistry',
        chainId,
        jbRouterTerminalRegistryAbi,
        'setTerminalFor',
      ),
    buildArgs: (values, projectId) => [
      projectId,
      requireAddress(values, 'terminal'),
    ],
    describe: values => `terminal ${truncateAddress(String(values.terminal))}`,
  },
  setTwapWindowOf: {
    kind: 'setTwapWindowOf',
    label: 'Set TWAP window',
    contract: 'values.hook',
    perChain: true,
    parse: values => ({
      hook: requireAddress(values, 'hook'),
      terminalToken: requireAddress(values, 'terminalToken'),
      twapWindow: requireUint(values, 'twapWindow'),
    }),
    target: values => ({
      to: requireAddress(values, 'hook'),
      abi: jbBuybackHookAbi,
      functionName: 'setTwapWindowOf',
      contractName: 'JBBuybackHook',
    }),
    buildArgs: (values, projectId) => [
      projectId,
      requireAddress(values, 'terminalToken'),
      requireUint(values, 'twapWindow'),
    ],
    describe: values =>
      `${tokenLabel(String(values.terminalToken))} pool | TWAP ${String(values.twapWindow)}s`,
    discriminator: values => String(values.terminalToken).toLowerCase(),
  },
  initializePoolFor: {
    kind: 'initializePoolFor',
    label: 'Initialize buyback pool',
    contract: 'JBBuybackHookRegistry',
    perChain: true,
    parse: values => ({
      fee: Number(requireUint(values, 'fee', MAX_UINT24)),
      tickSpacing: requireInt24Positive(values, 'tickSpacing'),
      twapWindow: requireUint(values, 'twapWindow'),
      pairToken: requireAddress(values, 'pairToken'),
      sqrtPriceX96: requireUint(values, 'sqrtPriceX96', 2n ** 160n - 1n),
    }),
    target: (_values, chainId) =>
      registryTarget(
        'JBBuybackHookRegistry',
        chainId,
        jbBuybackHookRegistryAbi,
        'initializePoolFor',
      ),
    buildArgs: (values, projectId) => [
      projectId,
      Number(requireUint(values, 'fee', MAX_UINT24)),
      requireInt24Positive(values, 'tickSpacing'),
      requireUint(values, 'twapWindow'),
      requireAddress(values, 'pairToken'),
      requireUint(values, 'sqrtPriceX96', 2n ** 160n - 1n),
    ],
    describe: values =>
      `${tokenLabel(String(values.pairToken))} pool | fee ${String(values.fee)} | spacing ${String(values.tickSpacing)} | TWAP ${String(values.twapWindow)}s | price ${String(values.sqrtPriceX96)}`,
    discriminator: values => String(values.pairToken).toLowerCase(),
  },
  setOperatorOf: {
    kind: 'setOperatorOf',
    label: 'Transfer operator',
    contract: 'REVOwner',
    parse: values => ({ operator: requireAddress(values, 'operator') }),
    target: (_values, chainId) => {
      const to = addressBook(RevnetCoreContracts.REVOwner, chainId)
      return to
        ? { to, abi: revOwnerAbi, functionName: 'setOperatorOf', contractName: 'REVOwner' }
        : null
    },
    buildArgs: (values, projectId) => [
      projectId,
      requireAddress(values, 'operator'),
    ],
    describe: values => `operator ${truncateAddress(String(values.operator))}`,
  },
  power: {
    kind: 'power',
    label: 'Owner power',
    contract: 'values.target',
    perChain: true,
    parse: values => {
      const power = powerDescriptor(values)
      if (!isPowerTarget(values.powerTarget) || values.powerTarget !== power.target) {
        throw new Error('Batch step names the wrong contract for this owner power.')
      }
      return {
        flag: power.flag,
        powerTarget: power.target,
        target: requireAddress(values, 'target'),
        ...powerFieldValues(values),
      }
    },
    target: values => {
      const power = powerDescriptor(values)
      return {
        to: requireAddress(values, 'target'),
        abi:
          power.target === 'controller'
            ? jbControllerAbi
            : power.target === 'directory'
              ? jbDirectoryAbi
              : jbMultiTerminalAbi,
        functionName: power.functionName,
        contractName:
          power.target === 'controller'
            ? 'JBController'
            : power.target === 'directory'
              ? 'JBDirectory'
              : 'JBMultiTerminal',
      }
    },
    buildArgs: (values, projectId) =>
      powerDescriptor(values).buildArgs(projectId, powerFieldValues(values)),
    describe: values => {
      const power = powerDescriptor(values)
      const parts = power.fields.map(field => {
        const value = values[field.name]
        const text = Array.isArray(value)
          ? value.map(entry => truncateAddress(String(entry))).join(', ')
          : typeof value === 'string' && isAddress(value)
            ? truncateAddress(value)
            : typeof value === 'boolean'
              ? value
                ? 'yes'
                : 'no'
              : String(value)
        return `${field.label} ${text}`
      })
      return parts.join(' | ')
    },
    discriminator: (_values, functionName) => functionName,
  },
}

/** The ruleset-gated owner powers, keyed the way `power` steps store them. */
export function powerStepValues(
  flag: PowerFlag,
  target: Address,
  fields: ResolvedValues,
): BatchStepValues {
  const power = POWERS.find(candidate => candidate.flag === flag)
  if (!power) throw new Error('Unknown owner power.')
  return { flag, powerTarget: power.target, target, ...fields }
}

/**
 * A step's identity inside one chain's tray: adding a step whose key already
 * exists replaces it in place. The key is `${kind}:${to}`, extended by the
 * pool token (a registry hosts one pool step per token) or, for the generic
 * owner-power kind, the function name.
 */
export function stepKey(
  step: Pick<BatchStep, 'kind' | 'to' | 'functionName' | 'values'>,
): string {
  const spec = STEP_KINDS[step.kind]
  const extra = spec.discriminator?.(step.values, step.functionName)
  return `${step.kind}:${step.to.toLowerCase()}${extra ? `:${extra}` : ''}`
}

export function buildStep({
  kind,
  chainId,
  projectId,
  values,
  note,
  label,
}: {
  kind: BatchStepKind
  chainId: JBChainId
  projectId: number
  values: BatchStepValues
  note?: string
  /** Overrides the kind's generic label (a power's own action label). */
  label?: string
}): BatchStep {
  const spec = STEP_KINDS[kind]
  if (!spec) throw new Error('Unknown batch step kind.')
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error('Batch step needs a project.')
  }
  const parsed = spec.parse(values)
  const target = spec.target(parsed, chainId)
  if (!target) {
    throw new Error(`${spec.label} is not available on chain ${chainId}.`)
  }
  const args = spec.buildArgs(parsed, BigInt(projectId))
  const data = encodeFunctionData({
    abi: target.abi,
    functionName: target.functionName,
    args,
  })
  const partial = {
    kind,
    to: target.to,
    functionName: target.functionName,
    values: parsed,
  }
  return {
    id: `${chainId}:${stepKey(partial)}`,
    kind,
    chainId,
    projectId,
    to: target.to,
    abi: target.abi,
    functionName: target.functionName,
    args,
    data,
    value: 0n,
    label:
      label ??
      (kind === 'power' ? powerDescriptor(parsed).actionLabel : spec.label),
    contractName: target.contractName,
    values: parsed,
    detail: spec.describe(parsed),
    ...(note ? { note } : {}),
  }
}

const DEPENDENCIES: readonly {
  kind: BatchStepKind
  after: BatchStepKind
  message: string
}[] = [
  {
    kind: 'setPoolFor',
    after: 'setHookFor',
    message:
      "Set the buyback hook before registering its pool. setPoolFor registers on the project's current hook.",
  },
]

/**
 * Dependency problems, applied only when BOTH kinds of a rule are present.
 * Never reorders: the dialog shows the message on the offending step.
 */
export function checkBatchOrder(steps: readonly BatchStep[]): {
  ok: boolean
  problems: BatchProblem[]
} {
  const problems: BatchProblem[] = []
  for (const rule of DEPENDENCIES) {
    const lastPrerequisite = steps.reduce(
      (last, step, index) => (step.kind === rule.after ? index : last),
      -1,
    )
    if (lastPrerequisite === -1) continue
    steps.forEach((step, index) => {
      if (step.kind === rule.kind && index < lastPrerequisite) {
        problems.push({ index, message: rule.message })
      }
    })
  }
  return { ok: problems.length === 0, problems }
}

/** True when an earlier step in the same batch must land before this one can succeed. */
export function dependsOnPrior(
  step: BatchStep,
  steps: readonly BatchStep[],
): boolean {
  return DEPENDENCIES.some(
    rule =>
      rule.kind === step.kind &&
      steps.some(other => other !== step && other.kind === rule.after),
  )
}

export function composeBatch(steps: readonly BatchStep[]): {
  calls: BatchCall[]
  problems: BatchProblem[]
} {
  return {
    calls: steps.map(step => ({ to: step.to, data: step.data, value: step.value })),
    problems: checkBatchOrder(steps).problems,
  }
}

export function upsertStep(
  steps: readonly BatchStep[],
  step: BatchStep,
): BatchStep[] {
  const key = stepKey(step)
  const index = steps.findIndex(existing => stepKey(existing) === key)
  if (index === -1) return [...steps, step]
  return steps.map((existing, position) => (position === index ? step : existing))
}

export function moveStep(
  steps: readonly BatchStep[],
  from: number,
  to: number,
): BatchStep[] {
  if (
    from < 0 ||
    from >= steps.length ||
    to < 0 ||
    to >= steps.length ||
    from === to
  ) {
    return [...steps]
  }
  const next = [...steps]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function removeStep(
  steps: readonly BatchStep[],
  index: number,
): BatchStep[] {
  return steps.filter((_, position) => position !== index)
}

export type MirrorResolution =
  | { values: BatchStepValues }
  | { skip: string }

/**
 * Rebuild each step for another chain of the same project. Chain-agnostic
 * kinds reuse their values with the target chain's contract address; kinds
 * marked `perChain` go through `resolve`, which re-reads the values on the
 * target chain or explains why the step cannot be mirrored.
 */
export async function mirrorBatch(
  steps: readonly BatchStep[],
  to: { chainId: JBChainId; projectId: number },
  resolve: (
    step: BatchStep,
    to: { chainId: JBChainId; projectId: number },
  ) => Promise<MirrorResolution>,
): Promise<{
  steps: BatchStep[]
  skipped: { step: BatchStep; reason: string }[]
}> {
  const mirrored: BatchStep[] = []
  const skipped: { step: BatchStep; reason: string }[] = []
  for (const step of steps) {
    const spec = STEP_KINDS[step.kind]
    let values = step.values
    if (spec.perChain) {
      const resolution = await resolve(step, to)
      if ('skip' in resolution) {
        skipped.push({ step, reason: resolution.skip })
        continue
      }
      values = resolution.values
    }
    try {
      mirrored.push(
        buildStep({
          kind: step.kind,
          chainId: to.chainId,
          projectId: to.projectId,
          values,
          note: step.note,
          label: step.label,
        }),
      )
    } catch (error) {
      skipped.push({
        step,
        reason: error instanceof Error ? error.message : 'Could not rebuild the step.',
      })
    }
  }
  return { steps: mirrored, skipped }
}

// ---------------------------------------------------------------------------
// MultiSend
// ---------------------------------------------------------------------------

/** Safe 1.3.0 canonical MultiSendCallOnly, same address on every supported chain. */
export const MULTI_SEND_CALL_ONLY =
  '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D' as Address

export const multiSendAbi = [
  {
    type: 'function',
    name: 'multiSend',
    stateMutability: 'payable',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
  },
] as const

/** Each call packed as `uint8 operation=0 ‖ address to ‖ uint256 value ‖ uint256 data.length ‖ bytes data`. */
export function packMultiSend(calls: readonly BatchCall[]): Hex {
  return `0x${calls
    .map(call =>
      encodePacked(
        ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
        [0, call.to, call.value, BigInt(size(call.data)), call.data],
      ).slice(2),
    )
    .join('')}`
}

export function encodeMultiSend(calls: readonly BatchCall[]): Hex {
  if (!calls.length) throw new Error('A batch needs at least one call.')
  return encodeFunctionData({
    abi: multiSendAbi,
    functionName: 'multiSend',
    args: [packMultiSend(calls)],
  })
}

/** The calls inside `multiSend` calldata, or null when it is not a plain CALL-only batch. */
export function decodeMultiSend(data: Hex | null | undefined): BatchCall[] | null {
  if (!data) return null
  let packed: Hex
  try {
    const decoded = decodeFunctionData({ abi: multiSendAbi, data })
    packed = decoded.args[0]
  } catch {
    return null
  }
  const bytes = packed.slice(2).toLowerCase()
  if (bytes.length % 2 !== 0) return null
  const calls: BatchCall[] = []
  let offset = 0
  while (offset < bytes.length) {
    // 1 + 20 + 32 + 32 bytes of header before the call data.
    if (bytes.length - offset < 170) return null
    const operation = bytes.slice(offset, offset + 2)
    if (operation !== '00') return null
    const to = `0x${bytes.slice(offset + 2, offset + 42)}`
    const value = BigInt(`0x${bytes.slice(offset + 42, offset + 106)}`)
    const length = Number(BigInt(`0x${bytes.slice(offset + 106, offset + 170)}`))
    const start = offset + 170
    const end = start + length * 2
    if (!Number.isSafeInteger(length) || end > bytes.length) return null
    if (!isAddress(to)) return null
    calls.push({ to: getAddress(to), value, data: `0x${bytes.slice(start, end)}` })
    offset = end
  }
  return calls.length ? calls : null
}

// ---------------------------------------------------------------------------
// Tray storage
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = 'jbm:safe-batch:v1:'
/** Same-tab change signal; other tabs hear the native `storage` event. */
const SAFE_BATCH_EVENT = 'jbm:safe-batch'

type StoredBatch = {
  version: 1
  steps: {
    kind: BatchStepKind
    values: BatchStepValues
    note?: string
    label?: string
  }[]
}

const encode = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? { $safeBatchBigInt: item.toString() } : item,
  )
const decode = <T,>(value: string): T =>
  JSON.parse(value, (_key, item) =>
    item &&
    typeof item === 'object' &&
    Object.keys(item).length === 1 &&
    typeof item.$safeBatchBigInt === 'string'
      ? BigInt(item.$safeBatchBigInt)
      : item,
  ) as T

export function safeBatchStorageKey(chainId: number, projectId: number): string {
  return `${STORAGE_PREFIX}${chainId}:${projectId}`
}

/** The persisted tray for one chain; empty on any parse or validation failure. */
export function readSafeBatch(chainId: JBChainId, projectId: number): BatchStep[] {
  try {
    const raw = window.localStorage.getItem(safeBatchStorageKey(chainId, projectId))
    if (!raw) return []
    const stored = decode<StoredBatch>(raw)
    if (stored.version !== 1 || !Array.isArray(stored.steps)) return []
    const steps: BatchStep[] = []
    for (const entry of stored.steps) {
      if (!entry || typeof entry !== 'object' || !(entry.kind in STEP_KINDS)) {
        return []
      }
      if (!entry.values || typeof entry.values !== 'object') return []
      steps.push(
        buildStep({
          kind: entry.kind,
          chainId,
          projectId,
          values: entry.values,
          note: typeof entry.note === 'string' ? entry.note : undefined,
          label: typeof entry.label === 'string' ? entry.label : undefined,
        }),
      )
    }
    return steps
  } catch {
    return []
  }
}

export function writeSafeBatch(
  chainId: JBChainId,
  projectId: number,
  steps: readonly BatchStep[],
): void {
  try {
    const key = safeBatchStorageKey(chainId, projectId)
    if (!steps.length) {
      window.localStorage.removeItem(key)
    } else {
      const stored: StoredBatch = {
        version: 1,
        steps: steps.map(step => ({
          kind: step.kind,
          values: step.values,
          ...(step.note ? { note: step.note } : {}),
          ...(step.label !== STEP_KINDS[step.kind].label ? { label: step.label } : {}),
        })),
      }
      window.localStorage.setItem(key, encode(stored))
    }
    window.dispatchEvent(new Event(SAFE_BATCH_EVENT))
  } catch {
    // Storage is a convenience; the in-memory tray keeps working.
  }
}

export function subscribeSafeBatch(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) listener()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(SAFE_BATCH_EVENT, listener)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(SAFE_BATCH_EVENT, listener)
  }
}
