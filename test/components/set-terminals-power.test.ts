// `JBDirectory.setTerminalsOf` REPLACES the whole terminal list. The owner form took a
// single address prefilled with the standard terminal, so using it as shipped dropped the
// any-token router terminal jbm's own launches register alongside it — payments and fee
// routing through the router stop working with nothing on screen saying so.
import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  POWERS,
  initialFieldValue,
  parseAddressList,
} from '@/lib/projectPowers'

const TERMINAL = '0x1111111111111111111111111111111111111111' as Address
const ROUTER = '0x2222222222222222222222222222222222222222' as Address

const setTerminals = POWERS.find(power => power.flag === 'allowSetTerminals')!
const field = setTerminals.fields[0]

describe('set terminals power', () => {
  it('takes the full list and encodes every entry', () => {
    expect(setTerminals.fields).toHaveLength(1)
    expect(field.kind).toBe('addressList')
    expect(setTerminals.buildArgs(45n, { terminals: [TERMINAL, ROUTER] })).toEqual([
      45n,
      [TERMINAL, ROUTER],
    ])
  })

  it('says the list is replaced wholesale', () => {
    expect(setTerminals.danger).toMatch(/REPLACES the entire terminal list/)
  })

  it('prefills from the live on-chain list', () => {
    expect(
      initialFieldValue(
        field,
        { chainId: 8453, controller: null, terminals: [TERMINAL, ROUTER] },
        undefined,
      ),
    ).toBe(`${TERMINAL}\n${ROUTER}`)
  })

  it('prefills nothing when the live list could not be read', () => {
    // A one-entry fallback here is exactly the bug: it would look like a complete
    // list while silently dropping whatever else the project has registered.
    expect(
      initialFieldValue(
        field,
        { chainId: 8453, controller: null, terminals: null },
        undefined,
      ),
    ).toBe('')
  })
})

describe('address-list parsing', () => {
  it('accepts newline- and comma-separated entries and dedupes them', () => {
    expect(parseAddressList(`${TERMINAL}\n${ROUTER}`)).toEqual([TERMINAL, ROUTER])
    expect(parseAddressList(` ${TERMINAL} , ${ROUTER} `)).toEqual([TERMINAL, ROUTER])
    expect(parseAddressList(`${TERMINAL}\n${TERMINAL}`)).toEqual([TERMINAL])
  })

  it('rejects an empty or partly-invalid list instead of dropping entries', () => {
    expect(parseAddressList('')).toBeNull()
    expect(parseAddressList('   \n ')).toBeNull()
    expect(parseAddressList(`${TERMINAL}\nnot-an-address`)).toBeNull()
  })
})
