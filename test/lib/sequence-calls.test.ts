import { describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({ findReviewedSequence: vi.fn(), discardReviewedSequence: vi.fn() }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/preload-review', () => ({ loadReviewEngine: async () => engine, preloadReviewDialog: () => {} }))

import { sequenceCalls } from '@/lib/reviewed-send'

const ALICE = '0x1111111111111111111111111111111111111111'
const SAVED = ['approve', 'pay']
const FRESH = ['pay']
const record = (progress: object) => ({ calls: SAVED, completed: ['0x01'], ...progress })

describe('sequenceCalls', () => {
  it('runs the fresh plan when nothing is saved, and saves no sequence for a lone call', async () => {
    engine.findReviewedSequence.mockReturnValue(null)
    expect(await sequenceCalls('scope', ALICE, FRESH)).toEqual({ calls: FRESH, saved: false })
    expect(await sequenceCalls('scope', ALICE, SAVED)).toEqual({ calls: SAVED, saved: false, scope: 'scope' })
  })

  it('drops a saved run that only completed steps: the fresh plan reads them from the chain', async () => {
    engine.findReviewedSequence.mockReturnValue(record({}))
    engine.discardReviewedSequence.mockResolvedValue(undefined)
    expect(await sequenceCalls('scope', ALICE, FRESH)).toEqual({ calls: FRESH, saved: false })
    expect(engine.discardReviewedSequence).toHaveBeenCalledOnce()
  })

  it('never drops a step sent or proposed: the saved run continues, so a landed payment is never sent again', async () => {
    for (const progress of [{ sending: { step: 1, reservation: 'r' } }, { sending: { step: 1, reservation: 'r' }, proposed: { step: 1, safeTxHash: '0x02' } }]) {
      engine.discardReviewedSequence.mockClear()
      engine.findReviewedSequence.mockReturnValue(record(progress))
      expect(await sequenceCalls('scope', ALICE, FRESH)).toEqual({ calls: SAVED, saved: true, scope: 'scope', held: 1 })
      expect(engine.discardReviewedSequence).not.toHaveBeenCalled()
    }
  })

  it('continues the saved run when another window moved it on before it could be dropped', async () => {
    engine.findReviewedSequence.mockReturnValue(record({}))
    engine.discardReviewedSequence.mockRejectedValue(new Error('moved'))
    expect(await sequenceCalls('scope', ALICE, FRESH)).toEqual({ calls: SAVED, saved: true, scope: 'scope' })
  })
})
