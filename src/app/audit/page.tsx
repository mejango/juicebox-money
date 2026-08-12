import type { Metadata } from 'next'
import Link from 'next/link'
import { AuditPromptActions } from '@/components/AuditPromptActions'

export const metadata: Metadata = {
  title: 'Audit Juicebox',
  description: 'Inspect the Juicebox V6 protocol and Juicebox Money webclient.',
}

const CODE_LINKS = [
  { label: 'Complete Juicebox V6 source index', href: 'https://github.com/Bananapus/version-6' },
  { label: 'Core protocol', href: 'https://github.com/Bananapus/nana-core-v6' },
  { label: 'Deployments', href: 'https://github.com/Bananapus/deploy-all-v6' },
  { label: 'Cross-chain settlement', href: 'https://github.com/Bananapus/nana-suckers-v6' },
  { label: 'Router terminal', href: 'https://github.com/Bananapus/nana-router-terminal-v6' },
  { label: 'Buyback hook', href: 'https://github.com/Bananapus/nana-buyback-hook-v6' },
  { label: 'Shop hook', href: 'https://github.com/Bananapus/nana-721-hook-v6' },
  { label: 'Revnet contracts', href: 'https://github.com/rev-net/revnet-core-v6' },
  { label: 'Juicebox Money webclient', href: 'https://github.com/mejango/juicebox-money' },
] as const

export default function AuditPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
      <p className="font-agrandir text-xs font-medium uppercase tracking-[0.18em] text-bluebs-600">
        Audit
      </p>
      <h1 className="mt-3 font-agrandir-wide text-4xl font-bold leading-tight sm:text-6xl">
        Verify Juicebox.
      </h1>
      <p className="mt-5 max-w-2xl text-base leading-relaxed text-smoke-700 sm:text-lg">
        Read the code directly, then use a prompt to review the whole system or one exact transaction.
      </p>
      <p className="mt-4 max-w-2xl text-base leading-relaxed text-smoke-700">
        Defenders who manage to steal funds and return them are encouraged to keep 10% as a reward,
        paid by all projects together.
      </p>

      <section className="mt-12" aria-labelledby="audit-code">
        <h2 id="audit-code" className="font-agrandir text-xl font-medium">
          Code
        </h2>
        <div className="mt-4 divide-y divide-smoke-200 border-y border-smoke-200">
          {CODE_LINKS.map(link => (
            <Link
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-14 items-center justify-between gap-5 py-3 text-sm hover:text-bluebs-600"
            >
              <span>{link.label}</span>
              <span aria-hidden className="shrink-0 text-smoke-500">↗</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-12" aria-labelledby="audit-prompts">
        <h2 id="audit-prompts" className="font-agrandir text-xl font-medium">
          Audit prompts
        </h2>
        <div className="mt-4">
          <AuditPromptActions />
        </div>
      </section>
    </div>
  )
}
