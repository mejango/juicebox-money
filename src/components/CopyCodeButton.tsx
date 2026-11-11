'use client'

import { useState, type MouseEvent } from 'react'

/** Copies one guide code block. When the clipboard refuses, it selects the code in place. */
export function CopyCodeButton({ code, label }: { code: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    const shown = event.currentTarget.closest('figure')?.querySelector('code')
    try {
      await navigator.clipboard.writeText(code)
      setStatus('copied')
      setTimeout(() => setStatus(current => (current === 'copied' ? 'idle' : current)), 2000)
    } catch {
      if (shown) window.getSelection()?.selectAllChildren(shown)
      setStatus('failed')
    }
  }

  return (
    <>
      <button type="button" className="guide-code-copy" aria-label={`Copy code: ${label}`} onClick={copy}>
        {status === 'copied' ? 'Copied' : 'Copy'}
      </button>
      <span role="status" aria-atomic="true" className={status === 'failed' ? 'guide-code-copy-status' : 'sr-only'}>
        {status === 'copied'
          ? 'Code copied.'
          : status === 'failed'
            ? 'Your browser blocked the copy. The code is selected: copy it with your keyboard.'
            : ''}
      </span>
    </>
  )
}
