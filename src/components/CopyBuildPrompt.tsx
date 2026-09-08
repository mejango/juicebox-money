'use client'

import { useState } from 'react'
import { PLATFORM_BUILD_PROMPT } from '@/lib/build-prompt'

const SKILLS_URL = 'https://github.com/mejango/juicebox-skills'

export function CopyBuildPrompt({ className = '' }: { className?: string }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')

  async function copy() {
    setStatus('copying')
    try {
      await navigator.clipboard.writeText(PLATFORM_BUILD_PROMPT)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }

  return (
    <details className={className}>
      <summary className="min-h-11 py-3 font-agrandir font-medium text-bluebs-700">
        Build with an AI assistant
      </summary>
      <p className="mt-2 leading-relaxed">
        Describe your product in the prompt below, then give your assistant the{' '}
        <a
          href={SKILLS_URL}
          className="font-medium text-bluebs-700 underline underline-offset-4 hover:text-bluebs-800"
        >
          Juicebox V6 skills
        </a>{' '}
        for contract addresses, interfaces, and fee calculations. Review its proposed transactions
        against the current contracts before signing.
      </p>
      <button
        type="button"
        onClick={copy}
        disabled={status === 'copying'}
        className="btn-secondary mt-3 min-h-11 max-w-full whitespace-normal px-4 py-2 text-left"
      >
        {status === 'copying' ? 'Copying…' : 'Copy the Juicebox build prompt'}
      </button>
      <p role="status" aria-atomic="true" className="mt-2 text-sm leading-relaxed">
        {status === 'copied'
          ? 'Prompt copied. Paste it into your assistant and describe your product.'
          : status === 'failed'
            ? 'Copy was blocked by your browser. Select and copy the prompt below.'
            : ''}
      </p>
      <details className="mt-2" open={status === 'failed' ? true : undefined}>
        <summary className="min-h-11 py-3 text-bluebs-700 underline underline-offset-4">
          Read or manually copy the prompt
        </summary>
        <label htmlFor="juicebox-build-prompt" className="mb-2 block font-medium">
          Juicebox build prompt
        </label>
        <textarea
          id="juicebox-build-prompt"
          readOnly
          value={PLATFORM_BUILD_PROMPT}
          rows={10}
          spellCheck={false}
          className="block w-full rounded-lg border border-smoke-300 bg-white p-3 text-sm leading-relaxed text-ink"
        />
      </details>
    </details>
  )
}
