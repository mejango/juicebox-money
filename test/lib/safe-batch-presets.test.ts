import { getAddress, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { uniswapV4PoolId, uniswapV4PoolStateSlot, uniswapV4SqrtPriceX96AtTick } from '@bananapus/nana-sdk-core/v6'
import { migratedPoolKey, type V4PoolKey } from '@/lib/buyback-pool-migration'
import {
  DEPLOYER_DEFAULT_TWAP_NOTE,
  MIGRATION_MIRROR_LINE,
  NEW_POOL_PRICE_OFF_NOTE,
  NO_POOL_HISTORY_NOTE,
  newPoolNote,
  presetInfraAvailable,
  replacedTwapNote,
  resolveMirrorValues,
  resolvePreset,
  SAFE_BATCH_PRESETS,
} from '@/lib/safe-batch-presets'
import { buildStep, mirrorBatch, queueSteps, upsertStep } from '@/lib/safe-batch'
import { rolloutAddress, rolloutTargets } from '@/lib/protocol-rollout'
import * as rollout from '@/lib/protocol-rollout'

const PRESET = SAFE_BATCH_PRESETS[0]
const MAINNETS = [1, 10, 8453, 42161] as const
const OLD_HOOK = '0xb222dA5A71E8fB89a5A38B7C920eaB5dfbc74b91' as Address
const OLD_PRICE = 79_228_162_514_264_337_593_543_950_336n
const NEW_HOOK = rolloutTargets(11155111)!.hook
const NEW_TERMINAL = rolloutTargets(11155111)!.terminal
const OLD_TERMINAL = '0x9999999999999999999999999999999999999999' as Address
const NATIVE = '0x000000000000000000000000000000000000EEEe' as Address
const USDC_BASE = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address

function withMissingDeploymentRecords(chainIds: readonly number[]) {
  const targets = rollout.rolloutTargets
  vi.spyOn(rollout, 'rolloutTargets').mockImplementation(chainId => chainIds.includes(chainId) ? null : targets(chainId))
}

type Pool = { fee: number; tickSpacing: number; twap: bigint }

/** The PoolManager slot0 word of the pool the stub's current hook reports, moved onto a chain's current V4 hook. */
function newPoolSlot(chainId: number, fee: number, tickSpacing: number): string {
  const old: V4PoolKey = { currency0: zeroAddress, currency1: zeroAddress, fee, tickSpacing, hooks: zeroAddress }
  return uniswapV4PoolStateSlot(uniswapV4PoolId(migratedPoolKey(old, rolloutAddress('JBUniswapV4Hook', chainId)!))).toLowerCase()
}
function oldPoolSlot(fee: number, tickSpacing: number): string {
  return uniswapV4PoolStateSlot(uniswapV4PoolId({ currency0: zeroAddress, currency1: zeroAddress, fee, tickSpacing, hooks: zeroAddress })).toLowerCase()
}

/** A stubbed chain: code presence, registry pointers, and pools per (hook, token). */
function chain({
  code = [NEW_HOOK, NEW_TERMINAL],
  hook = OLD_HOOK,
  terminal = OLD_TERMINAL,
  pools = {},
  hookAllowed = true,
  terminalAllowed = true,
  prices = {},
  coverage = 1_800,
  meanTick = 0,
  reservedSplits = [],
}: {
  /** The current stage's reserved splits. */
  reservedSplits?: readonly object[]
  code?: Address[]
  hook?: Address
  terminal?: Address
  pools?: Record<string, Pool>
  hookAllowed?: boolean
  terminalAllowed?: boolean
  /** sqrtPriceX96 per PoolManager slot; any pool not listed is live at OLD_PRICE. */
  prices?: Record<string, bigint>
  /** The longest window the old V4 hook can observe, in seconds; 0 when it holds no history. */
  coverage?: number
  /** The old pool's mean tick over the observed window. */
  meanTick?: number
}) {
  const poolOf = (hookAddress: Address, token: Address) =>
    pools[`${hookAddress.toLowerCase()}:${token.toLowerCase()}`]
  const client = {
    getCode: vi.fn(async ({ address }: { address: Address }) =>
      code.some(entry => entry.toLowerCase() === address.toLowerCase())
        ? ('0x6000' as Hex)
        : undefined,
    ),
    readContract: vi.fn(
      async ({
        address,
        functionName,
        args,
      }: {
        address: Address
        functionName: string
        args?: readonly unknown[]
      }) => {
        if (functionName === 'hookOf') return hook
        if (functionName === 'terminalOf') return terminal
        if (functionName === 'isHookAllowed') return hookAllowed
        if (functionName === 'isTerminalAllowed') return terminalAllowed
        if (functionName === 'twapWindowOf') {
          return poolOf(address, args?.[1] as Address)?.twap ?? 0n
        }
        if (functionName === 'poolKeyOf') {
          const pool = poolOf(address, args?.[1] as Address)
          return {
            currency0: zeroAddress,
            currency1: zeroAddress,
            fee: pool?.fee ?? 0,
            tickSpacing: pool?.tickSpacing ?? 0,
            hooks: zeroAddress,
          }
        }
        if (functionName === 'extsload') {
          const price = prices[String(args?.[0]).toLowerCase()] ?? OLD_PRICE
          return `0x${price.toString(16).padStart(64, '0')}`
        }
        if (functionName === 'observe') {
          const [period] = args?.[1] as number[]
          if (period! > coverage) throw Object.assign(new Error('reverted'), { name: 'ContractFunctionRevertedError' })
          return [[0n, BigInt(meanTick * period!)], [0n, 0n]]
        }
        if (functionName === 'currentRulesetOf') return [{ id: 1781587898 }, {}]
        if (functionName === 'splitsOf') return reservedSplits
        throw new Error(`Unexpected read ${functionName}`)
      },
    ),
  }
  return client as unknown as PublicClient & typeof client
}

describe('buyback 2.0.0 + gateway preset', () => {
  it('refuses deployed but disallowed selections and propagates unknown allowances', async () => {
    for (const client of [chain({ hookAllowed: false }), chain({ terminalAllowed: false })]) {
      expect(await resolvePreset(PRESET, { chainId: 11155111, projectId: 2, client })).toMatchObject({ status: 'unavailable', steps: [] })
    }
    const client = chain({})
    client.readContract.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(resolvePreset(PRESET, { chainId: 11155111, projectId: 2, client })).rejects.toThrow('RPC unavailable')
    const step = buildStep({ kind: 'setHookFor', chainId: 11155111, projectId: 2, values: { hook: NEW_HOOK } })
    expect(await resolveMirrorValues(step, { chainId: 84532, projectId: 2, client: chain({ hookAllowed: false }) })).toEqual({ skip: MIGRATION_MIRROR_LINE })
  })

  it('uses canonical per-chain targets only after deployment', () => {
    expect(PRESET).toMatchObject({
      id: 'buyback-2-0-0-gateway',
      title: 'Move to buyback 2.0.0 + gateway',
      steps: ['setHookFor', 'setPoolFor', 'setTerminalFor', 'setReservedSplitHook'],
    })
    expect(presetInfraAvailable(1)).toBe(true)
    expect(presetInfraAvailable(11155111)).toBe(true)
    expect(rolloutTargets(11155111)).toEqual({ hook: NEW_HOOK, terminal: NEW_TERMINAL })
  })

  it.each([1, 10, 8453, 42161] as const)('wallet-action:submit-a-safe-operator-batch builds a migration to the executed targets on mainnet chain %i after checking code and registry permissions', async chainId => {
    const targets = rolloutTargets(chainId)!
    expect(targets).not.toBeNull()
    const client = chain({
      code: [targets.hook, targets.terminal],
      pools: { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 3000, tickSpacing: 60, twap: 1800n } },
    })
    const resolved = await resolvePreset(PRESET, { chainId, projectId: 2, client })
    expect(resolved.status).toBe('ready')
    expect(resolved.steps.map(step => step.kind)).toEqual(['setHookFor', 'setPoolFor', 'setTerminalFor'])
    expect(resolved.steps.map(step => step.args)).toEqual([
      [2n, targets.hook],
      [2n, 3000, 60, 1800n, NATIVE],
      [2n, targets.terminal],
    ])
    expect(client.getCode).toHaveBeenCalledWith({ address: targets.hook })
    expect(client.getCode).toHaveBeenCalledWith({ address: targets.terminal })
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'isHookAllowed', args: [targets.hook] }))
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'isTerminalAllowed', args: [targets.terminal] }))
  })

  const OLD_LP_SPLIT_HOOK = '0x22988374af49507fec1ee78811fBc47d10D5e639' as Address
  const NEW_LP_SPLIT_HOOK = getAddress('0xef8993f50363461007bed2f54e98bbef9854148a')
  const wholeSplitTo = (hook: Address, overrides: object = {}) => ({
    percent: 1_000_000_000,
    projectId: 0n,
    beneficiary: zeroAddress,
    preferAddToBalance: false,
    lockedUntil: 0,
    hook,
    ...overrides,
  })
  const settled = (chainId: number) => {
    const targets = rolloutTargets(chainId)!
    return { hook: targets.hook, terminal: targets.terminal, code: [targets.hook, targets.terminal, NEW_LP_SPLIT_HOOK] }
  }

  it('wallet-action:submit-a-safe-operator-batch moves a reserved split from the old market maker hook to the current one', async () => {
    const client = chain({ ...settled(84532), reservedSplits: [wholeSplitTo(OLD_LP_SPLIT_HOOK)] })
    const resolved = await resolvePreset(PRESET, { chainId: 84532, projectId: 4, client })
    expect(resolved.status).toBe('ready')
    expect(resolved.steps.map(step => [step.kind, step.label, step.contractName])).toEqual([
      ['setReservedSplitHook', 'Set reserved split hook', 'JBController'],
    ])
    expect(resolved.steps[0].values).toEqual({ rulesetId: 1781587898n, hook: NEW_LP_SPLIT_HOOK })
    // Pinned in revnet-money's preset test too: co-signers on either client must sign identical calldata.
    expect(resolved.steps[0].data).toMatchInlineSnapshot(`"0x8a36dffd0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000006a30dfba000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000003b9aca000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ef8993f50363461007bed2f54e98bbef9854148a"`)
  })

  it.each([
    ['is already on the current hook', [wholeSplitTo(NEW_LP_SPLIT_HOOK)]],
    ['has no reserved split', []],
    ['shares the split with another recipient', [
      wholeSplitTo(OLD_LP_SPLIT_HOOK, { percent: 500_000_000 }),
      wholeSplitTo(zeroAddress, { percent: 500_000_000, beneficiary: OLD_TERMINAL }),
    ]],
    ['locked the split', [wholeSplitTo(OLD_LP_SPLIT_HOOK, { lockedUntil: 1 })]],
  ])('leaves the reserved split alone when the project %s', async (_name, reservedSplits) => {
    const client = chain({ ...settled(84532), reservedSplits })
    expect(await resolvePreset(PRESET, { chainId: 84532, projectId: 4, client })).toMatchObject({ status: 'nothing' })
  })

  it('leaves the reserved split alone where the current hook has no code', async () => {
    const { hook, terminal } = settled(84532)
    const client = chain({ hook, terminal, code: [hook, terminal], reservedSplits: [wholeSplitTo(OLD_LP_SPLIT_HOOK)] })
    expect(await resolvePreset(PRESET, { chainId: 84532, projectId: 4, client })).toMatchObject({ status: 'nothing' })
  })

  it('requires both execution records and target bytecode before enabling migration', async () => {
    withMissingDeploymentRecords([1])
    const noHook = await resolvePreset(PRESET, {
      chainId: 1,
      projectId: 2,
      client: chain({}),
    })
    expect(noHook).toEqual({
      status: 'unavailable',
      message: 'Not deployed on Ethereum yet.',
      steps: [],
    })
    const noTerminal = await resolvePreset(PRESET, {
      chainId: 84532,
      projectId: 6,
      client: chain({ code: [NEW_HOOK] }),
    })
    expect(noTerminal.status).toBe('unavailable')
    expect(noTerminal.message).toBe('Not deployed on Base Sepolia yet.')
  })

  it('wallet-action:submit-a-safe-operator-batch builds hook, carried native pool and terminal steps for a project on the old hook', async () => {
    const client = chain({
      pools: { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 10_000, tickSpacing: 200, twap: 1800n } },
    })
    const resolved = await resolvePreset(PRESET, { chainId: 11155111, projectId: 2, client })
    expect(resolved.status).toBe('ready')
    expect(resolved.steps.map(step => step.kind)).toEqual([
      'setHookFor',
      'setPoolFor',
      'setTerminalFor',
    ])
    expect(resolved.steps[0].args).toEqual([2n, NEW_HOOK])
    expect(resolved.steps[1].args).toEqual([2n, 10_000, 200, 1800n, NATIVE])
    expect(resolved.steps[1].note).toBeUndefined()
    expect(resolved.steps[2].args).toEqual([2n, NEW_TERMINAL])
    // Pools are read on the CURRENT hook under address(0), never the sentinel.
    expect(
      client.readContract.mock.calls.some(
        ([input]) =>
          input.functionName === 'poolKeyOf' &&
          input.address.toLowerCase() === OLD_HOOK.toLowerCase() &&
          input.args?.[1] === zeroAddress,
      ),
    ).toBe(true)
  })

  it('defaults the deployer 48h window to 30 minutes with a note', async () => {
    const client = chain({
      pools: { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 3000, tickSpacing: 60, twap: 172_800n } },
    })
    const resolved = await resolvePreset(PRESET, { chainId: 11155111, projectId: 2, client })
    const pool = resolved.steps.find(step => step.kind === 'setPoolFor')!
    expect(pool.args).toEqual([2n, 3000, 60, 1800n, NATIVE])
    expect(pool.note).toBe(DEPLOYER_DEFAULT_TWAP_NOTE)
  })

  it('stores 30 minutes whatever the old window, noting a replaced one', async () => {
    for (const [twap, note] of [[3600n, replacedTwapNote(3600n)], [900n, replacedTwapNote(900n)], [1800n, undefined]] as const) {
      const client = chain({ pools: { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 10_000, tickSpacing: 200, twap } } })
      const pool = (await resolvePreset(PRESET, { chainId: 8453, projectId: 7, client })).steps.find(step => step.kind === 'setPoolFor')!
      expect(pool.args).toEqual([7n, 10_000, 200, 1800n, NATIVE])
      expect(pool.note).toBe(note)
    }
  })

  it('carries a USDC pool with the chain USDC address and skips pools the new hook already has', async () => {
    const client = chain({
      pools: {
        [`${OLD_HOOK.toLowerCase()}:${USDC_BASE.toLowerCase()}`]: { fee: 10_000, tickSpacing: 200, twap: 3600n },
        [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 3000, tickSpacing: 60, twap: 1800n },
        [`${NEW_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 3000, tickSpacing: 60, twap: 1800n },
      },
    })
    const resolved = await resolvePreset(PRESET, { chainId: 84532, projectId: 6, client })
    const pools = resolved.steps.filter(step => step.kind === 'setPoolFor')
    expect(pools).toHaveLength(1)
    expect(pools[0].args).toEqual([6n, 10_000, 200, 1800n, USDC_BASE])
  })

  it('opens the native pool on the new V4 hook at the old pool price', async () => {
    const client = chain({
      pools: { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 10_000, tickSpacing: 200, twap: 172_800n } },
      prices: { [newPoolSlot(84532, 10_000, 200)]: 0n },
    })
    const resolved = await resolvePreset(PRESET, { chainId: 84532, projectId: 2, client })
    expect(resolved.steps.map(step => step.kind)).toEqual(['setHookFor', 'initializePoolFor', 'setTerminalFor'])
    expect(resolved.steps[1].args).toEqual([2n, 10_000, 200, 1800n, NATIVE, OLD_PRICE])
    expect(resolved.steps[1].note).toBe(`${DEPLOYER_DEFAULT_TWAP_NOTE} ${newPoolNote(1800)}`)
    // Pinned in revnet-money's preset test too: co-signers on either client must sign identical calldata.
    expect(resolved.steps.map(step => step.data)).toEqual([
      '0x779b0290000000000000000000000000000000000000000000000000000000000000000200000000000000000000000080717f09461a3fb08364fe8c5259220f7d06e0af',
      '0x49e303830000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000000000c80000000000000000000000000000000000000000000000000000000000000708000000000000000000000000000000000000000000000000000000000000eeee0000000000000000000000000000000000000001000000000000000000000000',
      '0xf3e37d010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000e2c259b2fcfd2d57ebcda9b3d2d10bdb1b2cd977',
    ])
  })

  it('registers a new pool that already exists, and carries nothing from an old pool with no price', async () => {
    const pools = { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 10_000, tickSpacing: 200, twap: 1800n } }
    const existing = await resolvePreset(PRESET, { chainId: 84532, projectId: 2, client: chain({ pools }) })
    expect(existing.steps.map(step => step.kind)).toEqual(['setHookFor', 'setPoolFor', 'setTerminalFor'])
    expect(existing.message).toBeNull()
    const unpriced = await resolvePreset(PRESET, {
      chainId: 84532,
      projectId: 2,
      client: chain({ pools, prices: { [newPoolSlot(84532, 10_000, 200)]: 0n, [oldPoolSlot(10_000, 200)]: 0n } }),
    })
    expect(unpriced.steps.map(step => step.kind)).toEqual(['setHookFor', 'setTerminalFor'])
    expect(unpriced.message).toBe('Native pool has no price to carry; set it up on the new hook directly.')
  })

  it("refuses an existing new pool priced more than 1% off the old pool's TWAP", async () => {
    const client = chain({
      pools: { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 10_000, tickSpacing: 200, twap: 1800n } },
      prices: { [newPoolSlot(84532, 10_000, 200)]: 2n * OLD_PRICE, [oldPoolSlot(10_000, 200)]: OLD_PRICE },
    })
    const resolved = await resolvePreset(PRESET, { chainId: 84532, projectId: 2, client })
    expect(resolved.steps.map(step => step.kind)).toEqual(['setHookFor', 'setTerminalFor'])
    expect(resolved.message).toBe(`Native ${NEW_POOL_PRICE_OFF_NOTE}`)
  })

  it('refuses a pool whose old history cannot be observed, never using spot', async () => {
    const client = chain({
      pools: { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 10_000, tickSpacing: 200, twap: 1800n } },
      prices: { [newPoolSlot(84532, 10_000, 200)]: 0n, [oldPoolSlot(10_000, 200)]: 2n * OLD_PRICE },
      coverage: 0,
    })
    const resolved = await resolvePreset(PRESET, { chainId: 84532, projectId: 2, client })
    expect(resolved.steps.map(step => step.kind)).toEqual(['setHookFor', 'setTerminalFor'])
    expect(resolved.message).toBe(`Native ${NO_POOL_HISTORY_NOTE}`)
  })

  it('initializes at the TWAP over the longest window the old hook can answer', async () => {
    const client = chain({
      pools: { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 10_000, tickSpacing: 200, twap: 1800n } },
      prices: { [newPoolSlot(84532, 10_000, 200)]: 0n, [oldPoolSlot(10_000, 200)]: 2n * OLD_PRICE },
      coverage: 600,
      meanTick: -7,
    })
    const resolved = await resolvePreset(PRESET, { chainId: 84532, projectId: 2, client })
    expect(resolved.steps[1].values.sqrtPriceX96).toBe(uniswapV4SqrtPriceX96AtTick(-7))
    expect(resolved.steps[1].note).toBe(newPoolNote(300))
  })

  it('adds no pool step when the project has no pool, and skips applied steps', async () => {
    const noPool = await resolvePreset(PRESET, {
      chainId: 84532,
      projectId: 6,
      client: chain({ hook: OLD_HOOK, terminal: NEW_TERMINAL }),
    })
    expect(noPool.steps.map(step => step.kind)).toEqual(['setHookFor'])

    const zeroHook = await resolvePreset(PRESET, {
      chainId: 84532,
      projectId: 6,
      client: chain({ hook: zeroAddress }),
    })
    expect(zeroHook.steps.map(step => step.kind)).toEqual(['setHookFor', 'setTerminalFor'])

    const done = await resolvePreset(PRESET, {
      chainId: 421614,
      projectId: 6,
      client: chain({ hook: NEW_HOOK, terminal: NEW_TERMINAL }),
    })
    expect(done).toEqual({
      status: 'nothing',
      message: 'Nothing to do on Arbitrum Sepolia: already on the current hook and gateway.',
      steps: [],
    })
  })
})

describe('mirroring per-chain steps', () => {
  it.each(MAINNETS)('refuses to mirror the migration onto mainnet chain %i and points at the preset', async chainId => {
    const pools = { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 3000, tickSpacing: 60, twap: 1800n } }
    const source = await resolvePreset(PRESET, { chainId: 11155111, projectId: 2, client: chain({ pools }) })
    const operator = buildStep({ kind: 'setOperatorOf', chainId: 11155111, projectId: 2, values: { operator: OLD_TERMINAL } })
    const targets = rolloutTargets(chainId)!
    const targetClient = chain({ code: [targets.hook, targets.terminal], pools })
    const mirrored = await mirrorBatch([...source.steps, operator], { chainId, projectId: 6 }, (step, to) => resolveMirrorValues(step, { ...to, client: targetClient }))
    expect(mirrored.skipped.map(item => item.reason)).toEqual([
      MIGRATION_MIRROR_LINE,
      'The preceding buyback hook selection could not be mirrored.',
      MIGRATION_MIRROR_LINE,
    ])
    expect(MIGRATION_MIRROR_LINE).toBe('Use the "Move to buyback 2.0.0 + gateway" preset; it resolves every chain at once.')
    // A step that is not part of the move still mirrors as before.
    expect(mirrored.steps.map(step => step.args)).toEqual([[6n, OLD_TERMINAL]])
  })

  it('skips the migration batch and its dependent pool when destination execution records are missing', async () => {
    withMissingDeploymentRecords([1, 10, 8453, 42161, 11155420])
    const client = chain({ pools: { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 3000, tickSpacing: 60, twap: 1800n } } })
    const source = await resolvePreset(PRESET, { chainId: 11155111, projectId: 2, client })
    expect(source.steps).toHaveLength(3)
    for (const chainId of [1, 10, 8453, 42161, 11155420] as const) {
      const mirrored = await mirrorBatch(source.steps, { chainId, projectId: 2 }, (step, to) => resolveMirrorValues(step, { ...to, client }))
      expect(mirrored.steps).toEqual([])
      expect(mirrored.skipped).toHaveLength(3)
      expect(mirrored.skipped[1].reason).toContain('preceding buyback hook selection')
    }
    const reordered = await mirrorBatch([source.steps[1], source.steps[0], source.steps[2]], { chainId: 1, projectId: 2 }, (step, to) => resolveMirrorValues(step, { ...to, client }))
    expect(reordered.steps).toEqual([])
    expect(reordered.skipped).toHaveLength(3)
    expect(reordered.skipped[0].reason).toContain('before registering its pool')
  })

  it('re-reads a pool on the target chain and maps USDC to that chain', async () => {
    const step = buildStep({
      kind: 'setPoolFor',
      chainId: 1,
      projectId: 2,
      values: {
        fee: 500,
        tickSpacing: 10,
        twapWindow: 900n,
        terminalToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      },
    })
    const client = chain({
      pools: { [`${OLD_HOOK.toLowerCase()}:${USDC_BASE.toLowerCase()}`]: { fee: 10_000, tickSpacing: 200, twap: 172_800n } },
    })
    const resolution = await resolveMirrorValues(step, { chainId: 84532, projectId: 6, client })
    expect(resolution).toEqual({
      values: { fee: 10_000, tickSpacing: 200, twapWindow: 900n, terminalToken: USDC_BASE },
    })
    const missing = await resolveMirrorValues(step, {
      chainId: 84532,
      projectId: 6,
      client: chain({}),
    })
    expect(missing).toEqual({ skip: 'No matching pool on Base Sepolia.' })
  })

  it('refuses chain-specific prices and owner powers', async () => {
    withMissingDeploymentRecords([10])
    const init = buildStep({
      kind: 'initializePoolFor',
      chainId: 1,
      projectId: 2,
      values: { fee: 3000, tickSpacing: 60, twapWindow: 1800n, pairToken: NATIVE, sqrtPriceX96: 1n },
    })
    expect(
      await resolveMirrorValues(init, { chainId: 10, projectId: 2, client: chain({}) }),
    ).toEqual({ skip: 'The initial price is chain-specific. Add it on Optimism directly.' })
    const hook = buildStep({ kind: 'setHookFor', chainId: 11155111, projectId: 2, values: { hook: NEW_HOOK } })
    expect(
      await resolveMirrorValues(hook, { chainId: 10, projectId: 2, client: chain({}) }),
    ).toEqual({ skip: MIGRATION_MIRROR_LINE })
  })
})

describe('queued pool registrations', () => {
  it('keeps one registration per terminal token, whatever its operation', () => {
    const pool = (kind: 'setPoolFor' | 'initializePoolFor', token: Address) =>
      buildStep({
        kind,
        chainId: 84532,
        projectId: 2,
        values:
          kind === 'setPoolFor'
            ? { fee: 10_000, tickSpacing: 200, twapWindow: 1800n, terminalToken: token }
            : { fee: 10_000, tickSpacing: 200, twapWindow: 1800n, pairToken: token, sqrtPriceX96: OLD_PRICE },
      })
    const queued = [pool('setPoolFor', USDC_BASE), pool('setPoolFor', NATIVE)].reduce(upsertStep, [pool('initializePoolFor', NATIVE)])
    expect(queued.map(step => [step.kind, step.values.terminalToken])).toEqual([
      ['setPoolFor', NATIVE],
      ['setPoolFor', USDC_BASE],
    ])
  })

  it('removes a queued registration that a fresh resolution refuses', async () => {
    const resolveAt = (newPrice: bigint) =>
      resolvePreset(PRESET, {
        chainId: 84532,
        projectId: 2,
        client: chain({
          pools: { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 10_000, tickSpacing: 200, twap: 1800n } },
          prices: { [newPoolSlot(84532, 10_000, 200)]: newPrice, [oldPoolSlot(10_000, 200)]: OLD_PRICE },
        }),
      })
    const first = await resolveAt(OLD_PRICE)
    const queued = queueSteps([], first.steps, first.dropped)
    expect(queued.map(step => step.kind)).toContain('setPoolFor')
    const fresh = await resolveAt(2n * OLD_PRICE)
    expect(queueSteps(queued, fresh.steps, fresh.dropped).map(step => step.kind)).toEqual(['setHookFor', 'setTerminalFor'])
  })
})
