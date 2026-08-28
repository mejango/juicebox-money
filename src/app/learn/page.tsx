import type { Metadata } from 'next'
import { pageMetadata } from '@/lib/page-metadata'
import { ProtocolGuide } from '@/components/ProtocolGuide'

const title = 'Learn'
const description =
  'Learn how Juicebox projects, revnets, rulesets, tokens, payouts, cash outs, hooks, and omnichain deployments work.'

export const metadata: Metadata = pageMetadata({ title, description })

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
          Understand how payments, balances, tokens, payouts, cash outs, rulesets, hooks, and
          multichain projects fit together before you participate or launch.
        </p>
      </div>
      <ProtocolGuide guide="learn" />
    </div>
  )
}
