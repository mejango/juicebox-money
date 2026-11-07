import { describe, expect, it } from 'vitest'
import { newDraftStage, stageCashOutTax, stageTaxOk } from '@/components/create/stage-draft'
import { parseDraft } from '@/lib/draft'
import { cashOutTaxValue, taxPctFromValue, taxValueFromPct } from '@/lib/format'

const custom = (taxCustomPct: string) => ({ ...newDraftStage(true), cashOuts: true, taxCustomOn: true, taxCustomPct })

describe('cash out tax as a 0 to 1 value', () => {
  it('formats the rate out of JBConstants.MAX_CASH_OUT_TAX_RATE', () => {
    expect([0, 1, 1000, 3000, 2899, 9999, 10_000].map(cashOutTaxValue))
      .toEqual(['0', '0.0001', '0.1', '0.3', '0.2899', '0.9999', '1'])
    expect(cashOutTaxValue(1000n)).toBe('0.1')
  })

  it('encodes every typed value to the rate it shows, through the same percent string as before', () => {
    for (let rate = 0; rate < 10_000; rate++) {
      const pct = taxPctFromValue(cashOutTaxValue(rate))
      expect(stageCashOutTax(custom(pct))).toBe(rate)
      expect(pct).toBe(String(rate / 100))
      expect(taxValueFromPct(pct)).toBe(cashOutTaxValue(rate))
    }
  })

  it('reads a saved percent draft as the same rate', () => {
    const saved = parseDraft(JSON.stringify({ v: 1, name: 'Saved', flavor: 'project', stages: [custom('15')], chains: [1] }))!
    expect(stageCashOutTax(saved.stages[0])).toBe(1500)
    expect(taxValueFromPct(saved.stages[0].taxCustomPct)).toBe('0.15')
  })

  it('refuses a percent habit, full tax and extra precision instead of encoding another rate', () => {
    for (const typed of ['15', '1', '0.12345', 'abc', '.']) {
      expect(stageTaxOk(custom(taxPctFromValue(typed))), typed).toBe(false)
    }
    expect(stageTaxOk(custom(taxPctFromValue('0.9999')))).toBe(true)
  })
})
