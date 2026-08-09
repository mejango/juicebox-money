import Image from 'next/image'
import logoFull from '@/assets/brand/logo-full.svg'
import { AuditPromptLink } from '@/components/AuditPromptLink'

const termsHref = 'https://docs.juicebox.money/tos'

export function SiteFooter() {
  const version = process.env.NEXT_PUBLIC_VERSION

  return (
    <footer className="border-t border-slate-700 bg-slate-900 px-4 py-9 text-slate-100 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <Image
            src={logoFull}
            alt="Juicebox"
            width={144}
            height={33}
            className="h-8 w-auto brightness-0 invert"
          />

          <div className="max-w-2xl text-sm leading-relaxed text-slate-300 sm:text-right">
            <p>
              Review the{' '}
              <a
                href="https://github.com/Bananapus/version-6"
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-slate-500 underline-offset-2 hover:text-bluebs-400"
              >
                protocol code
              </a>{' '}
              and the{' '}
              <a
                href="https://github.com/mejango/juicebox-money"
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-slate-500 underline-offset-2 hover:text-bluebs-400"
              >
                website code
              </a>
              .
            </p>
            <AuditPromptLink className="mt-1 text-slate-300 [&_button]:text-slate-100 [&_button]:decoration-slate-500 [&_button]:hover:text-bluebs-400" />
            <p className="mt-1">
              <a
                href={termsHref}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-slate-500 underline-offset-2 hover:text-bluebs-400"
              >
                Terms of Service
              </a>
              : Risks are borne entirely by the users of the open source code.
            </p>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-1 border-t border-slate-700 pt-5 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} Juicebox. All rights reserved.</span>
          {version ? <span>Version #{version.slice(0, 7)}</span> : null}
        </div>
      </div>
    </footer>
  )
}
