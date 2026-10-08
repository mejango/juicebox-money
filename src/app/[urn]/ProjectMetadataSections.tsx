import type { ComponentProps } from 'react'
import { ResponsiveImage } from '@/components/ResponsiveImage'
import { ChainIcon } from '@/components/ChainIcon'
import { TreasuryCard } from '@/components/TreasuryCard'
import { ProjectLogoWithFallback } from '@/components/ProjectLogoWithFallback'
import { ProjectLink } from '@/components/ProjectLink'
import { AddressLink } from '@/components/ui/AddressLink'
import { OverviewTab } from '@/components/project/OverviewTab'
import { ProjectStats } from '@/components/project/ProjectStats'
import { BackOfficeTab, ExtrasTab } from '@/components/project/LazyProjectTabs'
import type { BsProject } from '@/lib/bendystraw'
import type { ProjectMetadata } from '@/lib/project-server-data'
import type { ResolvedProjectRoute } from '@/lib/project-route.server'
import { formatDate, ipfsUrl, projectLogoUrl } from '@/lib/format'
import { toUrn } from '@/lib/urn'

type MetadataSectionProps = { project: BsProject; metadata: ProjectMetadata | null | Promise<ProjectMetadata | null> }
/** Escaped, hydration-safe fallback while the browser sanitizer initializes. */
function toParagraphs(text: string): string[] {
  return text
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function httpsOnly(url: string | undefined): string | null {
  if (!url) return null;
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const parsed = new URL(withScheme);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Machine-readable identity for search engines and agents, which otherwise have to
 * infer a project from rendered markup.
 */
function ProjectJsonLd({
  name,
  description,
  logoUri,
  path,
  identifier,
}: {
  name: string;
  description: string | null;
  logoUri: string | null | undefined;
  path: string;
  identifier: string;
}) {
  const siteOrigin =
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const logo = projectLogoUrl(logoUri);
  const data = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name,
    url: new URL(path, siteOrigin).href,
    identifier,
    ...(description ? { description } : {}),
    ...(logo
      ? { logo: logo.startsWith("/") ? new URL(logo, siteOrigin).href : logo }
      : {}),
  };
  return (
    <script
      type="application/ld+json"
      // The name and tagline are untrusted project metadata: escaping `<` keeps a
      // crafted value from closing this script tag.
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</gu, "\\u003c"),
      }}
    />
  );
}

function projectMetadataView(project: BsProject, metadata: ProjectMetadata | null) {
  const name =
    metadata?.name?.trim() || project.name || `Project ${project.projectId}`;
  const tagline =
    metadata?.projectTagline?.trim() || project.projectTagline || null;
  const logoUri = metadata?.logoUri?.trim() || project.logoUri;
  const description = metadata?.description?.trim() ?? "";
  const descriptionFallback = description ? toParagraphs(description) : [];
  const infoUri = httpsOnly(metadata?.infoUri);
  const twitterHandle = metadata?.twitter?.replace(/^@/, "").trim();
  const twitter =
    twitterHandle && /^\w{1,15}$/.test(twitterHandle)
      ? `https://x.com/${twitterHandle}`
      : null;
  const igHandle = metadata?.instagram?.replace(/^@/, "").trim();
  const instagram =
    igHandle && /^[\w.]{1,30}$/.test(igHandle)
      ? `https://instagram.com/${igHandle}`
      : null;
  const httpsLink = (value: string | undefined) =>
    value?.startsWith("https://") ? httpsOnly(value) : null;
  const discord = httpsLink(metadata?.discord);
  const telegram = httpsLink(metadata?.telegram);
  const whatsapp = httpsLink(metadata?.whatsapp);
  const coverImage = ipfsUrl(metadata?.coverImageUri ?? null);
  const socialLinks: [string, string | null][] = [
    ["Website", infoUri],
    ["X", twitter],
    ["Discord", discord],
    ["Telegram", telegram],
    ["WhatsApp", whatsapp],
    ["Instagram", instagram],
  ];

  const profile = {
    name: metadata?.name ?? name,
    tagline: metadata?.projectTagline ?? project.projectTagline ?? "",
    description: metadata?.description ?? "",
    infoUri: metadata?.infoUri,
    twitter: metadata?.twitter,
    discord: metadata?.discord,
    telegram: metadata?.telegram,
    whatsapp: metadata?.whatsapp,
    instagram: metadata?.instagram,
  }
  return { name, tagline, logoUri, description, descriptionFallback, socialLinks, coverImage, profile }
}

export async function ProjectHeader({ project, metadata: pending, urn, chains, chainPairs, isRevnet, authority, totalRaisedUsd, paymentsCount }: MetadataSectionProps & {
  urn: ResolvedProjectRoute; chains: BsProject[]; chainPairs: [number, number][];
  isRevnet: boolean; authority: string | null | undefined; totalRaisedUsd: string; paymentsCount: number;
}) {
  const metadata = await pending
  const { name, tagline, logoUri, coverImage } = projectMetadataView(project, metadata)
  return <>
      <ProjectJsonLd
        name={name}
        description={tagline}
        logoUri={logoUri}
        path={
          urn.handle
            ? `/@${encodeURIComponent(urn.handle)}`
            : `/${toUrn(urn.chainId, urn.projectId)}`
        }
        identifier={toUrn(urn.chainId, urn.projectId)}
      />
        {coverImage ? (
          <div className="relative mb-6 h-32 w-full overflow-hidden rounded-xl border border-smoke-200 sm:h-44">
            <ResponsiveImage
              src={coverImage}
              alt=""
              loading="eager"
              fetchPriority="high"
              sizes="(min-width: 1152px) 1104px, (min-width: 640px) calc(100vw - 48px), calc(100vw - 32px)"
              className="absolute inset-0 h-full w-full object-cover"
            />
          </div>
        ) : null}
        {/* Header */}
        <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <ProjectLogoWithFallback
            name={name}
            logoUri={logoUri}
            size={112}
            className="rounded-xl"
          />
          <div className="min-w-0">
            <h1 className="font-agrandir text-3xl font-medium sm:text-4xl">
              {name}
            </h1>
            {tagline ? (
              <p className="mt-1.5 text-base text-smoke-700 sm:text-lg">
                {tagline}
              </p>
            ) : null}
            <ProjectStats
              totalRaisedUsd={totalRaisedUsd}
              raisedByChain={chains.map((row) => ({
                chainId: row.chainId,
                usd: row.volumeUsd || "0",
              }))}
              paymentsCount={paymentsCount}
              suckerGroupId={project.suckerGroupId}
              chains={chainPairs}
              isRevnet={isRevnet}
            />
            <div className="mt-2 text-sm text-smoke-700">
              <div className="space-y-1 md:hidden">
                <div className="flex items-center">
                  <span>
                    <span className="text-smoke-500">Flavor:</span>{" "}
                    <span className="font-medium text-ink">
                      {isRevnet ? "Revnet" : "Project"}
                    </span>
                  </span>
                  {authority ? (
                    <>
                      <span aria-hidden className="mx-2.5 text-smoke-300">
                        |
                      </span>
                      <span>
                        <span className="text-smoke-500">
                          {isRevnet ? "Operator:" : "Owner:"}
                        </span>{" "}
                        <AddressLink
                          showSafe
                          address={authority}
                          chainId={urn.chainId}
                          className="text-smoke-700"
                        />
                      </span>
                    </>
                  ) : null}
                </div>
                <div className="flex items-center">
                  <span>
                    <span className="text-smoke-500">Created:</span>{" "}
                    {formatDate(project.createdAt)}
                  </span>
                  <span aria-hidden className="mx-2.5 text-smoke-300">
                    |
                  </span>
                  <span className="inline-flex items-baseline gap-1.5">
                    <span className="text-smoke-500">On:</span>
                    {chains.map((p) => (
                      <ProjectLink
                        key={p.chainId}
                        href={`/${toUrn(p.chainId, p.projectId)}`}
                        projectHint={{ name, logoUri, tagline }}
                        className="inline-flex translate-y-[2px] transition-opacity hover:opacity-70"
                      >
                        <ChainIcon chainId={p.chainId} standalone />
                      </ProjectLink>
                    ))}
                  </span>
                </div>
              </div>

              <div
                data-project-metadata-inline
                className="hidden items-center whitespace-nowrap md:flex"
              >
                <span>
                  <span className="text-smoke-500">Flavor:</span>{" "}
                  <span className="font-medium text-ink">
                    {isRevnet ? "Revnet" : "Project"}
                  </span>
                </span>
                {authority ? (
                  <>
                    <span aria-hidden className="mx-2.5 text-smoke-300">
                      |
                    </span>
                    <span>
                      <span className="text-smoke-500">
                        {isRevnet ? "Operator:" : "Owner:"}
                      </span>{" "}
                      <AddressLink
                        showSafe
                        address={authority}
                        chainId={urn.chainId}
                        className="text-smoke-700"
                      />
                    </span>
                  </>
                ) : null}
                <span aria-hidden className="mx-2.5 text-smoke-300">
                  |
                </span>
                <span>
                  <span className="text-smoke-500">Created:</span>{" "}
                  {formatDate(project.createdAt)}
                </span>
                <span aria-hidden className="mx-2.5 text-smoke-300">
                  |
                </span>
                <span className="inline-flex items-baseline gap-1.5">
                  <span className="text-smoke-500">On:</span>
                  {chains.map((p) => (
                    <ProjectLink
                      key={p.chainId}
                      href={`/${toUrn(p.chainId, p.projectId)}`}
                      projectHint={{ name, logoUri, tagline }}
                      className="inline-flex translate-y-[2px] transition-opacity hover:opacity-70"
                    >
                      <ChainIcon chainId={p.chainId} standalone />
                    </ProjectLink>
                  ))}
                </span>
              </div>
            </div>
          </div>
        </header>

  </>
}

export async function ProjectTreasury({ project, metadata: pending, ...props }: MetadataSectionProps & Omit<ComponentProps<typeof TreasuryCard>, "projectName" | "payDisclosure">) {
  const metadata = await pending
  const { name } = projectMetadataView(project, metadata)
  return (
    <TreasuryCard
      {...props}
      projectName={name}
      payDisclosure={metadata?.payDisclosure}
    />
  )
}

export async function ProjectOverview({ project, metadata: pending, ...props }: MetadataSectionProps & Omit<ComponentProps<typeof OverviewTab>, "description" | "descriptionFallback" | "socialLinks">) {
  const metadata = await pending
  const { description, descriptionFallback, socialLinks } = projectMetadataView(project, metadata)
  return (
    <OverviewTab {...props} description={description} descriptionFallback={descriptionFallback} socialLinks={socialLinks} />
  )
}

export async function ProjectExtras({ project, metadata: pending, ...props }: MetadataSectionProps & Omit<ComponentProps<typeof ExtrasTab>, "profile">) {
  const metadata = await pending
  const { profile } = projectMetadataView(project, metadata)
  return <ExtrasTab {...props} profile={{ ...profile, payNotice: metadata?.payDisclosure ?? "" }} />
}

export async function ProjectBackOffice({ project, metadata: pending, ...props }: MetadataSectionProps & Omit<ComponentProps<typeof BackOfficeTab>, "profile">) {
  const metadata = await pending
  const { profile } = projectMetadataView(project, metadata)
  return (
    <BackOfficeTab
      {...props}
      profile={{
        ...profile,
        logoUri: metadata?.logoUri ?? project.logoUri ?? null,
        coverImageUri: metadata?.coverImageUri,
        payDisclosure: metadata?.payDisclosure,
      }}
    />
  )
}
