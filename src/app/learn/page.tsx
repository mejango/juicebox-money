import type { Metadata } from 'next'
import { AgentSkillsNote } from '@/components/AgentSkillsNote'
import { ProtocolGuide } from '@/components/ProtocolGuide'

const title = 'Learn Juicebox: payments, tokens, and project rules'
const description =
  'Start with your first payment, understand project tokens and cash outs, and explore Juicebox rules, fees, ownership, and extensions with worked examples.'

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: '/learn' },
  openGraph: {
    title,
    description,
    url: '/learn',
    type: 'website',
    images: [{ url: '/assets/juicebox-social.png', alt: 'Juicebox' }],
  },
  twitter: { card: 'summary_large_image', title, description, images: ['/assets/juicebox-social.png'] },
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
          Understand what happens when you fund a project, what its tokens can do, and which
          rules control the money. Start with the basics, check a project’s terms, or explore
          the protocol in depth. No wallet connection is needed to read this guide.
        </p>
        <nav className="mt-6 grid gap-3 sm:grid-cols-3" aria-label="Choose where to start learning">
          {[
            { href: '#learn-what', title: 'New to Juicebox', text: 'Learn the basics in plain language.' },
            { href: '#learn-before-you-pay', title: 'Ready to participate', text: 'Check terms, tokens, and fees before paying.' },
            { href: '/build', title: 'Ready to build', text: 'Launch a project or connect your app.' },
          ].map(item => (
            <a key={item.href} href={item.href} className="rounded-xl border border-smoke-300 p-4 text-ink transition-colors hover:border-bluebs-600 hover:bg-bluebs-25 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-bluebs-600">
              <span className="block font-agrandir font-medium underline underline-offset-4">{item.title}</span>
              <span className="mt-2 block text-sm leading-relaxed text-smoke-700">{item.text}</span>
            </a>
          ))}
        </nav>
        <AgentSkillsNote className="mt-6 text-sm text-smoke-700" />
      </div>
      <ProtocolGuide guide="learn" />
    </div>
  )
}
