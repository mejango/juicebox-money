import { describe, expect, it } from 'vitest'
import { parseDraft } from '@/lib/draft'

describe('.jb drafts from Juicescan', () => {
  it('names the other site instead of reporting no draft', () => {
    const juicescan = JSON.stringify({ projectType: 'revnet', details: { name: 'X' }, chainIds: [1], stages: [{}] })
    expect(() => parseDraft(juicescan)).toThrow('This draft was saved on Juicescan. Open it there.')
    expect(() => parseDraft('{"a":1}')).toThrow('No Juicebox draft found in that file.')
  })
})
