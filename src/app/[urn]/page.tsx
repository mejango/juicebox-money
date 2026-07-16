import { JB_CHAINS } from '@bananapus/nana-sdk-core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { ActivityList } from '@/components/ActivityList'
import { ChainBadge } from '@/components/ChainBadge'
import { TreasuryCard } from '@/components/TreasuryCard'
import { ProjectLogo } from '@/components/ProjectLogo'
import {
  BsActivityEvent,
  BsProject,
  getProject,
  getProjectActivity,
  getSuckerGroupProjects,
} from '@/lib/bendystraw'
import {
  formatDate,
  formatTokenAmount,
  ipfsUrl,
  truncateAddress,
} from '@/lib/format'
import { chainName, parseUrn, toUrn } from '@/lib/urn'

// getProject is a POST, which Next's fetch cache doesn't dedupe — memoize per
// request so generateMetadata + page share one call.
const getProjectCached = cache(getProject)

type ProjectMetadata = {
  description?: string
  infoUri?: string
  twitter?: string
  discord?: string
}

async function fetchProjectMetadata(
  metadataUri: string | null,
): Promise<ProjectMetadata | null> {
  const url = ipfsUrl(metadataUri)
  if (!url) return null
  try {
    const res = await fetch(url, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as unknown
    return typeof json === 'object' && json !== null
      ? (json as ProjectMetadata)
      : null
  } catch {
    return null
  }
}

/** Metadata descriptions may be raw HTML; render them as plain paragraphs. */
function toParagraphs(text: string): string[] {
  return text
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .split(/\n+/)
    .map(p => p.trim())
    .filter(Boolean)
    .slice(0, 40)
}

function httpsOnly(url: string | undefined): string | null {
  if (!url) return null
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`
  try {
    const parsed = new URL(withScheme)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : null
  } catch {
    return null
  }
}

export async function generateMetadata({
  params,
}: {
  params: { urn: string }
}): Promise<Metadata> {
  // notFound() here (not just in the page) so the 404 status is set before
  // streaming starts — metadata is awaited ahead of the response shell.
  const urn = parseUrn(params.urn)
  if (!urn) notFound()
  const project = await getProjectCached(urn.chainId, urn.projectId)
  if (!project) notFound()
  const name = project.name ?? `Project ${project.projectId}`
  return {
    title: name,
    description:
      project.projectTagline ??
      `Support ${name} on Juicebox — transparent, onchain funding.`,
    openGraph: {
      title: `${name} — Juicebox`,
      description: project.projectTagline ?? undefined,
    },
  }
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="btn-pixel min-h-[36px] px-3.5 text-[11px]"
    >
      {label}
    </a>
  )
}

export default async function ProjectPage({
  params,
}: {
  params: { urn: string }
}) {
  const urn = parseUrn(params.urn)
  if (!urn) notFound()

  const project = await getProjectCached(urn.chainId, urn.projectId)
  if (!project) notFound()

  const [metadata, activity, siblings] = await Promise.all([
    fetchProjectMetadata(project.metadataUri),
    project.suckerGroupId
      ? getProjectActivity(project.suckerGroupId, 40).catch(
          () => [] as BsActivityEvent[],
        )
      : Promise.resolve([] as BsActivityEvent[]),
    project.suckerGroupId
      ? getSuckerGroupProjects(project.suckerGroupId).catch(
          () => [] as BsProject[],
        )
      : Promise.resolve([] as BsProject[]),
  ])

  const name = project.name ?? `Project ${project.projectId}`
  const decimals = project.decimals ?? 18
  const symbol = project.tokenSymbol ?? 'ETH'
  const chains = [...siblings].sort((a, b) => a.chainId - b.chainId)
  const etherscan = JB_CHAINS[urn.chainId]?.etherscanHostname
  const description = metadata?.description
    ? toParagraphs(metadata.description)
    : []
  const infoUri = httpsOnly(metadata?.infoUri)
  const twitterHandle = metadata?.twitter?.replace(/^@/, '').trim()
  const twitter = twitterHandle && /^\w{1,15}$/.test(twitterHandle)
    ? `https://x.com/${twitterHandle}`
    : null
  const discord = metadata?.discord?.startsWith('https://')
    ? httpsOnly(metadata.discord)
    : null

  const stats: [string, string][] = [
    [`${symbol} raised`, formatTokenAmount(project.volume, decimals)],
    [`${symbol} in treasury`, formatTokenAmount(project.balance, decimals)],
    ['Payments', project.paymentsCount.toLocaleString('en-US')],
    ['Supporters', project.contributorsCount.toLocaleString('en-US')],
  ]

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      {/* Header */}
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <ProjectLogo
          name={project.name}
          logoUri={project.logoUri}
          size={88}
          className="rounded-md"
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-display text-3xl font-extrabold tracking-[-0.03em] sm:text-4xl">
              {name}
            </h1>
            <ChainBadge chainId={project.chainId} full />
          </div>
          {project.projectTagline ? (
            <p className="mt-1.5 text-base text-dim sm:text-lg">
              {project.projectTagline}
            </p>
          ) : null}
          <p className="mt-2 text-sm text-dim/80">
            {project.owner ? (
              <>
                Owned by{' '}
                {etherscan ? (
                  <a
                    href={`https://${etherscan}/address/${project.owner}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-ink hover:underline"
                  >
                    {truncateAddress(project.owner)}
                  </a>
                ) : (
                  <span>
                    {truncateAddress(project.owner)}
                  </span>
                )}
                {' · '}
              </>
            ) : null}
            Since {formatDate(project.createdAt)}
          </p>
        </div>
      </header>

      {/* Chain selector */}
      {chains.length > 1 ? (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="silk-label">Also on</span>
          {chains.map(p =>
            p.chainId === project.chainId ? (
              <span
                key={p.chainId}
                className="chip !px-3 !py-1.5 bg-juice !text-[11px] text-bg"
              >
                {chainName(p.chainId)}
              </span>
            ) : (
              <Link
                key={p.chainId}
                href={`/${toUrn(p.chainId, p.projectId)}`}
                className="chip !px-3 !py-1.5 bg-frame !text-[11px] text-ink transition-colors hover:bg-panel2"
              >
                {chainName(p.chainId)}
              </Link>
            ),
          )}
        </div>
      ) : null}

      {/* Stats */}
      <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(([label, value]) => (
          <div
            key={label}
            className="panel px-4 py-3.5"
          >
            <dt className="silk-label">{label}</dt>
            <dd className="mt-1 text-xl font-extrabold tracking-tight text-juice sm:text-2xl">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Content + pay card */}
      <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-3 lg:gap-10">
        <aside className="order-1 lg:order-2 lg:col-span-1">
          <div className="lg:sticky lg:top-24">
            <TreasuryCard
              chainId={urn.chainId}
              projectId={project.projectId}
              projectName={name}
              accountingToken={project.token}
              accountingTokenSymbol={project.tokenSymbol}
            />
          </div>
        </aside>

        <div className="order-2 min-w-0 lg:order-1 lg:col-span-2">
          {description.length > 0 || infoUri || twitter || discord ? (
            <section>
              <h2 className="mb-3 font-display text-xl font-extrabold tracking-[-0.02em]">
                About
              </h2>
              {description.length > 0 ? (
                <div className="panel space-y-3 p-5 text-sm leading-relaxed text-ink/90">
                  {description.map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              ) : null}
              {infoUri || twitter || discord ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {infoUri ? (
                    <ExternalLink href={infoUri} label="Website" />
                  ) : null}
                  {twitter ? <ExternalLink href={twitter} label="X" /> : null}
                  {discord ? (
                    <ExternalLink href={discord} label="Discord" />
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          <section
            className={
              description.length > 0 || infoUri || twitter || discord
                ? 'mt-10'
                : ''
            }
          >
            <h2 className="mb-3 font-display text-xl font-extrabold tracking-[-0.02em]">
              Activity
            </h2>
            <ActivityList
              events={activity}
              decimals={decimals}
              symbol={symbol}
            />
          </section>
        </div>
      </div>
    </div>
  )
}
