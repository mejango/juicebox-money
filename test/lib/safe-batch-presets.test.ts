import { zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  DEPLOYER_DEFAULT_TWAP_NOTE,
  presetInfraAvailable,
  resolveMirrorValues,
  resolvePreset,
  SAFE_BATCH_PRESETS,
} from '@/lib/safe-batch-presets'
import { buildStep, mirrorBatch } from '@/lib/safe-batch'
import { rolloutTargets } from '@/lib/protocol-rollout'
import * as rollout from '@/lib/protocol-rollout'

const PRESET = SAFE_BATCH_PRESETS[0]
const OLD_HOOK = '0x77bEe1AD2AC0ACe98A9b5b58d75685C8B4d94948' as Address
const NEW_HOOK = rolloutTargets(11155111)!.hook
const NEW_TERMINAL = rolloutTargets(11155111)!.terminal
const OLD_TERMINAL = '0x9999999999999999999999999999999999999999' as Address
const NATIVE = '0x000000000000000000000000000000000000EEEe' as Address
const USDC_BASE = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address

function withPendingChains(chainIds: readonly number[]) {
  const targets = rollout.rolloutTargets
  vi.spyOn(rollout, 'rolloutTargets').mockImplementation(chainId => chainIds.includes(chainId) ? null : targets(chainId))
}

type Pool = { fee: number; tickSpacing: number; twap: bigint }

/** A stubbed chain: code presence, registry pointers, and pools per (hook, token). */
function chain({
  code = [NEW_HOOK, NEW_TERMINAL],
  hook = OLD_HOOK,
  terminal = OLD_TERMINAL,
  pools = {},
  hookAllowed = true,
  terminalAllowed = true,
}: {
  code?: Address[]
  hook?: Address
  terminal?: Address
  pools?: Record<string, Pool>
  hookAllowed?: boolean
  terminalAllowed?: boolean
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
        throw new Error(`Unexpected read ${functionName}`)
      },
    ),
  }
  return client as unknown as PublicClient & typeof client
}

describe('buyback 1.4.0 + gateway preset', () => {
  it('refuses deployed but disallowed selections and propagates unknown allowances', async () => {
    for (const client of [chain({ hookAllowed: false }), chain({ terminalAllowed: false })]) {
      expect(await resolvePreset(PRESET, { chainId: 11155111, projectId: 2, client })).toMatchObject({ status: 'unavailable', steps: [] })
    }
    const client = chain({})
    client.readContract.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(resolvePreset(PRESET, { chainId: 11155111, projectId: 2, client })).rejects.toThrow('RPC unavailable')
    const step = buildStep({ kind: 'setHookFor', chainId: 11155111, projectId: 2, values: { hook: NEW_HOOK } })
    expect(await resolveMirrorValues(step, { chainId: 84532, projectId: 2, client: chain({ hookAllowed: false }) })).toEqual({ skip: 'The selected hook is not allowed by the registry on Base Sepolia.' })
  })

  it('uses canonical per-chain targets only after deployment', () => {
    expect(PRESET).toMatchObject({
      id: 'buyback-1-4-0-gateway',
      title: 'Move to buyback 1.4.0 + gateway',
      steps: ['setHookFor', 'setPoolFor', 'setTerminalFor'],
    })
    expect(presetInfraAvailable(1)).toBe(true)
    expect(presetInfraAvailable(11155111)).toBe(true)
    expect(rolloutTargets(11155111)).toEqual({ hook: NEW_HOOK, terminal: NEW_TERMINAL })
  })

  it('does not activate proposed mainnets even when target bytecode exists', async () => {
    withPendingChains([1])
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

  it('builds hook, carried native pool and terminal steps for a project on the old hook', async () => {
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
    expect(pools[0].args).toEqual([6n, 10_000, 200, 3600n, USDC_BASE])
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
  it('skips the actual migration batch and its dependent pool on unexecuted chains', async () => {
    withPendingChains([1, 10, 8453, 42161, 11155420])
    const client = chain({ pools: { [`${OLD_HOOK.toLowerCase()}:${zeroAddress}`]: { fee: 3000, tickSpacing: 60, twap: 1800n } } })
    const source = await resolvePreset(PRESET, { chainId: 11155111, projectId: 2, client })
    expect(source.steps).toHaveLength(3)
    for (const chainId of [1, 10, 8453, 42161, 11155420] as const) {
      const mirrored = await mirrorBatch(source.steps, { chainId, projectId: 2 }, (step, to) => resolveMirrorValues(step, { ...to, client }))
      expect(mirrored.steps).toEqual([])
      expect(mirrored.skipped).toHaveLength(3)
      expect(mirrored.skipped[1].reason).toContain('preceding buyback hook selection')
    }
    const available = await mirrorBatch(source.steps, { chainId: 84532, projectId: 2 }, (step, to) => resolveMirrorValues(step, { ...to, client }))
    expect(available.skipped).toEqual([])
    expect(available.steps.map(step => step.kind)).toEqual(['setHookFor', 'setPoolFor', 'setTerminalFor'])
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
    withPendingChains([10])
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
    ).toEqual({ skip: 'The buyback and gateway rollout is not deployed on Optimism yet.' })
  })
})
