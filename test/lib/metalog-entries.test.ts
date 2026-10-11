import { describe, expect, it } from 'vitest'
import { validateMetalogEntries } from '@/lib/metalog-entries'
import { entryContext, entryPage } from '../support/metalog-entries-fixture'

describe('Metalog original entry boundary', () => {
  it('accepts canonical receipt/chart evidence without reconstructing probability', () => {
    const page = entryPage()
    expect(validateMetalogEntries(page, entryContext)).toBe(page)
  })
  it('binds chain, project, native hook and pagination snapshot', () => {
    for (const patch of [{ chainId: 8453 }, { projectId: '2' }, { hook: `0x${'2'.repeat(40)}` }, { snapshotBlockHash: 'bad' }]) expect(() => validateMetalogEntries({ ...entryPage(), ...patch }, entryContext)).toThrow()
    expect(() => validateMetalogEntries(entryPage(), entryContext, { blockNumber: '99' })).toThrow()
    expect(() => validateMetalogEntries(entryPage(), entryContext, { snapshotBlockHash: `0x${'c'.repeat(64)}` })).toThrow()
    expect(() => validateMetalogEntries(entryPage(), entryContext, { cursor: '89:2147483647' })).toThrow()
  })
  it('rejects malformed counts, duplicate receipts, unsupported curve evidence and oversized pages', () => {
    const changes = [
      (p: ReturnType<typeof entryPage>) => { p.entries[0].quantities[3] = 5 },
      (p: ReturnType<typeof entryPage>) => { p.entries[0].coefficients = [NaN, 1] },
      (p: ReturnType<typeof entryPage>) => { p.entries[0].timestamp = 8640000000001 },
      (p: ReturnType<typeof entryPage>) => { p.entries[0].chart = null; p.entries[0].coefficients = null },
      (p: ReturnType<typeof entryPage>) => { p.entries[0].stakeWei = null },
      (p: ReturnType<typeof entryPage>) => { p.entries[0].beneficiary = null },
      (p: ReturnType<typeof entryPage>) => { p.entries[0].status = 'unrecognized' },
      (p: ReturnType<typeof entryPage>) => { p.entries.push(p.entries[0]) },
      (p: ReturnType<typeof entryPage>) => { p.ranges[2].upper = -1.4 },
      (p: ReturnType<typeof entryPage>) => { p.entries[0].chart!.positions[3].quantity = 5 },
      (p: ReturnType<typeof entryPage>) => { p.complete = true },
      (p: ReturnType<typeof entryPage>) => { p.entries = Array(9).fill(p.entries[0]) },
    ]
    for (const change of changes) { const page = entryPage(); change(page); expect(() => validateMetalogEntries(page, entryContext)).toThrow() }
  })
  it('preserves unavailable curves and stake without guessing missing evidence', () => {
    const page = entryPage(); page.entries[0].status = 'unrecognized'; page.entries[0].chart = null; page.entries[0].coefficients = null; page.entries[0].stakeWei = null
    expect(validateMetalogEntries(page, entryContext).entries[0].chart).toBeNull()
    page.entries[0].status = 'verified-manual'; page.entries[0].stakeWei = '4000000'; page.entries[0].coefficients = [0, 1]; page.entries[0].chartError = 'Curve display unavailable.'
    expect(validateMetalogEntries(page, entryContext).entries[0].quantities).toEqual([0, 0, 0, 4, 0, 0, 0])
  })
  it('keeps bounded empty scan distinct from unavailable and incomplete history', () => {
    const page = entryPage(); page.entries = []
    expect(validateMetalogEntries(page, entryContext).complete).toBe(false)
    page.scannedFromBlock = null; page.scannedToBlock = null; page.complete = true; page.nextCursor = null
    expect(validateMetalogEntries(page, entryContext).scannedFromBlock).toBeNull()
  })
})
