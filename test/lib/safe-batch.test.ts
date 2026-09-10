import { jbBuybackHookRegistryAbi } from '@bananapus/nana-sdk-core'
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildStep,
  checkBatchOrder,
  composeBatch,
  decodeMultiSend,
  dependsOnPrior,
  encodeMultiSend,
  mirrorBatch,
  moveStep,
  MULTI_SEND_CALL_ONLY,
  multiSendAbi,
  packMultiSend,
  powerStepValues,
  readSafeBatch,
  removeStep,
  safeBatchStorageKey,
  STEP_KINDS,
  stepKey,
  upsertStep,
  writeSafeBatch,
  type BatchStep,
} from '@/lib/safe-batch'

const REGISTRY = '0x72F55a54CD53410a5Ff175508a5A384227081788' as Address
const ROUTER_REGISTRY = '0xe0427F250fdb0379c8E98e884Ee4570521208CbC' as Address
const HOOK = '0xB222Da5A71e8FB89a5A38b7c920EaB5DfbC74B91' as Address
const TERMINAL = '0x4a56AEf5b6A5b9742AbB02cA67C5a85ba183D901' as Address
const NATIVE = '0x000000000000000000000000000000000000EEEe' as Address
const CONTROLLER = '0x6666666666666666666666666666666666666666' as Address
const ALICE = '0x1111111111111111111111111111111111111111' as Address

const SET_HOOK_DATA =
  '0x779b02900000000000000000000000000000000000000000000000000000000000000002000000000000000000000000b222da5a71e8fb89a5a38b7c920eab5dfbc74b91'
const SET_POOL_DATA =
  '0x345c42130000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000000000c80000000000000000000000000000000000000000000000000000000000000708000000000000000000000000000000000000000000000000000000000000eeee'
const SET_TERMINAL_DATA =
  '0xf3e37d0100000000000000000000000000000000000000000000000000000000000000020000000000000000000000004a56aef5b6a5b9742abb02ca67c5a85ba183d901'

function hookStep(chainId: 1 | 8453 = 1): BatchStep {
  return buildStep({ kind: 'setHookFor', chainId, projectId: 2, values: { hook: HOOK } })
}
function poolStep(chainId: 1 | 8453 = 1): BatchStep {
  return buildStep({
    kind: 'setPoolFor',
    chainId,
    projectId: 2,
    values: { fee: 10_000, tickSpacing: 200, twapWindow: 1800n, terminalToken: NATIVE },
  })
}
function terminalStep(chainId: 1 | 8453 = 1): BatchStep {
  return buildStep({
    kind: 'setTerminalFor',
    chainId,
    projectId: 2,
    values: { terminal: TERMINAL },
  })
}

describe('Safe batch steps', () => {
  it('builds the three preset calls byte-for-byte against the reference calldata', () => {
    const hook = hookStep()
    const pool = poolStep()
    const terminal = terminalStep()
    expect(hook).toMatchObject({
      to: REGISTRY,
      functionName: 'setHookFor',
      contractName: 'JBBuybackHookRegistry',
      data: SET_HOOK_DATA,
      value: 0n,
      label: 'Set buyback hook',
    })
    expect(pool).toMatchObject({
      to: REGISTRY,
      functionName: 'setPoolFor',
      data: SET_POOL_DATA,
      args: [2n, 10_000, 200, 1800n, NATIVE],
      label: 'Register buyback pool',
    })
    expect(terminal).toMatchObject({
      to: ROUTER_REGISTRY,
      functionName: 'setTerminalFor',
      data: SET_TERMINAL_DATA,
    })
    expect(decodeFunctionData({ abi: pool.abi, data: pool.data })).toEqual({
      functionName: 'setPoolFor',
      args: [2n, 10_000, 200, 1800n, NATIVE],
    })
    expect(pool.detail).toContain('native pool')
    expect(pool.detail).toContain('TWAP 1800s')
  })

  it('rejects unusable values instead of encoding them', () => {
    expect(() =>
      buildStep({ kind: 'setHookFor', chainId: 1, projectId: 2, values: { hook: 'nope' } }),
    ).toThrow(/hook address/)
    expect(() =>
      buildStep({
        kind: 'setPoolFor',
        chainId: 1,
        projectId: 2,
        values: { fee: 2 ** 24, tickSpacing: 200, twapWindow: 1800n, terminalToken: NATIVE },
      }),
    ).toThrow(/fee/)
    expect(() =>
      buildStep({
        kind: 'setPoolFor',
        chainId: 1,
        projectId: 2,
        values: { fee: 1, tickSpacing: 0, twapWindow: 1800n, terminalToken: NATIVE },
      }),
    ).toThrow(/tickSpacing/)
    expect(() =>
      buildStep({ kind: 'setHookFor', chainId: 1, projectId: 0, values: { hook: HOOK } }),
    ).toThrow(/project/)
  })

  it('wraps an owner power with its own descriptor, target and label', () => {
    const step = buildStep({
      kind: 'power',
      chainId: 1,
      projectId: 7,
      values: powerStepValues('allowOwnerMinting', CONTROLLER, {
        tokenCount: 5n * 10n ** 18n,
        beneficiary: ALICE,
        useReservedPercent: false,
      }),
      label: 'Mint tokens',
    })
    expect(step).toMatchObject({
      to: CONTROLLER,
      functionName: 'mintTokensOf',
      contractName: 'JBController',
      args: [7n, 5n * 10n ** 18n, ALICE, '', false],
      label: 'Mint tokens',
    })
    expect(step.detail).toContain('Recipient 0x1111…1111')
    expect(() =>
      buildStep({
        kind: 'power',
        chainId: 1,
        projectId: 7,
        values: { ...powerStepValues('allowOwnerMinting', CONTROLLER, {}), powerTarget: 'directory' },
      }),
    ).toThrow(/wrong contract/)
  })

  it('keys steps by kind and target, extended by pool token or power function', () => {
    expect(stepKey(hookStep())).toBe(`setHookFor:${REGISTRY.toLowerCase()}`)
    expect(stepKey(poolStep())).toBe(
      `setPoolFor:${REGISTRY.toLowerCase()}:${NATIVE.toLowerCase()}`,
    )
    const mint = buildStep({
      kind: 'power',
      chainId: 1,
      projectId: 7,
      values: powerStepValues('allowOwnerMinting', CONTROLLER, {
        tokenCount: 1n,
        beneficiary: ALICE,
        useReservedPercent: false,
      }),
    })
    expect(stepKey(mint)).toBe(`power:${CONTROLLER.toLowerCase()}:mintTokensOf`)
    expect(Object.keys(STEP_KINDS)).toEqual([
      'setHookFor',
      'setPoolFor',
      'setTerminalFor',
      'setTwapWindowOf',
      'initializePoolFor',
      'setOperatorOf',
      'power',
    ])
  })

  it('upserts by key, replacing in place, and moves or removes by index', () => {
    const other = buildStep({
      kind: 'setHookFor',
      chainId: 1,
      projectId: 2,
      values: { hook: TERMINAL },
    })
    const initial = [hookStep(), terminalStep()]
    const replaced = upsertStep(initial, other)
    expect(replaced).toHaveLength(2)
    expect(replaced[0].values.hook).toBe(TERMINAL)
    expect(replaced[1]).toBe(initial[1])
    const appended = upsertStep(initial, poolStep())
    expect(appended.map(step => step.kind)).toEqual([
      'setHookFor',
      'setTerminalFor',
      'setPoolFor',
    ])
    expect(moveStep(appended, 2, 1).map(step => step.kind)).toEqual([
      'setHookFor',
      'setPoolFor',
      'setTerminalFor',
    ])
    expect(moveStep(appended, 0, 5)).toEqual(appended)
    expect(removeStep(appended, 1).map(step => step.kind)).toEqual([
      'setHookFor',
      'setPoolFor',
    ])
  })
})

describe('Safe batch ordering', () => {
  it('flags setPoolFor ahead of setHookFor only when both are present', () => {
    const wrong = [poolStep(), hookStep(), terminalStep()]
    expect(checkBatchOrder(wrong)).toEqual({
      ok: false,
      problems: [{ index: 0, message: expect.stringMatching(/Set the buyback hook before/) }],
    })
    expect(checkBatchOrder([poolStep(), terminalStep()])).toEqual({ ok: true, problems: [] })
    expect(checkBatchOrder([hookStep(), terminalStep()])).toEqual({ ok: true, problems: [] })
    expect(checkBatchOrder(moveStep(wrong, 0, 1)).ok).toBe(true)
    expect(composeBatch(wrong).problems).toHaveLength(1)
    expect(composeBatch(wrong).calls).toEqual([
      { to: REGISTRY, data: SET_POOL_DATA, value: 0n },
      { to: REGISTRY, data: SET_HOOK_DATA, value: 0n },
      { to: ROUTER_REGISTRY, data: SET_TERMINAL_DATA, value: 0n },
    ])
    expect(dependsOnPrior(wrong[0], wrong)).toBe(true)
    expect(dependsOnPrior(wrong[0], [wrong[0]])).toBe(false)
    expect(dependsOnPrior(wrong[1], wrong)).toBe(false)
  })
})

describe('MultiSend encoding', () => {
  it('packs op byte, address, value, length and data, and round-trips', () => {
    const calls = composeBatch([hookStep(), poolStep(), terminalStep()]).calls
    const packed = packMultiSend(calls)
    const encoded = encodeMultiSend(calls)
    expect(encoded.slice(0, 10)).toBe('0x8d80ff0a')
    expect(MULTI_SEND_CALL_ONLY).toBe('0x40A2aCCbd92BCA938b02010E17A5b8929b49130D')
    expect(decodeFunctionData({ abi: multiSendAbi, data: encoded })).toEqual({
      functionName: 'multiSend',
      args: [packed],
    })
    expect(
      encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend', args: [packed] }),
    ).toBe(encoded)

    // Layout of the first packed transaction.
    const body = packed.slice(2)
    const hookLength = (SET_HOOK_DATA.length - 2) / 2
    expect(body.slice(0, 2)).toBe('00')
    expect(body.slice(2, 42)).toBe(REGISTRY.slice(2).toLowerCase())
    expect(body.slice(42, 106)).toBe('0'.repeat(64))
    expect(body.slice(106, 170)).toBe(hookLength.toString(16).padStart(64, '0'))
    expect(body.slice(170, 170 + hookLength * 2)).toBe(SET_HOOK_DATA.slice(2))
    const first = 170 + hookLength * 2
    expect(body.slice(first, first + 2)).toBe('00')
    expect(body.slice(first + 2, first + 42)).toBe(REGISTRY.slice(2).toLowerCase())
    expect(body.length).toBe(
      3 * 170 + hookLength * 2 + (SET_POOL_DATA.length - 2) + (SET_TERMINAL_DATA.length - 2),
    )

    expect(decodeMultiSend(encoded)).toEqual(calls)
  })

  it('refuses delegatecall entries, truncated bodies and foreign selectors', () => {
    const calls = composeBatch([hookStep()]).calls
    const encoded = encodeMultiSend(calls)
    const packed = packMultiSend(calls)
    const delegate = encodeFunctionData({
      abi: multiSendAbi,
      functionName: 'multiSend',
      args: [`0x01${packed.slice(4)}` as Hex],
    })
    expect(decodeMultiSend(delegate)).toBeNull()
    const truncated = encodeFunctionData({
      abi: multiSendAbi,
      functionName: 'multiSend',
      args: [packed.slice(0, -8) as Hex],
    })
    expect(decodeMultiSend(truncated)).toBeNull()
    expect(decodeMultiSend(SET_HOOK_DATA)).toBeNull()
    expect(decodeMultiSend(null)).toBeNull()
    expect(decodeMultiSend(encoded)).toHaveLength(1)
    expect(() => encodeMultiSend([])).toThrow(/at least one/)
  })
})

describe('Safe batch mirroring', () => {
  it('re-resolves per-chain kinds through the callback and keeps chain-agnostic values', async () => {
    const resolve = vi.fn(async (step: BatchStep) =>
      step.kind === 'setPoolFor'
        ? { values: { ...step.values, fee: 3000, tickSpacing: 60 } }
        : { values: step.values },
    )
    const result = await mirrorBatch(
      [hookStep(), poolStep(), terminalStep()],
      { chainId: 8453, projectId: 6 },
      resolve,
    )
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(result.skipped).toEqual([])
    expect(result.steps.map(step => [step.chainId, step.projectId, step.kind])).toEqual([
      [8453, 6, 'setHookFor'],
      [8453, 6, 'setPoolFor'],
      [8453, 6, 'setTerminalFor'],
    ])
    expect(result.steps[0].args).toEqual([6n, HOOK])
    expect(result.steps[1].args).toEqual([6n, 3000, 60, 1800n, NATIVE])
    expect(result.steps[1].values.twapWindow).toBe(1800n)
  })

  it('drops steps the target chain cannot resolve, with the reason', async () => {
    const result = await mirrorBatch(
      [poolStep(), terminalStep()],
      { chainId: 8453, projectId: 6 },
      async () => ({ skip: 'No matching pool on Base.' }),
    )
    expect(result.steps.map(step => step.kind)).toEqual(['setTerminalFor'])
    expect(result.skipped).toEqual([
      { step: expect.objectContaining({ kind: 'setPoolFor' }), reason: 'No matching pool on Base.' },
    ])
  })
})

describe('Safe batch tray storage', () => {
  const storage = new Map<string, string>()
  const listeners: Array<() => void> = []

  beforeEach(() => {
    storage.clear()
    listeners.length = 0
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      dispatchEvent: () => listeners.forEach(listener => listener()),
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    vi.stubGlobal('Event', class { constructor(public type: string) {} })
  })

  it('persists bigint-safe steps per chain and project and rebuilds them on read', () => {
    writeSafeBatch(1, 2, [hookStep(), poolStep()])
    const raw = storage.get(safeBatchStorageKey(1, 2))
    expect(raw).toContain('$safeBatchBigInt')
    expect(safeBatchStorageKey(1, 2)).toBe('jbm:safe-batch:v1:1:2')
    const steps = readSafeBatch(1, 2)
    expect(steps.map(step => step.data)).toEqual([SET_HOOK_DATA, SET_POOL_DATA])
    expect(steps[1].values.twapWindow).toBe(1800n)
    expect(readSafeBatch(8453, 2)).toEqual([])
    writeSafeBatch(1, 2, [])
    expect(storage.has(safeBatchStorageKey(1, 2))).toBe(false)
  })

  it('discards a tray that fails to parse or validate', () => {
    storage.set(safeBatchStorageKey(1, 2), 'not json')
    expect(readSafeBatch(1, 2)).toEqual([])
    storage.set(
      safeBatchStorageKey(1, 2),
      JSON.stringify({ version: 1, steps: [{ kind: 'setHookFor', values: { hook: 'bad' } }] }),
    )
    expect(readSafeBatch(1, 2)).toEqual([])
    storage.set(
      safeBatchStorageKey(1, 2),
      JSON.stringify({ version: 1, steps: [{ kind: 'selfdestruct', values: {} }] }),
    )
    expect(readSafeBatch(1, 2)).toEqual([])
    storage.set(safeBatchStorageKey(1, 2), JSON.stringify({ version: 2, steps: [] }))
    expect(readSafeBatch(1, 2)).toEqual([])
  })

  it('encodes the registry setter the way the SDK ABI does', () => {
    expect(
      encodeFunctionData({
        abi: jbBuybackHookRegistryAbi,
        functionName: 'setHookFor',
        args: [2n, HOOK],
      }),
    ).toBe(SET_HOOK_DATA)
  })
})
