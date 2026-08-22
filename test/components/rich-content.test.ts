// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { sanitizeRichContent } from '@/components/RichContent'

describe('sanitizeRichContent', () => {
  it('keeps the small formatting allowlist and hardens external links', () => {
    const clean = sanitizeRichContent(
      '<p>Hello <strong>world</strong>.</p>' +
        '<h2>Purpose</h2><pre><code>onchain</code></pre>' +
        '<ul><li>One</li><li>Two</li></ul>' +
        '<a href="https://example.com/path" title="Details" target="_self" rel="opener">Read more</a>',
    )
    const root = document.createElement('div')
    root.innerHTML = clean

    expect(root.querySelector('strong')?.textContent).toBe('world')
    expect(root.querySelector('h2')?.textContent).toBe('Purpose')
    expect(root.querySelector('code')?.textContent).toBe('onchain')
    expect(root.querySelectorAll('li')).toHaveLength(2)
    expect(root.querySelector('a')?.outerHTML).toBe(
      '<a href="https://example.com/path" title="Details" target="_blank" rel="noopener noreferrer">Read more</a>',
    )
  })

  it('removes executable elements, embedded content, styles, and attributes', () => {
    const clean = sanitizeRichContent(
      '<script>globalThis.pwned = true</script>' +
        '<iframe src="https://evil.example"></iframe>' +
        '<svg><a href="javascript:alert(1)">svg</a></svg>' +
        '<img src=x onerror="alert(1)">' +
        '<form><input name="secret"></form>' +
        '<p id="named" style="background:url(javascript:alert(1))" onclick="alert(1)" data-secret="x">Safe text</p>',
    )
    const root = document.createElement('div')
    root.innerHTML = clean

    expect(clean).not.toMatch(
      /script|iframe|svg|img|form|input|onerror|onclick|style=|data-secret|id=/i,
    )
    expect(root.textContent).toContain('Safe text')
    expect(root.querySelector('p')?.attributes).toHaveLength(0)
  })

  it('unwraps executable and non-absolute URLs while preserving their labels', () => {
    const clean = sanitizeRichContent(
      '<a href="javascript:alert(1)">JavaScript</a>' +
        '<a href="data:text/html,pwned">Data</a>' +
        '<a href="/unexpected-relative">Relative</a>' +
        '<a href="mailto:hello@example.com">Email</a>',
    )
    const root = document.createElement('div')
    root.innerHTML = clean

    expect(root.textContent).toBe('JavaScriptDataRelativeEmail')
    expect(root.querySelectorAll('a')).toHaveLength(1)
    expect(root.querySelector('a')).toMatchObject({
      target: '_blank',
      rel: 'noopener noreferrer',
      protocol: 'mailto:',
    })
  })

  it('renders markdown, including images from https and ipfs sources only', () => {
    const clean = sanitizeRichContent(
      '# Purpose\n\nHello **world**.\n\n' +
        '![Roadmap](ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi)\n\n' +
        '![Remote](https://example.com/a.png)\n\n' +
        '![Inline](data:image/png;base64,AAAA)\n\n' +
        '![Insecure](http://example.com/a.png)',
    )
    const root = document.createElement('div')
    root.innerHTML = clean

    expect(root.querySelector('h1')?.textContent).toBe('Purpose')
    expect(root.querySelector('strong')?.textContent).toBe('world')
    const images = [...root.querySelectorAll('img')]
    expect(images.map(image => image.getAttribute('src'))).toEqual([
      'https://juicebox.center/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      'https://example.com/a.png',
    ])
    expect(images.every(image => image.getAttribute('loading') === 'lazy')).toBe(
      true,
    )
  })

  it('caps attacker-controlled input before parsing', () => {
    const clean = sanitizeRichContent(`<p>${'a'.repeat(60_000)}</p>`)
    expect(clean.length).toBeLessThan(51_000)
    expect(clean).toMatch(/^<p>a+/)
  })
})
