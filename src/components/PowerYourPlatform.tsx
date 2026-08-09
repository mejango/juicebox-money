'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

const PLATFORM_BUILD_PROMPT = `I want to build a product or platform on Juicebox V6.

My product: [describe the users, the value they exchange, and the experience I want].

Act as my protocol engineer and product architect. Start by reading https://juicebox.money/learn and https://juicebox.money/build, then inspect the open-source Juicebox V6 implementation and contracts. Use only current V6 repositories (the protocol repos end in -v6); do not substitute older Juicebox versions.

Design the smallest safe architecture that gives my users a native product experience while Juicebox handles the money layer. Decide whether I need a flexible Juicebox project, an immutable revnet, or both. Map every user action to exact V6 reads and transactions, including payments, token issuance, cash outs, payouts, shops, hooks, permissions, and multichain settlement where relevant.

For each transaction, identify the contract, function, arguments, units, permissions, fees, approvals, slippage or minimum-output protection, and the state that must be re-read immediately before signing. Prefer audited SDK builders and pure transaction builders which round-trip through the ABI. Never ask me to connect a wallet or sign until you have shown me the decoded transaction and explained its effect.

Deliver: (1) a plain-language product flow, (2) the onchain architecture, (3) a threat model and trust assumptions, (4) an incremental implementation plan, (5) test cases and invariants, and (6) the first working vertical slice. Keep the interface branded as my product; treat Juicebox as open infrastructure, not a hosted dependency.`

export function PowerYourPlatform() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(PLATFORM_BUILD_PROMPT)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section aria-labelledby="power-your-platform" className="border-t border-smoke-200 bg-bluebs-25/50">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
          <div>
            <h2
              id="power-your-platform"
              className="font-agrandir-wide text-4xl font-bold leading-tight sm:text-6xl"
            >
              Power your platform<span className="text-split-500">.</span>
            </h2>
            <p className="mt-5 text-base leading-relaxed text-smoke-700 sm:text-lg">
              Build your own interface, marketplace, community, game, or financial product while
              Juicebox supplies the open money layer underneath. Your users get your experience;
              your product gets programmable payments, tokens, treasuries, and cash outs without a
              private financial backend.
            </p>
            <p className="mt-5 text-base leading-relaxed text-smoke-700 sm:text-lg">
              Need rules nobody can rewrite? A{' '}
              <a
                href="https://revnet.money"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
              >
                revnet
              </a>{' '}
              precommits issuance, token splits, and cash-out terms as permanent stages. Use a
              regular project when your platform needs owner-managed rules, or combine the two.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/build" className="btn-primary min-h-11 px-5 text-sm">
                Read the build guide
              </Link>
              <a
                href="https://github.com/Bananapus/version-6"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary min-h-11 px-5 text-sm"
              >
                Inspect the protocol
              </a>
            </div>
          </div>

          <div className="rounded-xl border border-smoke-200 bg-white p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-agrandir text-lg font-medium text-ink">Start with this prompt</p>
                <p className="mt-1 text-xs leading-relaxed text-smoke-600">
                  Fill in the first line, then give it to your coding agent.
                </p>
              </div>
              <button
                type="button"
                onClick={copyPrompt}
                className="btn-secondary min-h-10 px-4 text-xs"
              >
                {copied ? 'Prompt copied' : 'Copy prompt'}
              </button>
            </div>
            <pre className="mt-5 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-smoke-75 p-4 font-mono text-xs leading-6 text-smoke-800">
              {PLATFORM_BUILD_PROMPT}
            </pre>
          </div>
        </div>
      </div>
    </section>
  )
}
