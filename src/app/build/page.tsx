import type { Metadata } from 'next'
import { AgentSkillsNote } from '@/components/AgentSkillsNote'
import { CopyBuildPrompt } from '@/components/CopyBuildPrompt'
import { ProtocolGuide } from '@/components/ProtocolGuide'

export const metadata: Metadata = {
  title: 'Build',
  description:
    'Build products and platforms on Juicebox with contract references, transaction patterns, hooks, permissions, and implementation guidance.',
}

export default function BuildPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="mb-10 max-w-3xl">
        <p className="font-agrandir text-sm font-medium uppercase tracking-[0.16em] text-bluebs-600">
          Developer guide
        </p>
        <h1 className="mt-2 font-agrandir-wide text-4xl font-bold sm:text-6xl">
          Build on Juicebox<span className="text-split-500">.</span>
        </h1>
        <p className="mt-4 text-base leading-relaxed text-smoke-700 sm:text-lg">
          Start with the experience you want to create. Use this guide to choose the right
          Juicebox building blocks, map each user action to V6 reads and transactions, and ship a
          safe first version.
        </p>
        <CopyBuildPrompt className="mt-6 text-sm text-smoke-700" />
        <AgentSkillsNote className="mt-2 text-sm text-smoke-700" />
      </div>
      <ProtocolGuide guide="build" />
    </div>
  )
}
