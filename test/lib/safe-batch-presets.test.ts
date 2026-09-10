import { zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  DEPLOYER_DEFAULT_TWAP_NOTE,
  presetInfraAvailable,
  resolveMirrorValues,
  resolvePreset,
  SAFE_BATCH_PRESETS,
} from '@/lib/safe-batch-presets'
import { buildStep } from '@/lib/safe-batch'

const PRESET = SAFE_BATCH_PRESETS[0]
const OLD_HOOK = '0x77bEe1AD2AC0ACe98A9b5b58d75685C8B4d94948' as Address
const NEW_HOOK = PRESET.targets.hook
const NEW_TERMINAL = PRESET.targets.terminal
const OLD_TERMINAL = '0x9999999999999999999999999999999999999999' as Address
const NATIVE = '0x000000000000000000000000000000000000EEEe' as Address
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

type Pool = { fee: number; tickSpacing: number; twap: bigint }

/** A stubbed chain: code presence, registry pointers, and pools per (hook, token). */
function chain({
  code = [NEW_HOOK, NEW_TERMINAL],
  hook = OLD_HOOK,
  terminal = OLD_TERMINAL,
  pools = {},
}: {
  code?: Address[]
  hook?: Address
  terminal?: Address
  pools?: Record<string, Pool>
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
  it('is data with the same targets on every chain', () => {
    expect(PRESET).toMatchObject({
      id: 'buyback-1-4-0-gateway',
      title: 'Move to buyback 1.4.0 + gateway',
      steps: ['setHookFor', 'setPoolFor', 'setTerminalFor'],
    })
    expect(presetInfraAvailable(1)).toBe(true)
    expect(presetInfraAvailable(11155111)).toBe(true)
  })

  it('is unavailable where the hook or the gateway has no code', async () => {
    const noHook = await resolvePreset(PRESET, {
      chainId: 1,
      projectId: 2,
      client: chain({ code: [NEW_TERMINAL] }),
    })
    expect(noHook).toEqual({
      status: 'unavailable',
      message: 'Not deployed on Ethereum yet.',
      steps: [],
    })
    const noTerminal = await resolvePreset(PRESET, {
      chainId: 8453,
      projectId: 6,
      client: chain({ code: [NEW_HOOK] }),
    })
    expect(noTerminal.status).toBe('unavailable')
    expect(noTerminal.message).toBe('Not deployed on Base yet.')
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
    const resolved = await resolvePreset(PRESET, { chainId: 1, projectId: 2, client })
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
    const resolved = await resolvePreset(PRESET, { chainId: 8453, projectId: 6, client })
    const pools = resolved.steps.filter(step => step.kind === 'setPoolFor')
    expect(pools).toHaveLength(1)
    expect(pools[0].args).toEqual([6n, 10_000, 200, 3600n, USDC_BASE])
  })

  it('adds no pool step when the project has no pool, and skips applied steps', async () => {
    const noPool = await resolvePreset(PRESET, {
      chainId: 10,
      projectId: 6,
      client: chain({ hook: OLD_HOOK, terminal: NEW_TERMINAL }),
    })
    expect(noPool.steps.map(step => step.kind)).toEqual(['setHookFor'])

    const zeroHook = await resolvePreset(PRESET, {
      chainId: 10,
      projectId: 6,
      client: chain({ hook: zeroAddress }),
    })
    expect(zeroHook.steps.map(step => step.kind)).toEqual(['setHookFor', 'setTerminalFor'])

    const done = await resolvePreset(PRESET, {
      chainId: 42161,
      projectId: 6,
      client: chain({ hook: NEW_HOOK, terminal: NEW_TERMINAL }),
    })
    expect(done).toEqual({
      status: 'nothing',
      message: 'Nothing to do on Arbitrum: already on the current hook and gateway.',
      steps: [],
    })
  })
})

describe('mirroring per-chain steps', () => {
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
    const resolution = await resolveMirrorValues(step, { chainId: 8453, projectId: 6, client })
    expect(resolution).toEqual({
      values: { fee: 10_000, tickSpacing: 200, twapWindow: 900n, terminalToken: USDC_BASE },
    })
    const missing = await resolveMirrorValues(step, {
      chainId: 8453,
      projectId: 6,
      client: chain({}),
    })
    expect(missing).toEqual({ skip: 'No matching pool on Base.' })
  })

  it('refuses chain-specific prices and owner powers', async () => {
    const init = buildStep({
      kind: 'initializePoolFor',
      chainId: 1,
      projectId: 2,
      values: { fee: 3000, tickSpacing: 60, twapWindow: 1800n, pairToken: NATIVE, sqrtPriceX96: 1n },
    })
    expect(
      await resolveMirrorValues(init, { chainId: 10, projectId: 2, client: chain({}) }),
    ).toEqual({ skip: 'The initial price is chain-specific. Add it on Optimism directly.' })
    const hook = buildStep({ kind: 'setHookFor', chainId: 1, projectId: 2, values: { hook: NEW_HOOK } })
    expect(
      await resolveMirrorValues(hook, { chainId: 10, projectId: 2, client: chain({}) }),
    ).toEqual({ values: { hook: NEW_HOOK } })
  })
})
