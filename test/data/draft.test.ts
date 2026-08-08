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

/** A .jb payload with top-level fields, one throwaway stage. */
function jbDraft(fields: Record<string, unknown>): string {
  return JSON.stringify({
    name: 'Test project',
    chains: [10, 8453],
    stages: [{}],
    ...fields,
  })
}

const HOOK = '0x' + 'ab'.repeat(20)
const TOKEN = '0x' + 'cd'.repeat(20)

describe('.jb draft approval deadline', () => {
  it('round-trips a custom approval hook — deadline AND address', () => {
    // 'custom' is a legal ApprovalDeadline the wizard and the project exporter
    // both produce. Dropping it from the whitelist rewrote every round trip —
    // including the localStorage rehydrate that runs on page load — to a 1-day
    // deadline, so a configured JBRulesetApprovalHook silently never applied.
    const draft = parseDraft(
      jbDraft({ approvalDeadline: 'custom', approvalCustom: HOOK }),
    )
    expect(draft.approvalDeadline).toBe('custom')
    expect(draft.approvalCustom).toBe(HOOK)
    // And it survives a SECOND pass (export → import of an imported draft).
    expect(parseDraft(JSON.stringify(draft)).approvalDeadline).toBe('custom')
  })

  it('keeps the fixed deadlines and falls back to 1 day for anything else', () => {
    for (const deadline of ['none', '3hours', '1day', '3days', '7days']) {
      expect(parseDraft(jbDraft({ approvalDeadline: deadline }))
        .approvalDeadline).toBe(deadline)
    }
    expect(parseDraft(jbDraft({ approvalDeadline: 'forever' })).approvalDeadline)
      .toBe('1day')
    expect(parseDraft(jbDraft({})).approvalDeadline).toBe('1day')
  })
})

describe('.jb draft shop pricing currency', () => {
  it("keeps 'token' pricing alongside the custom accounting token", () => {
    const draft = parseDraft(
      jbDraft({ storeCurrency: 'token', customAddress: TOKEN }),
    )
    expect(draft.storeCurrency).toBe('token')
    expect(draft.customAddress).toBe(TOKEN)
  })

  it("drops 'token' pricing when no custom accounting token is configured", () => {
    // The encoder has no token to price against and would fall through to ETH
    // at 18 decimals — "10 TOKEN" would launch as 10 ETH. null re-derives the
    // pricing from the accepted tokens instead.
    expect(
      parseDraft(jbDraft({ storeCurrency: 'token', customAddress: '' }))
        .storeCurrency,
    ).toBeNull()
    expect(
      parseDraft(jbDraft({ storeCurrency: 'token' })).storeCurrency,
    ).toBeNull()
  })

  it('passes the standard pricing currencies through unchanged', () => {
    expect(parseDraft(jbDraft({ storeCurrency: 'eth' })).storeCurrency).toBe(
      'eth',
    )
    expect(parseDraft(jbDraft({ storeCurrency: 'usd' })).storeCurrency).toBe(
      'usd',
    )
    expect(parseDraft(jbDraft({ storeCurrency: 'gbp' })).storeCurrency).toBeNull()
  })
})

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
