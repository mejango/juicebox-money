import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/components/create/CreateForm.tsx', 'utf8')

/**
 * `allowAnyToken` and `linkChains` are real launch shape, carried by every .jb
 * draft. The wizard is not renderable under this suite, so pin the three places
 * a literal would quietly re-detach the file from the calldata: the plan
 * builder, the draft writer, and the importer that restores form state.
 */
describe('create flow draft levers', () => {
  it('never hardcodes either lever in the plan builder or the draft writer', () => {
    expect(source).not.toMatch(/allowAnyToken:\s*(true|false)/)
    expect(source).not.toMatch(/linkChains:\s*(true|false)/)
  })

  it('restores both levers from an imported draft', () => {
    expect(source).toContain('setAllowAnyToken(draft.allowAnyToken)')
    expect(source).toContain('setLinkChains(draft.linkChains)')
  })

  it('offers a control for each lever the encoder honors', () => {
    // A value the wizard shows must be a value the wizard can set — otherwise
    // an imported draft strands the user on a configuration with no way back.
    expect(source).toContain('setAllowAnyToken((on) => !on)')
    expect(source).toContain('setLinkChains((on) => !on)')
  })

  it('presents any-token routing separately from accounting-token choices', () => {
    expect(source.indexOf('field-label">Accounting')).toBeLessThan(
      source.indexOf('field-label">Payment routing'),
    )
    expect(source).toMatch(
      /This does not change the\s+accounting tokens held in your project&apos;s balance\./,
    )
  })

  it('keeps draft utilities directly above the wizard steps', () => {
    expect(source.indexOf('Import .jb')).toBeLessThan(
      source.indexOf('aria-label="Create steps"'),
    )
  })
})
