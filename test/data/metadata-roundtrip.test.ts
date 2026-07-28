import { describe, expect, it } from 'vitest'
import {
  customMetadataProperties,
  customPropertiesText,
  mergeProjectMetadata,
  parseCustomProperties,
  preservedMetadataKeys,
} from '@/lib/project-metadata'

// The data-loss class this guards against (U-P2-10): the metadata editor
// rebuilding projectUri JSON from only the fields it knows about, silently
// dropping tags and custom fields (e.g. a project's `leagueID`).
const existing = {
  name: 'Old name',
  description: 'What we do',
  tags: ['games', 'league'],
  leagueID: 42,
  extensions: { scoreboard: { url: 'https://scores.example', live: true } },
  coverImageUri: 'ipfs://QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR',
  payDisclosure: 'Existing notice',
}

describe('mergeProjectMetadata', () => {
  it('keeps tags, custom fields, and nested unknown objects through a name-only edit', () => {
    const merged = mergeProjectMetadata(existing, {
      name: 'New name',
      description: 'What we do',
      payDisclosure: 'Existing notice',
    })

    expect(merged.name).toBe('New name')
    expect(merged.tags).toEqual(['games', 'league'])
    expect(merged.leagueID).toBe(42)
    expect(merged.extensions).toEqual({
      scoreboard: { url: 'https://scores.example', live: true },
    })
    expect(merged.coverImageUri).toBe(existing.coverImageUri)
    expect(merged.payDisclosure).toBe('Existing notice')
  })

  it('clears a field the editor blanked, but never touches omitted fields', () => {
    const merged = mergeProjectMetadata(existing, {
      name: 'Old name',
      description: '',
      payDisclosure: '',
    })

    expect(merged).not.toHaveProperty('description')
    expect(merged).not.toHaveProperty('payDisclosure')
    // Fields the editor did not submit at all round-trip untouched.
    expect(merged.tags).toEqual(['games', 'league'])
    expect(merged.leagueID).toBe(42)
  })

  it('sets a payment notice on metadata that never had one', () => {
    const merged = mergeProjectMetadata(
      { name: 'P', leagueID: 7 },
      { name: 'P', payDisclosure: 'Payments are donations.' },
    )
    expect(merged.payDisclosure).toBe('Payments are donations.')
    expect(merged.leagueID).toBe(7)
  })

  it('works without any existing metadata', () => {
    expect(mergeProjectMetadata(null, { name: 'Fresh' })).toEqual({
      name: 'Fresh',
    })
  })
})

describe('preservedMetadataKeys', () => {
  it('lists the recognized fields the editor keeps but never edits, sorted', () => {
    expect(preservedMetadataKeys(existing)).toEqual(['coverImageUri', 'tags'])
  })

  it('is empty when everything present is editor-owned, or with no metadata', () => {
    expect(
      preservedMetadataKeys({ name: 'P', description: 'D', twitter: 'x' }),
    ).toEqual([])
    expect(preservedMetadataKeys(null)).toEqual([])
  })

  it('does not list custom properties — the Advanced editor owns those', () => {
    expect(preservedMetadataKeys({ leagueID: 42 })).toEqual([])
  })
})

describe('customMetadataProperties', () => {
  it('is every key outside the fields the form manages', () => {
    expect(customMetadataProperties(existing)).toEqual({
      leagueID: 42,
      extensions: { scoreboard: { url: 'https://scores.example', live: true } },
    })
  })

  it('is empty for metadata written only through our own sites', () => {
    expect(
      customMetadataProperties({
        name: 'P',
        description: 'D',
        tags: ['x'],
        coverImageUri: 'ipfs://Qm',
      }),
    ).toEqual({})
    expect(customMetadataProperties(null)).toEqual({})
  })
})

describe('customPropertiesText', () => {
  it('pretty-prints the custom properties so they round-trip through the box', () => {
    const text = customPropertiesText(existing)
    expect(text).toBe(
      JSON.stringify(
        {
          leagueID: 42,
          extensions: {
            scoreboard: { url: 'https://scores.example', live: true },
          },
        },
        null,
        2,
      ),
    )
    const parsed = parseCustomProperties(text)
    expect(parsed.ok && parsed.properties).toEqual(
      customMetadataProperties(existing),
    )
  })

  it('is blank when there are no custom properties', () => {
    expect(customPropertiesText({ name: 'P' })).toBe('')
    expect(customPropertiesText(null)).toBe('')
  })
})

describe('parseCustomProperties', () => {
  it('accepts a blank box as no custom properties', () => {
    const parsed = parseCustomProperties('   \n ')
    expect(parsed).toEqual({ ok: true, properties: {}, collisions: [] })
  })

  it('rejects invalid JSON', () => {
    const parsed = parseCustomProperties('{ "leagueID": }')
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.error).toMatch(/valid JSON/i)
  })

  it('rejects arrays, scalars, and null — custom properties are an object', () => {
    for (const text of ['[1,2]', '42', '"hello"', 'null']) {
      const parsed = parseCustomProperties(text)
      expect(parsed.ok, text).toBe(false)
      expect(!parsed.ok && parsed.error).toMatch(/JSON object/i)
    }
  })

  it('strips keys the form manages and reports them as collisions', () => {
    const parsed = parseCustomProperties(
      '{"name":"Sneaky","tags":["a"],"leagueID":7}',
    )
    expect(parsed.ok && parsed.properties).toEqual({ leagueID: 7 })
    expect(parsed.ok && parsed.collisions).toEqual(['name', 'tags'])
  })
})

describe('mergeProjectMetadata with custom properties', () => {
  it('leaves custom properties untouched when the box was not edited', () => {
    const merged = mergeProjectMetadata(existing, { name: 'New name' })
    expect(merged.leagueID).toBe(42)
    expect(merged.extensions).toBeDefined()
  })

  it('replaces the custom-property set: edits, adds, and deletes land', () => {
    const merged = mergeProjectMetadata(
      existing,
      { name: 'New name' },
      { leagueID: 43, seasonId: 'winter' },
    )
    expect(merged.leagueID).toBe(43)
    expect(merged.seasonId).toBe('winter')
    // `extensions` was dropped from the box, so it is deleted on-chain.
    expect(merged).not.toHaveProperty('extensions')
    // Recognized fields the form keeps are never up for deletion here.
    expect(merged.tags).toEqual(['games', 'league'])
    expect(merged.coverImageUri).toBe(existing.coverImageUri)
    expect(merged.name).toBe('New name')
  })

  it('clears every custom property when the box was emptied', () => {
    const merged = mergeProjectMetadata(existing, { name: 'New name' }, {})
    expect(merged).not.toHaveProperty('leagueID')
    expect(merged).not.toHaveProperty('extensions')
    expect(merged.tags).toEqual(['games', 'league'])
    expect(merged.name).toBe('New name')
  })

  it('never lets a custom property overwrite a field the form manages', () => {
    const merged = mergeProjectMetadata(
      existing,
      { name: 'Form name', description: 'Form description' },
      {
        name: 'Custom name',
        description: 'Custom description',
        tags: ['hijack'],
        leagueID: 1,
      } as Record<string, unknown>,
    )
    expect(merged.name).toBe('Form name')
    expect(merged.description).toBe('Form description')
    expect(merged.tags).toEqual(['games', 'league'])
    expect(merged.leagueID).toBe(1)
  })
})
