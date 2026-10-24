import { describe, expect, it } from 'vitest'
import { parseUnits } from 'viem'
import { newDraftSplit, splitOk } from '@/components/create/SplitsEditor'
import { newDraftStage, stageIssuanceOk, stageOk } from '@/components/create/stage-draft'
import { itemOk, newDraftItem } from '@/components/create/store-draft'
import { draftSplitRecipient } from '@/lib/split-recipient'

const address = '0x1111111111111111111111111111111111111111'
const invalid = 'unfinished.eth.invalid'

describe('effective draft validation', () => {
  it('retains an inactive invalid recipient without blocking or dropping the selected split', () => {
    const split = { ...newDraftSplit(), value: '100', recipient: address, perChain: { 10: invalid } }
    expect(splitOk(split, 'percent', [1])).toBe(true)
    expect(draftSplitRecipient(split, 1).beneficiary).toBe(address)
    expect(splitOk(split, 'percent', [1, 10])).toBe(false)
    expect(split.perChain[10]).toBe(invalid)
    const stage = { ...newDraftStage(true), reservedSplits: [split] }
    expect(stageOk(stage, true, 'project', false, [1])).toBe(true)
    expect(stageOk(stage, true, 'project', false, [1, 10])).toBe(false)
    const item = { ...newDraftItem(), name: 'Item', price: '1', splits: [split] }
    expect(itemOk(item, [1])).toBe(true)
    expect(itemOk(item, [1, 10])).toBe(false)
  })

  it('validates effective project and beneficiary overrides, including add-to-balance', () => {
    const split = { ...newDraftSplit(), kind: 'project' as const, value: '100', projectId: '', beneficiary: '',
      perChain: { 1: '2', 10: 'unfinished' }, perChainBeneficiary: { 1: address, 10: invalid } }
    expect(splitOk(split, 'percent', [1])).toBe(true)
    expect(draftSplitRecipient(split, 1)).toMatchObject({ projectId: 2n, beneficiary: address })
    expect(splitOk(split, 'percent', [1, 10])).toBe(false)
    expect(splitOk({ ...split, perChainBeneficiary: {}, preferAddToBalance: true }, 'percent', [1])).toBe(true)
    expect(splitOk({ ...split, perChainBeneficiary: {} }, 'percent', [1])).toBe(false)
  })

  it.each(['1e4', '0x10', '+1', ' 1 ', 'Infinity', 'NaN'])('rejects unsupported issuance syntax %s before encoding', issuanceRate => {
    const stage = { ...newDraftStage(true), issuanceRate }
    expect(stageIssuanceOk(stage, true)).toBe(false)
    expect(stageOk(stage, true)).toBe(false)
  })

  it.each(['0', '10000', '1.25', '.5', '1.', '0.000000000000000001'])('accepts encoder-compatible issuance %s', issuanceRate => {
    expect(stageIssuanceOk({ ...newDraftStage(true), issuanceRate }, true)).toBe(true)
    expect(() => parseUnits(issuanceRate, 18)).not.toThrow()
  })

  it('rejects unsupported numeric syntax in shop prices and effective payout amounts too', () => {
    expect(itemOk({ ...newDraftItem(), name: 'Item', price: '1e4' }, [1])).toBe(false)
    const split = { ...newDraftSplit(), recipient: address, value: '1', perChainAmount: { 10: '1e4' } }
    expect(splitOk(split, 'amount', [1])).toBe(true)
    expect(splitOk(split, 'amount', [1, 10])).toBe(false)
    expect(splitOk({ ...split, value: '1e4', perChainAmount: {} }, 'amount', [1])).toBe(false)
  })

  it('preserves inherited later-stage issuance', () => {
    expect(stageIssuanceOk({ ...newDraftStage(false), issuanceRate: '' }, false)).toBe(true)
    expect(stageIssuanceOk({ ...newDraftStage(true), issuanceRate: '' }, true)).toBe(false)
  })
})
