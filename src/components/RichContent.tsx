'use client'

import { useEffect, useState } from 'react'

/**
 * Hydration-safe rich project content. The server and first client render use
 * already escaped React text; DOMPurify replaces it with the allowlisted HTML
 * only after a browser DOM exists. The sanitizer (marked and DOMPurify) loads
 * with that effect, not with the page.
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
    let live = true
    void import('@/lib/rich-content-sanitize').then(({ sanitizeRichContent }) => {
      if (live) setSanitized({ source: html, html: sanitizeRichContent(html) })
    })
    return () => {
      live = false
    }
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
      // (lib/rich-content-sanitize.ts) returns only its explicit allowlist.
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  )
}
