import { describe, expect, it } from 'vitest'

import { stageRulesetIdOn } from '@/components/project/OwnersTab'
import type { JBRulesetWithMetadata } from '@bananapus/nana-sdk-core/v6'

function stage(id: number, start: number): JBRulesetWithMetadata {
  return { ruleset: { id, start } } as unknown as JBRulesetWithMetadata
}

describe('stageRulesetIdOn', () => {
  it('picks the stage-index ruleset from that chain\'s own history, sorted by start', () => {
    // Ruleset ids differ per chain (they are creation timestamps); the stage
    // ORDER is what deployments share, so index-by-start identifies the stage.
    const peerChain = [stage(900, 3_000), stage(700, 1_000), stage(800, 2_000)]
    expect(stageRulesetIdOn(peerChain, 0)).toBe(700)
    expect(stageRulesetIdOn(peerChain, 1)).toBe(800)
    expect(stageRulesetIdOn(peerChain, 2)).toBe(900)
  })

  it('returns null when the chain has no matching stage instead of guessing', () => {
    expect(stageRulesetIdOn([stage(700, 1_000)], 1)).toBeNull()
    expect(stageRulesetIdOn([], 0)).toBeNull()
  })
})
