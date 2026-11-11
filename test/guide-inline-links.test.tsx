import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { guideRowId, Inline } from '@/components/GuideSections'
import { BUILD_SECTIONS } from '@/lib/build-guide'
import { LEARN_SECTIONS } from '@/lib/learn-guide'

const html = (text: string) => renderToStaticMarkup(createElement(Inline, { text }))

describe('guide inline links', () => {
  it('renders [label](href) as a link and leaves other text alone', () => {
    expect(html('The [SDK](#apps-set-up-the-sdk) reads it.')).toBe(
      'The <a class="guide-inline-link" href="#apps-set-up-the-sdk">SDK</a> reads it.',
    )
    expect(html('Plain [brackets] and (parens).')).toBe('Plain [brackets] and (parens).')
  })

  it('points every in-page link at a section, alias or table row that exists', () => {
    const sections = [...BUILD_SECTIONS, ...LEARN_SECTIONS]
    const ids = new Set(sections.flatMap(s => [
      s.id,
      ...(s.aliases ?? []),
      ...(s.blocks ?? []).flatMap(block =>
        block.type === 'table' && block.rowIdPrefix
          ? block.rows.map(([name]) => guideRowId(block.rowIdPrefix!, name))
          : [],
      ),
    ]))
    const missing = JSON.stringify(sections)
      .match(/\]\(#[^)]+\)/g)
      ?.map(link => link.slice(3, -1))
      .filter(id => !ids.has(id))
    expect(missing ?? []).toEqual([])
  })

  it('never links a Learn section to itself, and links a target once per section', () => {
    for (const section of LEARN_SECTIONS) {
      const targets = JSON.stringify(section).match(/\]\(#[^)]+\)/g) ?? []
      expect(targets, section.id).not.toContain(`](#${section.id})`)
      expect(new Set(targets).size, section.id).toBe(targets.length)
    }
  })

  it('keeps Learn diagrams narrow enough for a phone', () => {
    const widths = LEARN_SECTIONS.flatMap(s => s.blocks ?? [])
      .flatMap(block => (block.type === 'diagram' ? block.lines.map(line => [...line].length) : []))
    expect(Math.max(...widths)).toBeLessThanOrEqual(38)
  })
})
