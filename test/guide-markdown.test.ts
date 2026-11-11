import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GET as getBuild } from '@/app/build.md/route'
import { GET as getLearn } from '@/app/learn.md/route'
import { GuideSections } from '@/components/GuideSections'
import { BUILD_SECTIONS } from '@/lib/build-guide'
import { LEGACY_BUILD_SECTIONS } from '@/lib/build-guide-legacy'
import { guideRowId } from '@/lib/guide-markdown'
import { LEARN_SECTIONS } from '@/lib/learn-guide'

describe.each([
  { name: '/learn.md', get: getLearn, sections: LEARN_SECTIONS },
  { name: '/build.md', get: getBuild, sections: BUILD_SECTIONS },
])('$name', ({ get, sections }) => {
  it('serves every section once, as Markdown with absolute links', async () => {
    const response = get()
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    const text = await response.text()
    for (const section of sections) {
      expect(text.split(`{#${section.id}}`).length - 1, section.id).toBe(1)
    }
    expect(text).not.toMatch(/undefined|\[object Object\]/)
    // Every Markdown link outside code leaves absolute.
    const prose = text.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm, '')
    expect(prose.match(/\]\((?!https?:\/\/)[^)]*\)/g) ?? []).toEqual([])
  })

  it('gives every anchor on the page one owner', () => {
    const ids = sections.flatMap(section => [
      section.id,
      ...(section.aliases ?? []),
      ...(section.blocks ?? []).flatMap(block => [
        ...('label' in block ? [guideRowId(section.id, block.label)] : []),
        ...(block.type === 'table' && block.rowIdPrefix
          ? block.rows.map(([name]) => guideRowId(block.rowIdPrefix!, name))
          : []),
      ]),
    ])
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
  })
})

it('names a language on every guide code block', () => {
  const unnamed = [...LEARN_SECTIONS, ...BUILD_SECTIONS, ...LEGACY_BUILD_SECTIONS]
    .flatMap(section => section.blocks ?? [])
    .flatMap(block => (block.type === 'code' && !block.lang ? [block.label] : []))
  expect(unnamed).toEqual([])
})

it('renders code with its language and a copy button, and tables with a stable self-link', () => {
  const html = renderToStaticMarkup(createElement(GuideSections, { sections: BUILD_SECTIONS, ariaLabel: 'Build' }))
  expect(html).toContain('<code class="language-ts">')
  expect(html).toContain('aria-label="Copy code: Quote, build, and send the payment"')
  expect(html).toContain(
    '<h3 id="apps-accept-payments-helpers" class="guide-prop-title"><a class="guide-prop-title-link" href="#apps-accept-payments-helpers">Helpers</a></h3>',
  )
  expect(html).not.toMatch(/-block-\d/)
  expect(html.match(/<figure class="guide-diagram">.*?<\/figure>/s)?.[0]).not.toContain('guide-code-copy')
})
