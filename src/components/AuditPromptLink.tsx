'use client'

import { useRef, useState } from 'react'
import { AUDIT_PROMPT } from '@/lib/audit-prompt'

/**
 * "All open source, audit the code with your AI." — the link copies the
 * system audit prompt (ported from website/) to the clipboard so anyone can
 * paste it into their AI and audit the protocol themselves.
 */
export function AuditPromptLink({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  return (
    <p className={className}>
      100% open source,{' '}
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(AUDIT_PROMPT)
            setCopied(true)
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 2000)
          } catch {
            // Clipboard unavailable; leave the label unchanged.
          }
        }}
        className="inline-flex min-h-11 items-center underline decoration-smoke-400 underline-offset-2 hover:text-ink"
      >
        {copied ? 'audit prompt copied to clipboard' : 'audit with your AI'}
      </button>
      .
    </p>
  )
}
