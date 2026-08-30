import type { Metadata } from 'next'
import { pageMetadata } from '@/lib/page-metadata'
import { CopyBuildPrompt } from '@/components/CopyBuildPrompt'
import { GuideSections } from '@/components/GuideSections'
import { BUILD_SECTIONS } from '@/lib/build-guide'

const title = 'Build'
const description =
  'Build products and platforms on Juicebox with contract references, transaction patterns, hooks, permissions, and implementation guidance.'

export const metadata: Metadata = pageMetadata({ title, description })

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
          Launch and run a project from this site, connect an app to Juicebox with the SDK and the
          indexer, or extend the protocol with your own contracts. Each section is tagged with who
          it is for, and every section links to the source it came from.
        </p>
        <CopyBuildPrompt className="mt-6 text-sm text-smoke-700" />
      </div>
      <GuideSections sections={BUILD_SECTIONS} ariaLabel="Build with Juicebox" />
    </div>
  )
}
