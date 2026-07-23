'use client'

import createDOMPurify from 'dompurify'
import { useEffect, useState } from 'react'

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

function unwrap(element: Element) {
  element.replaceWith(...element.childNodes)
}

/**
 * Sanitize author-controlled project metadata in a real browser DOM.
 *
 * The policy is shared with the other V6 webclients. The allowlist
 * deliberately excludes images, embedded content, styles,
 * forms, SVG/MathML, IDs, and all data/ARIA/event attributes. Links must be
 * absolute HTTP(S) or mailto URLs; safe links always open outside the app
 * without receiving an opener or referrer.
 */
export function sanitizeRichContent(value: string): string {
  if (typeof window === 'undefined') return ''
  const purifier = createDOMPurify(window)
  const fragment = purifier.sanitize(value.slice(0, MAX_CONTENT_LENGTH), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [
      'audio',
      'button',
      'embed',
      'form',
      'iframe',
      'img',
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

  const container = document.createElement('div')
  container.append(fragment)
  return container.innerHTML
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
