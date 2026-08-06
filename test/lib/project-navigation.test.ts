import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearProjectNavigationHints,
  getProjectNavigationHint,
  rememberProjectNavigation,
} from '@/lib/project-navigation'

describe('project navigation hints', () => {
  beforeEach(clearProjectNavigationHints)

  it('reuses a bounded, normalized identity across hash and query variants', () => {
    rememberProjectNavigation('/base:7#activity', {
      name: '  Marquee  ',
      logoUri: ' ipfs://logo ',
      tagline: ' Ready now ',
    })

    expect(getProjectNavigationHint('/base:7?tab=overview')).toEqual({
      name: 'Marquee',
      logoUri: 'ipfs://logo',
      tagline: 'Ready now',
    })
  })

  it('ignores invalid hints', () => {
    rememberProjectNavigation('/base:7', {
      name: '   ',
      logoUri: null,
    })
    expect(getProjectNavigationHint('/base:7')).toBeNull()
  })
})
