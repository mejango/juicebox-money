import { JB_CHAINS } from '@bananapus/nana-sdk-core'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { ActivityList } from '@/components/ActivityList'
import { ChainIcon } from '@/components/ChainIcon'
import { OwnerPanel } from '@/components/OwnerPanel'
import { TreasuryCard } from '@/components/TreasuryCard'
import { ProjectLogo } from '@/components/ProjectLogo'
import { ExtrasTab } from '@/components/project/ExtrasTab'
import { FundsTab } from '@/components/project/FundsTab'
import { OverviewTab } from '@/components/project/OverviewTab'
import { OwnersTab } from '@/components/project/OwnersTab'
import { ProjectTabs } from '@/components/project/Tabs'
import { RulesetsTab } from '@/components/project/RulesetsTab'
import { ShopTab } from '@/components/project/ShopTab'
import { TermsTab } from '@/components/project/TermsTab'
import {
  BsActivityEvent,
  BsProject,
  getProject,
  getProjectActivity,
  getRevnetOperator,
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
  name?: string
  projectTagline?: string
  description?: string
  logoUri?: string
  coverImageUri?: string
  payDisclosure?: string
  infoUri?: string
  twitter?: string
  discord?: string
  telegram?: string
  whatsapp?: string
  instagram?: string
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

export default async function ProjectPage({
  params,
}: {
  params: { urn: string }
}) {
  const urn = parseUrn(params.urn)
  if (!urn) notFound()

  const project = await getProjectCached(urn.chainId, urn.projectId)
  if (!project) notFound()

  const isRevnet = !!project.isRevnet
  const [metadata, activity, siblings, operator] = await Promise.all([
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
    isRevnet
      ? getRevnetOperator(urn.chainId, urn.projectId)
      : Promise.resolve(null),
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
  const igHandle = metadata?.instagram?.replace(/^@/, '').trim()
  const instagram = igHandle && /^[\w.]{1,30}$/.test(igHandle)
    ? `https://instagram.com/${igHandle}`
    : null
  const httpsLink = (value: string | undefined) =>
    value?.startsWith('https://') ? httpsOnly(value) : null
  const discord = httpsLink(metadata?.discord)
  const telegram = httpsLink(metadata?.telegram)
  const whatsapp = httpsLink(metadata?.whatsapp)
  const coverImage = ipfsUrl(metadata?.coverImageUri ?? null)
  const socialLinks: [string, string | null][] = [
    ['Website', infoUri],
    ['X', twitter],
    ['Discord', discord],
    ['Telegram', telegram],
    ['WhatsApp', whatsapp],
    ['Instagram', instagram],
  ]

  const authority = isRevnet ? operator : project.owner
  const chainPairs: [number, number][] = (
    chains.length > 0 ? chains : [project]
  ).map(p => [p.chainId, p.projectId])

  const stats: [string, string][] = [
    [`${symbol} raised`, formatTokenAmount(project.volume, decimals)],
    [`${symbol} in treasury`, formatTokenAmount(project.balance, decimals)],
    ['Payments', project.paymentsCount.toLocaleString('en-US')],
    ['Supporters', project.contributorsCount.toLocaleString('en-US')],
  ]

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      {coverImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={coverImage}
          alt=""
          className="mb-6 h-32 w-full rounded-xl border border-smoke-200 object-cover sm:h-44"
        />
      ) : null}
      {/* Header */}
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <ProjectLogo
          name={project.name}
          logoUri={project.logoUri}
          size={88}
          className="rounded-xl"
        />
        <div className="min-w-0">
          <h1 className="font-agrandir text-3xl font-medium sm:text-4xl">
            {name}
          </h1>
          {project.projectTagline ? (
            <p className="mt-1.5 text-base text-smoke-700 sm:text-lg">
              {project.projectTagline}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center text-sm text-smoke-700">
            {isRevnet ? (
              <>
                <span className="font-medium text-ink">Revnet</span>
                <span
                  aria-hidden
                  className="mx-2.5 inline-block h-3.5 w-px rounded-full bg-smoke-300"
                />
              </>
            ) : null}
            {authority ? (
              <>
                <span>
                  {isRevnet ? 'Operated by' : 'Owned by'}{' '}
                  {etherscan ? (
                    <a
                      href={`https://${etherscan}/address/${authority}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-ink hover:underline"
                    >
                      {truncateAddress(authority)}
                    </a>
                  ) : (
                    <span>{truncateAddress(authority)}</span>
                  )}
                </span>
                <span
                  aria-hidden
                  className="mx-2.5 inline-block h-3.5 w-px rounded-full bg-smoke-300"
                />
              </>
            ) : null}
            <span>Since {formatDate(project.createdAt)}</span>
            <span
              aria-hidden
              className="mx-2.5 inline-block h-3.5 w-px rounded-full bg-smoke-300"
            />
            <span className="inline-flex items-center gap-1.5">
              <span>on</span>
              {(chains.length > 1 ? chains : [project]).map(p => (
                <Link
                  key={p.chainId}
                  href={`/${toUrn(p.chainId, p.projectId)}`}
                  className="transition-opacity hover:opacity-70"
                >
                  <ChainIcon chainId={p.chainId} />
                </Link>
              ))}
            </span>
          </div>
        </div>
      </header>

      {/* Stats */}
      <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(([label, value]) => (
          <div
            key={label}
            className="card px-4 py-3.5"
          >
            <dt className="field-label">{label}</dt>
            <dd className="mt-1 font-agrandir text-xl font-medium text-ink sm:text-2xl">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Content + pay card */}
      <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-3 lg:gap-10">
        <aside className="order-1 lg:order-2 lg:col-span-1">
          <TreasuryCard
            chainId={urn.chainId}
            projectId={project.projectId}
            projectName={name}
            accountingToken={project.token}
            accountingTokenSymbol={project.tokenSymbol}
            payDisclosure={metadata?.payDisclosure}
          />
          <section className="mt-8">
            <h2 className="mb-3 font-agrandir text-xl font-medium">
              Activity
            </h2>
            <ActivityList
              events={activity}
              decimals={decimals}
              symbol={symbol}
            />
          </section>
        </aside>

        <div className="order-2 min-w-0 lg:order-1 lg:col-span-2">
          <ProjectTabs
            tabs={[
              {
                label: 'Overview',
                content: (
                  <OverviewTab
                    chainId={urn.chainId}
                    projectId={project.projectId}
                    description={description}
                    socialLinks={socialLinks}
                    isRevnet={isRevnet}
                    authority={authority ?? null}
                    chains={chainPairs}
                    etherscanHost={etherscan}
                  />
                ),
              },
              isRevnet
                ? {
                    label: 'Terms',
                    content: (
                      <TermsTab
                        chainId={urn.chainId}
                        projectId={project.projectId}
                        tokenSymbol=""
                      />
                    ),
                  }
                : {
                    label: 'Rulesets',
                    content: (
                      <RulesetsTab
                        chainId={urn.chainId}
                        projectId={project.projectId}
                      />
                    ),
                  },
              ...(!isRevnet
                ? [
                    {
                      label: 'Funds',
                      content: (
                        <FundsTab
                          chainId={urn.chainId}
                          projectId={project.projectId}
                        />
                      ),
                    },
                  ]
                : []),
              {
                label: isRevnet ? 'Owners' : 'Tokens',
                content: (
                  <OwnersTab
                    chainId={urn.chainId}
                    projectId={project.projectId}
                    isRevnet={isRevnet}
                    suckerGroupId={project.suckerGroupId}
                    chains={chainPairs}
                  />
                ),
              },
              {
                label: 'Shop',
                content: (
                  <ShopTab
                    chainId={urn.chainId}
                    projectId={project.projectId}
                    isRevnet={isRevnet}
                  />
                ),
              },
              {
                label: 'Extras',
                content: (
                  <ExtrasTab
                    chainId={urn.chainId}
                    projectId={project.projectId}
                    isRevnet={isRevnet}
                    profile={{
                      name: metadata?.name ?? name,
                      tagline:
                        metadata?.projectTagline ??
                        project.projectTagline ??
                        '',
                      description: metadata?.description ?? '',
                      logoUri: metadata?.logoUri ?? project.logoUri ?? null,
                      infoUri: metadata?.infoUri,
                      twitter: metadata?.twitter,
                      discord: metadata?.discord,
                      telegram: metadata?.telegram,
                      whatsapp: metadata?.whatsapp,
                      instagram: metadata?.instagram,
                    }}
                    chains={chainPairs}
                  />
                ),
              },
              {
                label: isRevnet ? 'Operator' : 'Owner',
                content: (
                  <div>
                    {isRevnet ? (
                      <p className="mb-5 text-sm leading-relaxed text-smoke-700">
                        Revnets have no owner — the rules are locked in at
                        launch. An operator manages the few controls revnets
                        leave open
                        {authority
                          ? `: ${truncateAddress(authority)}`
                          : '.'}
                      </p>
                    ) : (
                      <p className="mb-5 text-sm leading-relaxed text-smoke-700">
                        The owner&apos;s tools appear here when the owner
                        connects their wallet.
                      </p>
                    )}
                    {/* Renders only for the on-chain owner (client-gated). */}
                    <OwnerPanel
                      chainId={urn.chainId}
                      projectId={project.projectId}
                      initial={{
                        // Prefer the pinned metadata (the truth setUriOf
                        // points at); bendystraw mirrors it but can lag.
                        name: metadata?.name ?? name,
                        tagline:
                          metadata?.projectTagline ??
                          project.projectTagline ??
                          '',
                        description: metadata?.description ?? '',
                        logoUri: metadata?.logoUri ?? project.logoUri ?? null,
                        infoUri: metadata?.infoUri,
                        twitter: metadata?.twitter,
                        discord: metadata?.discord,
                        telegram: metadata?.telegram,
                        whatsapp: metadata?.whatsapp,
                        instagram: metadata?.instagram,
                        coverImageUri: metadata?.coverImageUri,
                        payDisclosure: metadata?.payDisclosure,
                      }}
                    />
                  </div>
                ),
              },
            ]}
          />
        </div>
      </div>
    </div>
  )
}
