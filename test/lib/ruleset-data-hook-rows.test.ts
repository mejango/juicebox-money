import { describe, expect, it } from 'vitest'
import { dataHookRows } from '@/components/project/RulesetsTab'

type Metadata = Parameters<typeof dataHookRows>[0]

describe('ruleset data hook rows', () => {
  it('shows the full hook address and what it is used for', () => {
    const hook = '0x1234567890123456789012345678901234567890'
    const rows = dataHookRows({ dataHook: hook, useDataHookForPay: true, useDataHookForCashOut: false, scopeCashOutsToLocalBalances: true } as unknown as Metadata)
    expect(rows.map(row => [row.label, row.value])).toEqual([
      ['Data hook', hook],
      ['Use data hook for payments', 'Yes'],
      ['Use data hook for cash outs', 'No'],
      ['Cash outs use total surplus', 'No, this chain only'],
    ])
  })
  it('says None for the zero address', () => {
    const rows = dataHookRows({ dataHook: '0x0000000000000000000000000000000000000000', useDataHookForPay: false, useDataHookForCashOut: false, scopeCashOutsToLocalBalances: false } as unknown as Metadata)
    expect(rows[0].value).toBe('None')
    expect(rows[3].value).toBe('Yes')
  })
})
