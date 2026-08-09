'use client'

import { useEffect, useRef, useState } from 'react'
import { PLATFORM_BUILD_PROMPT } from '@/lib/build-prompt'

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
        {copied ? 'Build prompt copied' : 'Copy the Juicebox build prompt'}
      </button>
      .
    </p>
  )
}
