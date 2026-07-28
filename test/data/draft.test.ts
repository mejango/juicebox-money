import { describe, expect, it } from 'vitest'
import { parseDraft } from '@/lib/draft'

/** A minimal .jb payload: parseDraft only requires `name` and `stages`. */
function jbFile(stage: Record<string, unknown>): string {
  return JSON.stringify({
    name: 'Test project',
    chains: [10, 8453],
    stages: [stage],
  })
}

describe('.jb draft auto-issuance rows', () => {
  it('round-trips each row with its chosen mint chain', () => {
    const draft = parseDraft(
      jbFile({
        autoIssuances: [
          { count: '1000', address: '0x' + '11'.repeat(20), chainId: 8453 },
          { count: '5', address: 'someone.eth', chainId: null },
        ],
      }),
    )
    expect(
      draft.stages[0].autoIssuances.map(({ count, address, chainId }) => ({
        count,
        address,
        chainId,
      })),
    ).toEqual([
      { count: '1000', address: '0x' + '11'.repeat(20), chainId: 8453 },
      { count: '5', address: 'someone.eth', chainId: null },
    ])
  })

  it('nulls garbage chain ids but keeps unselected ones for encode-time fallback', () => {
    // A chainId outside the selected set survives verbatim — the encode
    // falls back to the first selected chain (autoIssuanceMintChain) — while
    // non-numeric garbage becomes null (= first selected chain).
    const draft = parseDraft(
      jbFile({
        autoIssuances: [
          { count: '1', address: '0x' + '22'.repeat(20), chainId: 1 },
          { count: '2', address: '0x' + '33'.repeat(20), chainId: 'evil' },
          { count: '3', address: '0x' + '44'.repeat(20), chainId: -5 },
          { count: '4', address: '0x' + '55'.repeat(20) },
        ],
      }),
    )
    expect(draft.stages[0].autoIssuances.map(a => a.chainId)).toEqual([
      1,
      null,
      null,
      null,
    ])
  })
})
