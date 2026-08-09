'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { PLATFORM_BUILD_PROMPT } from '@/lib/build-prompt'

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
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <div>
            <h2
              id="power-your-platform"
              className="font-agrandir-wide text-4xl font-bold leading-tight sm:text-6xl"
            >
              Power your platform<span className="text-split-500">.</span>
            </h2>
            <p className="mt-5 text-base leading-relaxed text-smoke-700 sm:text-lg">
              Build your own interface, marketplace, community, game, or financial product. The
              Juicebox protocol supplies the &apos;pay&apos; and &apos;cash out&apos; functions
              underneath, and everything in between. Your users get your experience; your product
              gets programmable payments, tokens, treasuries, and cash outs with a public financial
              backend.
            </p>
            <p className="mt-5 text-base leading-relaxed text-smoke-700 sm:text-lg">
              Juicebox is the protocol, not one prescribed product. Platforms can give the same
              open contracts completely different interfaces, communities, and business models.
              They can use owner-managed projects, permanently precommitted revnets, or both.
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

          <div>
            <div className="rounded-xl border border-smoke-200 bg-white p-5 sm:p-6">
              <p className="font-agrandir text-xl font-medium text-ink">
                Platforms powered by Juicebox
              </p>
              <div className="mt-5 space-y-4">
                <article className="rounded-lg border border-smoke-200 bg-smoke-25 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link
                      href="/"
                      className="font-agrandir text-lg font-medium text-bluebs-700 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-800"
                    >
                      Juicebox Money
                    </Link>
                    <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-smoke-500">
                      General purpose
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-smoke-700">
                    This website is itself a platform built on the Juicebox protocol: a broad
                    interface for creating, funding, operating, and exploring projects.
                  </p>
                </article>

                <article className="rounded-lg border border-smoke-200 bg-smoke-25 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <a
                      href="https://revnet.money"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-agrandir text-lg font-medium text-bluebs-700 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-800"
                    >
                      Revnet
                    </a>
                    <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-smoke-500">
                      Precommitted networks
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-smoke-700">
                    Revnet is a platform built on Juicebox for launching investible networks whose
                    issuance, token splits, backing, and cash-out terms unfold through transparent,
                    permanent stages instead of owner-rewritable rules.
                  </p>
                </article>
              </div>
              <p className="mt-5 text-xs leading-relaxed text-smoke-600">
                This is a living list. As more platforms emerge and prove useful, safe, and
                legitimate in practice, we&apos;ll add them here. Want to build yours?{' '}
                <button
                  type="button"
                  onClick={copyPrompt}
                  className="font-medium text-bluebs-700 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-800"
                >
                  {copied ? 'Build prompt copied' : 'Copy the build prompt'}
                </button>
                , fill in its first line, and give it to your coding agent.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
