import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Inline } from '@/components/GuideSections'
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

  it('points every in-page link at a section or alias that exists', () => {
    const sections = [...BUILD_SECTIONS, ...LEARN_SECTIONS]
    const ids = new Set(sections.flatMap(s => [s.id, ...(s.aliases ?? [])]))
    const missing = JSON.stringify(sections)
      .match(/\]\(#[^)]+\)/g)
      ?.map(link => link.slice(3, -1))
      .filter(id => !ids.has(id))
    expect(missing ?? []).toEqual([])
  })
})
