import Image from 'next/image'
import Link from 'next/link'
import logoFull from '@/assets/brand/logo-full.svg'

type FooterLink = {
  label: string
  href: string
  external?: boolean
}

const columns: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Juicebox',
    links: [
      { label: 'Create a project', href: '/create' },
      { label: 'Explore', href: '/#trending' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Docs', href: 'https://docs.juicebox.money', external: true },
      {
        label: 'Newsletter',
        href: 'https://juicenews.beehiiv.com',
        external: true,
      },
      {
        label: 'Podcast',
        href: 'https://podcasters.spotify.com/pod/show/thejuicecast',
        external: true,
      },
    ],
  },
  {
    title: 'Socials',
    links: [
      {
        label: 'Discord',
        href: 'https://discord.com/invite/wFTh4QnDzk',
        external: true,
      },
      { label: 'GitHub', href: 'https://github.com/Bananapus', external: true },
      { label: 'Twitter', href: 'https://twitter.com/juiceboxETH', external: true },
    ],
  },
  {
    title: 'Legal',
    links: [
      {
        label: 'Terms of Service',
        href: 'https://docs.juicebox.money/tos',
        external: true,
      },
    ],
  },
]

function FooterAnchor({ link }: { link: FooterLink }) {
  const className =
    'inline-flex min-h-[44px] items-center text-sm text-slate-100 transition-colors hover:text-bluebs-400 sm:min-h-[32px]'

  if (link.external) {
    return (
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {link.label}
      </a>
    )
  }

  return (
    <Link href={link.href} className={className}>
      {link.label}
    </Link>
  )
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.55 9.55 0 0 1 12 6.82a9.6 9.6 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.86v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  )
}

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
      <path d="M19.54 5.34A16.3 16.3 0 0 0 15.44 4l-.5 1.02a15.1 15.1 0 0 0-5.88 0L8.55 4c-1.43.25-2.81.7-4.1 1.34C1.86 9.2 1.16 12.97 1.51 16.7a16.6 16.6 0 0 0 5.03 2.55l1.23-1.69a10.7 10.7 0 0 1-1.92-.92l.47-.36a11.72 11.72 0 0 0 11.36 0l.48.36c-.62.36-1.26.67-1.93.92l1.23 1.69a16.5 16.5 0 0 0 5.03-2.55c.42-4.33-.72-8.06-2.95-11.36ZM8.5 14.47c-1.1 0-2-1-2-2.23s.88-2.24 2-2.24 2.02 1.01 2 2.24c0 1.23-.89 2.23-2 2.23Zm7 0c-1.1 0-2-1-2-2.23S14.38 10 15.5 10s2.02 1.01 2 2.24c0 1.23-.88 2.23-2 2.23Z" />
    </svg>
  )
}

function TwitterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
      <path d="M21.6 5.2c-.7.3-1.5.5-2.3.6a4 4 0 0 0 1.8-2.2c-.8.5-1.7.8-2.5 1a4 4 0 0 0-6.9 2.7c0 .3 0 .6.1.9a11.3 11.3 0 0 1-8.2-4.1A4 4 0 0 0 4.8 9.4a4 4 0 0 1-1.8-.5c0 2 1.4 3.6 3.2 4a4 4 0 0 1-1.8.1 4 4 0 0 0 3.7 2.8A8 8 0 0 1 3.2 17c-.3 0-.6 0-.9-.1a11.3 11.3 0 0 0 6.1 1.8c7.3 0 11.3-6 11.3-11.3v-.5c.8-.5 1.4-1.1 1.9-1.7Z" />
    </svg>
  )
}

const socialLinks = [
  {
    label: 'GitHub',
    href: 'https://github.com/Bananapus',
    icon: <GitHubIcon />,
  },
  {
    label: 'Discord',
    href: 'https://discord.com/invite/wFTh4QnDzk',
    icon: <DiscordIcon />,
  },
  {
    label: 'Twitter',
    href: 'https://twitter.com/juiceboxETH',
    icon: <TwitterIcon />,
  },
]

export function SiteFooter() {
  const version = process.env.NEXT_PUBLIC_VERSION

  return (
    <footer className="border-t border-slate-500 bg-slate-900 px-4 pb-10 pt-12 text-slate-100 sm:px-6 lg:pt-14">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-6 lg:gap-8">
          <div className="sm:col-span-2">
            <Image
              src={logoFull}
              alt="Juicebox"
              width={144}
              height={33}
              className="h-8 w-auto brightness-0 invert"
            />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-200">
              Made with love on Ethereum, by a community of amazing and talented
              contributors.
            </p>
          </div>

          {columns.map(column => (
            <div key={column.title}>
              <h2 className="text-sm font-medium text-slate-200">{column.title}</h2>
              <ul className="mt-2 space-y-0.5">
                {column.links.map(link => (
                  <li key={link.label}>
                    <FooterAnchor link={link} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-5 border-t border-slate-500 pt-5 text-sm text-slate-200 sm:mt-24 sm:flex-row sm:items-center sm:justify-between">
          <span>© Juicebox {new Date().getFullYear()} · All rights reserved</span>
          <div className="flex flex-wrap items-center gap-5">
            {version ? <span>Version #{version.slice(0, 7)}</span> : null}
            <div className="flex items-center gap-1">
              {socialLinks.map(link => (
                <a
                  key={link.label}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={link.label}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-200 transition-colors hover:bg-slate-700 hover:text-bluebs-400"
                >
                  {link.icon}
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
