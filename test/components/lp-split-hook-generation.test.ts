// The LP split hook has been redeployed twice. jbm pinned the N−1 generation as a bare
// constant, so every new market split routed at the superseded hook, the splits editor
// read a CURRENT hook as an opaque custom address, and OP Sepolia — which has no
// deployment at all — got the address attached anyway (a reserved split whose hook has
// no code reverts split processing).
import { describe, expect, it } from 'vitest'
import { zeroAddress, type Address } from 'viem'
import {
  LEGACY_LP_SPLIT_HOOKS,
  LP_SPLIT_HOOK,
  chainsWithoutLpSplitHook,
  lpSplitHookGeneration,
  lpSplitHookOn,
  requireLpSplitHook,
} from '@/lib/launch'
import { splitToDraft } from '@/components/project/EditSplitsFlow'
import type { RawSplit } from '@/lib/splits-types'

/** deploy-all-v6 `deployments/<chain>/JBUniswapV4LPSplitHook.json`. */
const DEPLOYED_CHAINS = [1, 10, 8453, 42161, 11155111, 84532, 421614]
/** deploy-all-v6 has no JBUniswapV4LPSplitHook.json under optimism_sepolia. */
const OP_SEPOLIA = 11155420

function hookSplit(hook: Address): RawSplit {
  return {
    percent: 100_000_000,
    projectId: 0n,
    beneficiary: zeroAddress,
    preferAddToBalance: false,
    lockedUntil: 0,
    hook,
  }
}

describe('LP split hook generations', () => {
  it('pins the currently deployed hook, not a superseded one', () => {
    expect(LP_SPLIT_HOOK).toBe('0xfcdbabd7b8de07c6e4ca7d79790e235848edc251')
    expect(LEGACY_LP_SPLIT_HOOKS).toContain(
      '0xaf2d8a027955871cd2f3c4d2f32338e574e69bc0',
    )
    expect(LEGACY_LP_SPLIT_HOOKS).not.toContain(LP_SPLIT_HOOK)
  })

  it('resolves the hook only on chains that actually have one', () => {
    for (const chainId of DEPLOYED_CHAINS) {
      expect(lpSplitHookOn(chainId), String(chainId)).toBe(LP_SPLIT_HOOK)
    }
    expect(lpSplitHookOn(OP_SEPOLIA)).toBeNull()
    expect(chainsWithoutLpSplitHook([8453, OP_SEPOLIA])).toEqual([OP_SEPOLIA])
    expect(chainsWithoutLpSplitHook(DEPLOYED_CHAINS)).toEqual([])
  })

  it('throws rather than encoding a codeless hook address', () => {
    expect(requireLpSplitHook(8453)).toBe(LP_SPLIT_HOOK)
    expect(() => requireLpSplitHook(OP_SEPOLIA)).toThrow(
      /no market split hook deployed/,
    )
  })

  it('recognizes the current hook and keeps a legacy one read-only', () => {
    const current = splitToDraft(hookSplit(LP_SPLIT_HOOK))
    expect(current.kind).toBe('hook')
    expect(current.hookKind).toBe('fundmarket')

    const legacy = splitToDraft(hookSplit(LEGACY_LP_SPLIT_HOOKS[0]))
    expect(legacy.hookKind).toBe('fundmarket-legacy')
    // The legacy address is preserved verbatim, so an unrelated edit cannot
    // migrate an existing split onto a different hook.
    expect(legacy.hookAddress).toBe(LEGACY_LP_SPLIT_HOOKS[0])

    const unrelated = splitToDraft(
      hookSplit(`0x${'ab'.repeat(20)}` as Address),
    )
    expect(unrelated.hookKind).toBe('custom')
  })

  it('classifies hook addresses case-insensitively', () => {
    expect(lpSplitHookGeneration(LP_SPLIT_HOOK.toUpperCase())).toBe('current')
    expect(lpSplitHookGeneration(LEGACY_LP_SPLIT_HOOKS[1])).toBe('legacy')
    expect(lpSplitHookGeneration(zeroAddress)).toBeNull()
  })
})
