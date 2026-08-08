import { createHash } from 'node:crypto'
import { PROTOCOL_CONCEPTS } from '@/lib/protocol-concepts'
import { describe, expect, it } from 'vitest'

/**
 * The definitions in PROTOCOL_CONCEPTS are duplicated into revnet-money
 * (src/lib/protocolConcepts.ts) and juicescan (PROTOCOL_CONCEPTS in discover.js) because the
 * three clients are separate repos with no shared package. Three copies of one source of truth
 * is the exact divergent-duplication failure the 2026-08 audit spent its time removing, and
 * nothing else stops these from drifting apart sentence by sentence.
 *
 * So: hash the entries all three clients carry, and pin it. The constant below is IDENTICAL in
 * all three repos, which makes cross-repo agreement checkable by eye — grep SHARED_CONCEPT_HASH
 * in the other two and compare.
 *
 * Editing any shared definition fails this test in whichever repo you edited. The fix is to
 * make the same edit in the other two and update the hash in all three. That friction is the
 * point: it is cheaper than discovering months later that a fee is explained three ways.
 */
const SHARED_CONCEPT_KEYS = [
  'issuance',
  'reservedShare',
  'autoIssuance',
  'cashOutTax',
  'surplusAllowance',
  'twapWindow',
] as const

/** Must match revnet-money and juicescan. Update all three together, never one. */
const SHARED_CONCEPT_HASH = '41c5c9369e51e09e'

export function hashSharedConcepts(
  concepts: Record<string, string>,
  keys: readonly string[],
): string {
  const body = [...keys]
    .sort()
    .map(key => `${key}\n${concepts[key]}`)
    .join('\n---\n')
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

describe('shared concept copy', () => {
  it('carries every definition the other clients rely on', () => {
    for (const key of SHARED_CONCEPT_KEYS) {
      expect(PROTOCOL_CONCEPTS[key], `${key} is missing`).toBeTruthy()
    }
  })

  it('matches the copy shipped by revnet-money and juicescan', () => {
    expect(
      hashSharedConcepts(PROTOCOL_CONCEPTS, SHARED_CONCEPT_KEYS),
      'Shared concept copy changed. Make the same edit in revnet-money ' +
        '(src/lib/protocolConcepts.ts) and juicescan (PROTOCOL_CONCEPTS in discover.js), then ' +
        'update SHARED_CONCEPT_HASH in all three.',
    ).toBe(SHARED_CONCEPT_HASH)
  })
})
