'use client'

import { useEffect, useRef, useState } from 'react'
import { PLATFORM_BUILD_PROMPT } from '@/lib/build-prompt'

const SKILLS_URL = 'https://github.com/mejango/juicebox-skills'

/** The one line for readers building with an agent: the prompt to hand it and the skills it
 *  should work from. */
export function CopyBuildPrompt({ className = '' }: { className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  return (
    <p className={className}>
      Building with an agent?{' '}
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(PLATFORM_BUILD_PROMPT)
            setCopied(true)
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 2000)
          } catch {
            setCopied(false)
          }
        }}
        className="font-agrandir font-medium text-bluebs-700 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-800"
      >
        {copied ? 'prompt copied' : 'copy the Juicebox build prompt'}
      </button>
      , and give it the{' '}
      <a
        href={SKILLS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="font-agrandir font-medium text-bluebs-700 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-800"
      >
        Juicebox V6 skills
      </a>{' '}
      so it works from the deployed addresses, ABIs, and fee math rather than from memory.
    </p>
  )
}
