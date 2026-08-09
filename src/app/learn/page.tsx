import type { Metadata } from 'next'
import { ProtocolGuide } from '@/components/ProtocolGuide'

export const metadata: Metadata = {
  title: 'Learn',
  description:
    'Learn how Juicebox projects, revnets, rulesets, tokens, payouts, cash outs, hooks, and omnichain deployments work.',
}

export default function LearnPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="mb-10 max-w-3xl">
        <p className="font-agrandir text-sm font-medium uppercase tracking-[0.16em] text-bluebs-600">
          Protocol guide
        </p>
        <h1 className="mt-2 font-agrandir-wide text-4xl font-bold sm:text-6xl">
          Learn Juicebox<span className="text-split-500">.</span>
        </h1>
        <p className="mt-4 text-base leading-relaxed text-smoke-700 sm:text-lg">
          The same complete guide published by Juicescan, from the basic payment loop through
          protocol architecture and extensions.
        </p>
      </div>
      <ProtocolGuide guide="learn" />
    </div>
  )
}
