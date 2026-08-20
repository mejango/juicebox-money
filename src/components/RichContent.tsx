'use client'

import createDOMPurify from 'dompurify'
import { marked } from 'marked'
import { useEffect, useState } from 'react'

import { appIpfsUrl } from '@/lib/format'

const ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'strong',
  'u',
  'ul',
]

const MAX_CONTENT_LENGTH = 50_000
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function safeExternalHref(value: string): boolean {
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

/**
 * Image sources are restricted to absolute https: URLs and ipfs: URIs; the
 * latter resolve through the same app gateway project logos use. Everything
 * else (data:, http:, relative paths) is rejected.
 */
function resolveImageSrc(value: string): string | null {
  if (/^ipfs:\/\//i.test(value)) return appIpfsUrl(value)
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function unwrap(element: Element) {
  element.replaceWith(...element.childNodes)
}

/**
 * Render author-controlled project metadata as markdown, then sanitize it in
 * a real browser DOM. Legacy descriptions stored as HTML still work: marked
 * passes raw HTML blocks through, and the sanitizer gates every tag either
 * way.
 *
 * The policy is shared with the other V6 webclients. The allowlist
 * deliberately excludes embedded content, styles,
 * forms, SVG/MathML, IDs, and all data/ARIA/event attributes. Links must be
 * absolute HTTP(S) or mailto URLs; safe links always open outside the app
 * without receiving an opener or referrer. Images are allowed, but only from
 * https: or ipfs: sources (see resolveImageSrc).
 */
export function sanitizeRichContent(value: string): string {
  if (typeof window === 'undefined') return ''
  const html = marked.parse(value.slice(0, MAX_CONTENT_LENGTH), {
    async: false,
    breaks: true,
  })
  const purifier = createDOMPurify(window)
  const fragment = purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['alt', 'href', 'src', 'title'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|ipfs:)/i,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [
      'audio',
      'button',
      'embed',
      'form',
      'iframe',
      'input',
      'math',
      'object',
      'script',
      'style',
      'svg',
      'template',
      'video',
    ],
    RETURN_DOM_FRAGMENT: true,
    SANITIZE_DOM: true,
    SANITIZE_NAMED_PROPS: true,
  })

  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href')?.trim()
    if (!href || !safeExternalHref(href)) {
      unwrap(link)
      continue
    }
    link.setAttribute('href', href)
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
  }

  for (const image of fragment.querySelectorAll('img')) {
    const src = image.getAttribute('src')?.trim()
    const resolved = src ? resolveImageSrc(src) : null
    if (!resolved) {
      image.remove()
      continue
    }
    image.setAttribute('src', resolved)
    image.setAttribute('loading', 'lazy')
  }

  const container = document.createElement('div')
  container.append(fragment)
  // marked terminates blocks with newlines; drop the insignificant tail.
  return container.innerHTML.trimEnd()
}

/**
 * Hydration-safe rich project content. The server and first client render use
 * already escaped React text; DOMPurify replaces it with the allowlisted HTML
 * only after a browser DOM exists.
 */
export function RichContent({
  html,
  fallback,
  className = '',
}: {
  html: string
  fallback: string[]
  className?: string
}) {
  const [sanitized, setSanitized] = useState<{
    source: string
    html: string
  } | null>(null)
  const sanitizedHtml = sanitized?.source === html ? sanitized.html : null

  useEffect(() => {
    setSanitized({ source: html, html: sanitizeRichContent(html) })
  }, [html])

  if (sanitizedHtml === null) {
    return (
      <div className={className}>
        {fallback.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
    )
  }

  return (
    <div
      className={className}
      // This is the single reviewed HTML boundary. sanitizeRichContent()
      // returns only the explicit allowlist above.
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  )
}
