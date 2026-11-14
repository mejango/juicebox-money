import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// A revnet has no payouts and calls its issuance share a split: the splits row must not send its
// operator to "reserved" recipients or to payout splits.
it('words the splits row for a revnet without reserved tokens or payouts', () => {
  const source = readFileSync('src/components/project/AuthorityEditsCard.tsx', 'utf8')
  expect(source).toMatch(/isRevnet\s*\?\s*'Edit split recipients\.'/)
  expect(source).toMatch(/isRevnet \? 'Edit splits' : 'Edit reserved splits'/)
})
