import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { pctToBp, queueRulesetAuthority } from '@/components/project/QueueRulesetFlow'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const SAFE = '0x4444444444444444444444444444444444444444' as Address

describe('pctToBp', () => {
  it('encodes a 0% reserved share — turning reserving off is a queueable rule', () => {
    expect(pctToBp('0')).toBe(0)
    expect(pctToBp('')).toBe(0)
  })

  it('rounds and clamps ordinary percents into basis points of 10000', () => {
    expect(pctToBp('12.34')).toBe(1234)
    expect(pctToBp('100')).toBe(10_000)
    expect(pctToBp('250')).toBe(10_000)
  })
})

describe('queueRulesetAuthority', () => {
  it('lets the owner queue as themselves', () => {
    expect(
      queueRulesetAuthority({
        address: ALICE,
        owner: ALICE.toUpperCase().replace('0X', '0x') as Address,
        safeSigners: undefined,
        hasQueuePermission: undefined,
      }),
    ).toEqual(ALICE.toUpperCase().replace('0X', '0x'))
  })

  it('lets a signer of the owning Safe queue THROUGH the Safe (authority = the Safe)', () => {
    expect(
      queueRulesetAuthority({
        address: ALICE,
        owner: SAFE,
        safeSigners: [BOB, ALICE],
        hasQueuePermission: undefined,
      }),
    ).toBe(SAFE)
  })

  it('lets a QUEUE_RULESETS operator queue as themselves', () => {
    expect(
      queueRulesetAuthority({
        address: ALICE,
        owner: BOB,
        safeSigners: [],
        hasQueuePermission: true,
      }),
    ).toBe(ALICE)
  })

  it('denies everyone else, including while reads are still pending', () => {
    expect(
      queueRulesetAuthority({
        address: ALICE,
        owner: BOB,
        safeSigners: [],
        hasQueuePermission: false,
      }),
    ).toBeNull()
    expect(
      queueRulesetAuthority({
        address: ALICE,
        owner: BOB,
        safeSigners: undefined,
        hasQueuePermission: undefined,
      }),
    ).toBeNull()
    expect(
      queueRulesetAuthority({
        address: undefined,
        owner: BOB,
        safeSigners: [ALICE],
        hasQueuePermission: true,
      }),
    ).toBeNull()
    expect(
      queueRulesetAuthority({
        address: ALICE,
        owner: undefined,
        safeSigners: [ALICE],
        hasQueuePermission: true,
      }),
    ).toBeNull()
  })
})
