import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import type { Address } from 'viem'
import { ActivityList } from '@/components/ActivityList'
import { ChainIcon } from '@/components/ChainIcon'
import { TreasuryCard } from '@/components/TreasuryCard'
import { ProjectLogo } from '@/components/ProjectLogo'
import { BackOfficeTab } from '@/components/project/BackOfficeTab'
import { ExtrasTab } from '@/components/project/ExtrasTab'
import { FundsTab } from '@/components/project/FundsTab'
import { OverviewTab } from '@/components/project/OverviewTab'
import { OwnersTab } from '@/components/project/OwnersTab'
import { ProjectStats } from '@/components/project/ProjectStats'
import { ProjectTabs } from '@/components/project/Tabs'
import { RulesetsTab } from '@/components/project/RulesetsTab'
import { ShopCartProvider } from '@/components/project/ShopCartProvider'
import { ShopTab } from '@/components/project/ShopTab'
import { TermsTab } from '@/components/project/TermsTab'
import {
  BsActivityEvent,
  BsProject,
  getProject,
  getProjectActivity,
  getRevnetOperator,
  getSuckerGroupProjects,
  resolveProjectDeployments,
} from '@/lib/bendystraw'
import {
  formatDate,
  ipfsUrl,
  truncateAddress,
} from '@/lib/format'
import { parseUrn, toUrn } from '@/lib/urn'

// getProject is a POST, which Next's fetch cache doesn't dedupe — memoize per
// request so generateMetadata + page share one call.
const getProjectCached = cache(getProject)
const getRevnetOperatorCached = cache(getRevnetOperator)

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

/** Escaped, hydration-safe fallback while the browser sanitizer initializes. */
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
  params: Promise<{ urn: string }>
}): Promise<Metadata> {
  // notFound() here (not just in the page) so the 404 status is set before
  // streaming starts — metadata is awaited ahead of the response shell.
  const urn = parseUrn((await params).urn)
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
  params: Promise<{ urn: string }>
}) {
  const urn = parseUrn((await params).urn)
  if (!urn) notFound()

  const project = await getProjectCached(urn.chainId, urn.projectId)
  if (!project) notFound()

  const isRevnet = !!project.isRevnet
  const [metadata, activity, siblings, operator] = await Promise.all([
    fetchProjectMetadata(project.metadataUri),
    project.suckerGroupId
      ? getProjectActivity(project.suckerGroupId, 40, urn.chainId).catch(
          () => [] as BsActivityEvent[],
        )
      : Promise.resolve([] as BsActivityEvent[]),
    project.suckerGroupId
      ? getSuckerGroupProjects(project.suckerGroupId, urn.chainId).catch(
          () => [] as BsProject[],
        )
      : Promise.resolve([] as BsProject[]),
    isRevnet
      ? getRevnetOperatorCached(urn.chainId, urn.projectId)
      : Promise.resolve(null),
  ])

  const name = project.name ?? `Project ${project.projectId}`
  const chains = resolveProjectDeployments(project, siblings)
  const etherscan = JB_CHAINS[urn.chainId]?.etherscanHostname
  const description = metadata?.description?.trim() ?? ''
  const descriptionFallback = description ? toParagraphs(description) : []
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
  const chainPairs: [number, number][] = chains.map(p => [
    p.chainId,
    p.projectId,
  ])

  // The owner (custom) / operator (revnet) can DIFFER per chain, so resolve
  // it for every deployment — custom owners come from bendystraw per sibling,
  // revnet operators from the per-chain permissionHolders query.
  const authorities: [number, string | null][] = isRevnet
    ? await Promise.all(
        chains.map(
          async p =>
            [p.chainId, await getRevnetOperatorCached(p.chainId, p.projectId)] as [
              number,
              string | null,
            ],
        ),
      )
    : chains.map(p => [p.chainId, p.owner] as [number, string | null])
  const authorityDeployments = chains.map(projectOnChain => ({
    chainId: projectOnChain.chainId as JBChainId,
    projectId: projectOnChain.projectId,
    indexedAuthority: (authorities.find(
      ([chainId]) => chainId === projectOnChain.chainId,
    )?.[1] ?? null) as Address | null,
  }))

  const totalRaisedUsd = chains
    .reduce((sum, row) => sum + BigInt(row.volumeUsd || '0'), 0n)
    .toString()

  return (
    <ShopCartProvider>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      {coverImage ? (
        <div className="relative mb-6 h-32 w-full overflow-hidden rounded-xl border border-smoke-200 sm:h-44">
          <Image
            src={coverImage}
            alt=""
            fill
            priority
            sizes="(min-width: 1152px) 1152px, calc(100vw - 2rem)"
            className="object-cover"
          />
        </div>
      ) : null}
      {/* Header */}
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <ProjectLogo
          name={project.name}
          logoUri={project.logoUri}
          size={112}
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
            <span>
              <span className="text-smoke-500">Type:</span>{' '}
              <span className="font-medium text-ink">
                {isRevnet ? 'Revnet' : 'Project'}
              </span>
            </span>
            <span aria-hidden className="mx-2.5 text-smoke-300">
              |
            </span>
            {authority ? (
              <>
                <span>
                  <span className="text-smoke-500">
                    {isRevnet ? 'Operator:' : 'Owner:'}
                  </span>{' '}
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
                <span aria-hidden className="mx-2.5 text-smoke-300">
                  |
                </span>
              </>
            ) : null}
            <span>
              <span className="text-smoke-500">Created:</span>{' '}
              {formatDate(project.createdAt)}
            </span>
            <span aria-hidden className="mx-2.5 text-smoke-300">
              |
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="text-smoke-500">On:</span>
              {chains.map(p => (
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
      <ProjectStats
        totalRaisedUsd={totalRaisedUsd}
        raisedByChain={chains.map(row => ({
          chainId: row.chainId,
          usd: row.volumeUsd || '0',
        }))}
        paymentsCount={project.paymentsCount}
        suckerGroupId={project.suckerGroupId}
        chains={chainPairs}
      />

      {/* Content + pay card */}
      <ProjectTabs
        sidebar={
          <TreasuryCard
            chainId={urn.chainId}
            projectId={project.projectId}
            projectName={name}
            isRevnet={isRevnet}
            chains={chainPairs}
            payDisclosure={metadata?.payDisclosure}
          />
        }
        activity={
          <section className="min-[601px]:mt-8">
            <h2 className="mb-3 hidden font-agrandir text-xl font-medium min-[601px]:block">
              Activity
            </h2>
            <ActivityList
              events={activity}
              chainId={urn.chainId}
              projectId={project.projectId}
            />
          </section>
        }
        tabs={[
              {
                label: 'Overview',
                content: (
                  <OverviewTab
                    chainId={urn.chainId}
                    projectId={project.projectId}
                    description={description}
                    descriptionFallback={descriptionFallback}
                    socialLinks={socialLinks}
                    isRevnet={isRevnet}
                    authority={authority ?? null}
                    authorities={authorities}
                    chains={chainPairs}
                    suckerGroupId={project.suckerGroupId}
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
                        chains={chainPairs}
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
                          chains={chainPairs}
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
                    tokenSymbol={project.tokenSymbol ?? 'tokens'}
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
                    chains={chainPairs}
                  />
                ),
              },
              {
                label: 'Extras',
                content: (
                  <ExtrasTab
                    chainId={urn.chainId}
                    projectId={project.projectId}
                    chains={chainPairs}
                  />
                ),
              },
              {
                label: isRevnet ? 'Operator' : 'Owner',
                content: (
                  <BackOfficeTab
                    chainId={urn.chainId}
                    projectId={project.projectId}
                    isRevnet={isRevnet}
                    owner={project.owner}
                    operator={operator}
                    deployments={authorityDeployments}
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
                        coverImageUri: metadata?.coverImageUri,
                        payDisclosure: metadata?.payDisclosure,
                    }}
                  />
                ),
              },
        ]}
      />
      </div>
    </ShopCartProvider>
  )
}
