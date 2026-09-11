import type { Metadata } from 'next'
import Link from 'next/link'
import { CopyBuildPrompt } from '@/components/CopyBuildPrompt'
import { GuideSections } from '@/components/GuideSections'
import { BUILD_SECTIONS } from '@/lib/build-guide'

const title = 'Build on Juicebox: projects, apps, and contracts'
const description =
  'Launch a project without code, build an app, or write contracts. Start with a working example, then find the details you need.'

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: '/build' },
  openGraph: {
    title,
    description,
    url: '/build',
    type: 'website',
    images: [{ url: '/assets/juicebox-social.png', alt: 'Juicebox' }],
  },
  twitter: { card: 'summary_large_image', title, description, images: ['/assets/juicebox-social.png'] },
}

export default function BuildPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="mb-10 max-w-3xl">
        <p className="font-agrandir text-sm font-medium uppercase tracking-[0.16em] text-bluebs-600">
          Build guide
        </p>
        <h1 className="mt-2 font-agrandir-wide text-4xl font-bold sm:text-6xl">
          Build on Juicebox<span className="text-split-500">.</span>
        </h1>
        <p className="mt-4 text-base leading-relaxed text-smoke-700 sm:text-lg">
          Launch a project, build an app, or write contracts. Choose a path to get started.
        </p>
        <p className="mt-4 text-base leading-relaxed text-smoke-700">
          New to building? Start with{' '}
          <Link href="/build/first-payment" className="text-bluebs-700 underline underline-offset-4">
            Your first test payment
          </Link>
          : read a project, preview a payment, and check what happened.
        </p>
        <nav className="mt-6 grid gap-3 sm:grid-cols-3" aria-label="Choose your Juicebox building path">
          {[
            { href: '#founders-launch-from-the-wizard', title: 'Launch a project', text: 'Set your terms and manage funds. No code needed.' },
            { href: '/build/first-payment', title: 'Build an app', text: 'Read a test project, preview a payment, and check the result.' },
            { href: '#contracts-install-and-launch', title: 'Write contracts', text: 'Add your own behavior to payments, tokens, and project rules.' },
          ].map(item => (
            <a key={item.href} href={item.href} className="rounded-xl border border-smoke-300 p-4 text-ink transition-colors hover:border-bluebs-600 hover:bg-bluebs-25 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-bluebs-600">
              <span className="block font-agrandir font-medium underline underline-offset-4">{item.title}</span>
              <span className="mt-2 block text-sm leading-relaxed text-smoke-700">{item.text}</span>
            </a>
          ))}
        </nav>
        <CopyBuildPrompt className="mt-6 text-sm text-smoke-700" />
      </div>
      <GuideSections sections={BUILD_SECTIONS} ariaLabel="Build with Juicebox" />
    </div>
  )
}
