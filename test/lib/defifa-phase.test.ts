import { describe, expect, it } from 'vitest'
import { defifaPhaseLabel } from '@/lib/defifa-phase'
describe('Defifa protocol phase display', () => {
  it('names the six actual protocol enum phases without application-specific stages', () => {
    expect([0, 1, 2, 3, 4, 5].map(defifaPhaseLabel)).toEqual(['Countdown', 'Mint', 'Refund', 'Scoring', 'Complete', 'No contest'])
  })
  it('keeps unavailable or invalid phase evidence unknown', () => {
    for (const phase of [undefined, -1, 6, 1.5, NaN, Infinity]) expect(defifaPhaseLabel(phase)).toBe('Unavailable')
  })
})
