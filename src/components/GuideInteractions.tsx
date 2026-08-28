'use client'

import { useEffect } from 'react'

const COPIED_LABEL_MS = 1300
const DEFAULT_COPY_TITLE = 'Copy a link to this section'

/**
 * Behaviour for the server-rendered protocol guide: one delegated click
 * listener on the guide container drives both the per-section copy-link
 * buttons and the table-of-contents smooth scrolling, plus the
 * scroll-to-hash-on-mount the guide has always had.
 */
export function GuideInteractions({ containerId }: { containerId: string }) {
  useEffect(() => {
    const container = document.getElementById(containerId)
    if (!container) return

    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

    const flashCopied = (button: HTMLElement) => {
      button.classList.add('guide-copy-link--ok')
      button.title = 'Copied'
      const pending = timers.get(button)
      if (pending) clearTimeout(pending)
      timers.set(
        button,
        setTimeout(() => {
          button.classList.remove('guide-copy-link--ok')
          button.title = DEFAULT_COPY_TITLE
          timers.delete(button)
        }, COPIED_LABEL_MS),
      )
    }

    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return

      const copyButton = event.target.closest<HTMLElement>('.guide-copy-link')
      if (copyButton && container.contains(copyButton)) {
        event.preventDefault()
        event.stopPropagation()
        const sectionId = copyButton.closest('.guide-section')?.id
        if (!sectionId) return
        const url = `${location.origin}${location.pathname}${location.search}#${sectionId}`
        const done = () => flashCopied(copyButton)
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(url).then(done, done)
        } else {
          try {
            const textarea = document.createElement('textarea')
            textarea.value = url
            document.body.appendChild(textarea)
            textarea.select()
            document.execCommand('copy')
            document.body.removeChild(textarea)
          } catch {
            // Clipboard is best-effort; still show the confirmation.
          }
          done()
        }
        return
      }

      const tocLink = event.target.closest<HTMLAnchorElement>('.guide-toc-link')
      if (tocLink && container.contains(tocLink)) {
        event.preventDefault()
        const targetId = tocLink.getAttribute('href')?.slice(1)
        const target = targetId ? document.getElementById(targetId) : null
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }

    container.addEventListener('click', onClick)

    const hashTarget = window.location.hash
      ? document.getElementById(window.location.hash.slice(1))
      : null
    hashTarget?.scrollIntoView({ block: 'start' })

    return () => {
      container.removeEventListener('click', onClick)
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
    }
  }, [containerId])

  return null
}
