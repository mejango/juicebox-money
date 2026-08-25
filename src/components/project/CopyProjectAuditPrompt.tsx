'use client'

import { useRef, useState } from 'react'
import { projectAuditPrompt } from '@/lib/project-audit-prompt'

/** Copies a project-specific audit prompt for the reader to paste into their AI. */
export function CopyProjectAuditPrompt({ urn }: { urn: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  return (
    <button
      type="button"
      className="btn-secondary min-h-[36px] px-3 text-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(projectAuditPrompt(urn))
          setCopied(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 2000)
        } catch {
          // Clipboard unavailable; leave the label unchanged.
        }
      }}
    >
      {copied ? 'Copied' : 'Copy audit prompt'}
    </button>
  )
}
