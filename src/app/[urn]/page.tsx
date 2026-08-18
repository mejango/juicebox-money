import {
  RevnetCoreContracts,
  jbContractAddress,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { isAddressEqual, type Address } from "viem";
import { ActivityList } from "@/components/ActivityList";
import { ChainIcon } from "@/components/ChainIcon";
import { TreasuryCard } from "@/components/TreasuryCard";
import { ProjectLogoWithFallback } from "@/components/ProjectLogoWithFallback";
import { ProjectLink } from "@/components/ProjectLink";
import { AddressLink } from "@/components/ui/AddressLink";
import { OverviewTab } from "@/components/project/OverviewTab";
import { ProjectStats } from "@/components/project/ProjectStats";
import { ProjectTabs } from "@/components/project/Tabs";
import { ProjectHandleCard } from "@/components/project/ProjectHandleCard";
import { ShopCartProvider } from "@/components/project/ShopCartProvider";
import { ProjectRouteSync } from "@/providers/ProjectRouteContext";
import {
  BackOfficeTab,
  ExtrasTab,
  FundsTab,
  OwnersTab,
  RulesetsTab,
  ShopTab,
  TermsTab,
} from "@/components/project/LazyProjectTabs";
import {
  BsActivityEvent,
  BsProject,
  getProjectActivity,
  getProjectActivityByProject,
  getRevnetOperator,
  getRevnetOperatorCandidates,
  getSuckerGroupProjects,
  projectGroupPaymentsCount,
  resolveProjectDeployments,
  suckerGroupAccountingToken,
} from "@/lib/bendystraw";
import {
  getProjectPageData,
  projectAuthorityMatchesMainnet,
  readLiveProjectAuthorityContext,
  revnetOperatorFromPermissionHistory,
} from "@/lib/project-fallback";
import { projectPreviewSlogan } from "@/lib/project-link-preview";
import { formatDate, ipfsUrl, projectLogoUrl } from "@/lib/format";
import {
  lookupProjectHandleTarget,
  lookupVerifiedProjectHandle,
} from "@/lib/ens";
import {
  decodeProjectRouteSegment,
  projectHandleFromRoute,
  verifyProjectHandleAuthorityWithFallback,
} from "@/lib/project-handles";
import { chainName, legacyHref, parseUrn, toUrn } from "@/lib/urn";
import { SUPPORTED_CHAINS } from "@/lib/chains";

// getProjectPageData is backed by a POST, which Next's fetch cache doesn't
// dedupe — memoize per request so generateMetadata + page share one call.
const getPageDataCached = cache(getProjectPageData);
const getRevnetOperatorCached = cache(getRevnetOperator);
const getRevnetOperatorCandidatesCached = cache(getRevnetOperatorCandidates);

type ResolvedProjectRoute = {
  chainId: JBChainId;
  projectId: number;
  handle: string | null;
  verifiedAuthority: Address | null;
  verifiedIsRevnet: boolean | null;
};

/**
 * Resolve either the normal chain/project URN or the bidirectionally verified
 * `/@handle` form. ENS supplies the forward pointer; JBProjectHandles must
 * independently confirm that the project's current effective authority made
 * the matching reverse claim.
 */
const resolveProjectRouteCached = cache(
  async (segment: string): Promise<ResolvedProjectRoute | null> => {
    // Depending on the Next runtime, a dynamic segment containing `@` can
    // arrive as either `@handle` or `%40handle`. Decode exactly once so a
    // double-encoded input never gains route syntax by accident.
    const decodedSegment = decodeProjectRouteSegment(segment);
    if (!decodedSegment) return null;
    const urn = parseUrn(decodedSegment);
    if (urn) {
      return {
        ...urn,
        handle: null,
        verifiedAuthority: null,
        verifiedIsRevnet: null,
      };
    }

    const requestedHandle = projectHandleFromRoute(decodedSegment);
    if (!requestedHandle) return null;
    const target = await lookupProjectHandleTarget(requestedHandle.handle);
    if (!target) return null;
    if (!SUPPORTED_CHAINS.some((chain) => chain.id === target.chainId)) {
      return null;
    }

    const result = await getPageDataCached(target.chainId, target.projectId);
    if (!result) return null;
    // Bendystraw supplies a candidate only. Live NFT ownership below decides
    // whether this is a revnet, and REVOwner then verifies the candidate.
    const indexedCandidates = await getRevnetOperatorCandidatesCached(
      target.chainId,
      target.projectId,
    ).catch(() => []);
    const initialAuthorityContext = await readLiveProjectAuthorityContext({
      chainId: target.chainId,
      projectId: target.projectId,
      revnetOperatorCandidates: indexedCandidates,
    });
    // Bendystraw is the fast discovery path only. Enumerate authoritative
    // REVOwner-scoped JBPermissions history when no live candidate was found,
    // never when a known live authority simply has a different reverse claim.
    const authorityContext = await verifyProjectHandleAuthorityWithFallback({
      requestedHandle: requestedHandle.handle,
      authorityContext: initialAuthorityContext,
      lookupHandle: setter =>
        lookupVerifiedProjectHandle({
          chainId: target.chainId,
          projectId: target.projectId,
          setter,
        }),
      recoverAuthority: async () => {
        const permissionOperator = await revnetOperatorFromPermissionHistory({
          chainId: target.chainId,
          projectId: target.projectId,
        });
        return permissionOperator
          ? readLiveProjectAuthorityContext({
              chainId: target.chainId,
              projectId: target.projectId,
              revnetOperatorCandidates: [permissionOperator],
            })
          : null;
      },
    });
    if (!authorityContext) return null;
    if (
      !(await projectAuthorityMatchesMainnet({
        chainId: target.chainId,
        authority: authorityContext.authority,
      }))
    ) {
      return null;
    }

    return {
      chainId: target.chainId as JBChainId,
      projectId: target.projectId,
      handle: requestedHandle.handle,
      verifiedAuthority: authorityContext.authority,
      verifiedIsRevnet: authorityContext.isRevnet,
    };
  },
);

type ProjectMetadata = {
  name?: string;
  projectTagline?: string;
  description?: string;
  logoUri?: string;
  coverImageUri?: string;
  payDisclosure?: string;
  infoUri?: string;
  twitter?: string;
  discord?: string;
  telegram?: string;
  whatsapp?: string;
  instagram?: string;
};

async function fetchProjectMetadata(
  metadataUri: string | null,
): Promise<ProjectMetadata | null> {
  const url = ipfsUrl(metadataUri);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    return typeof json === "object" && json !== null
      ? (json as ProjectMetadata)
      : null;
  } catch {
    return null;
  }
}

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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ urn: string }>;
}): Promise<Metadata> {
  // Resolve here (not just in the page) so the redirect/404 status is set
  // before streaming starts — metadata is awaited ahead of the response shell.
  const segment = (await params).urn;
  const urn = await resolveProjectRouteCached(segment);
  // Anything that isn't a V6 project route belongs to the V1–V5 app now
  // serving from old.juicebox.money — hand it the same path.
  if (!urn) redirect(legacyHref(`/${segment}`));
  const result = await getPageDataCached(urn.chainId, urn.projectId);
  if (!result) notFound();
  const project = result.project;
  const projectMetadata = await fetchProjectMetadata(project.metadataUri);
  const name =
    projectMetadata?.name?.trim() ||
    project.name ||
    `Project ${project.projectId}`;
  const tagline = projectPreviewSlogan(
    projectMetadata?.projectTagline,
    projectMetadata?.description,
    project.projectTagline,
  );
  const siteOrigin =
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  // The custom domain is the public name; the Railway host is only the fallback for a
  // preview deployment that has no canonical domain of its own.
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const assetOrigin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (railwayDomain && /^[a-z0-9.-]+$/iu.test(railwayDomain)
      ? `https://${railwayDomain}`
      : siteOrigin);
  const pagePath = urn.handle
    ? `/@${encodeURIComponent(urn.handle)}`
    : `/${toUrn(urn.chainId, urn.projectId)}`;
  const pageUrl = new URL(pagePath, siteOrigin).href;
  const imageUrl = new URL(
    `/api/project-og/${urn.chainId}/${urn.projectId}`,
    assetOrigin,
  ).href;
  const description =
    tagline ?? `Support ${name} on Juicebox — transparent, onchain funding.`;
  return {
    title: name,
    description,
    // The same project answers at /@handle, /<chain>:<id>, and the %40 form. Name one.
    alternates: { canonical: pagePath },
    openGraph: {
      title: `${name} — Juicebox`,
      description,
      url: pageUrl,
      type: "website",
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: `${name} project preview`,
          type: "image/png",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${name} — Juicebox`,
      description,
      images: [imageUrl],
    },
  };
}

/**
 * Reduced project page for the indexer-fallback path: the project provably
 * exists onchain, but indexed stats are unavailable (fresh launch that the
 * indexer hasn't caught up with, or an indexer outage). Renders identity
 * from on-chain metadata with a plain-language notice instead of a 404/500.
 */
async function DegradedProjectShell({
  route,
  project,
  reason,
}: {
  route: ResolvedProjectRoute;
  project: BsProject;
  reason: "not-indexed" | "indexer-error";
}) {
  const metadata = await fetchProjectMetadata(project.metadataUri);
  const name = metadata?.name ?? `Project ${project.projectId}`;
  const canonicalRevOwner = jbContractAddress["6"][
    RevnetCoreContracts.REVOwner
  ]?.[route.chainId] as Address | undefined;
  const projectOwner = project.owner as Address | null;
  const isRevnet =
    route.verifiedIsRevnet ??
    (!!canonicalRevOwner &&
      !!projectOwner &&
      isAddressEqual(projectOwner, canonicalRevOwner));
  const authority =
    route.verifiedAuthority ?? (isRevnet ? null : projectOwner);
  const roleLabel = isRevnet ? "Operator" : "Owner";
  const notice = (
    <div className="rounded-xl border border-smoke-200 bg-smoke-50 p-6 text-sm text-smoke-700">
      {reason === "not-indexed"
        ? "This project exists onchain, but its indexed data isn't available yet — it may have just launched. Stats, activity, and most actions will appear once indexing catches up."
        : "Project stats are temporarily unavailable — the data indexer isn't responding. The project itself is unaffected onchain."}{" "}
      The verified handle editor remains available under {roleLabel}.
    </div>
  );
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <ProjectLogoWithFallback
          name={name}
          logoUri={metadata?.logoUri ?? null}
          size={112}
          className="rounded-xl"
        />
        <div className="min-w-0">
          <h1 className="font-agrandir text-3xl font-medium sm:text-4xl">
            {name}
          </h1>
          {metadata?.projectTagline ? (
            <p className="mt-1.5 text-base text-smoke-700 sm:text-lg">
              {metadata.projectTagline}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center text-sm text-smoke-700">
            {authority ? (
              <>
                <span>
                  <span className="text-smoke-500">{roleLabel}:</span>{" "}
                  <AddressLink
                    address={authority}
                    chainId={route.chainId}
                    className="text-smoke-700"
                  />
                </span>
                <span aria-hidden className="mx-2.5 text-smoke-300">
                  |
                </span>
              </>
            ) : null}
            <span className="inline-flex items-center gap-1.5">
              <span className="text-smoke-500">On:</span>
              <ChainIcon chainId={route.chainId} />
              <span>{chainName(route.chainId)}</span>
            </span>
          </div>
        </div>
      </header>
      <ProjectTabs
        sidebar={null}
        activity={notice}
        tabs={[
          { label: "Overview", content: notice },
          {
            label: roleLabel,
            content: (
              <ProjectHandleCard
                deployment={{
                  chainId: route.chainId,
                  projectId: route.projectId,
                  indexedAuthority: authority,
                }}
                isRevnet={isRevnet}
                revnetOperatorCandidates={
                  isRevnet && route.verifiedAuthority
                    ? [route.verifiedAuthority]
                    : []
                }
              />
            ),
          },
        ]}
      />
    </div>
  );
}

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ urn: string }>;
}) {
  const segment = (await params).urn;
  const urn = await resolveProjectRouteCached(segment);
  if (!urn) redirect(legacyHref(`/${segment}`));

  const result = await getPageDataCached(urn.chainId, urn.projectId);
  if (!result) notFound();
  if (result.degraded) {
    return (
      <>
        <ProjectRouteSync route={urn} />
        <DegradedProjectShell
          route={urn}
          project={result.project}
          reason={result.reason}
        />
      </>
    );
  }
  const project = result.project;

  const isRevnet = urn.verifiedIsRevnet ?? !!project.isRevnet;
  const [metadata, activityResult, siblings, operator] = await Promise.all([
    fetchProjectMetadata(project.metadataUri),
    (project.suckerGroupId
      ? getProjectActivity(project.suckerGroupId, 250, urn.chainId)
      : getProjectActivityByProject(urn.chainId, project.projectId, 250)
    )
      .then(page => ({ events: page.items, total: page.totalCount, error: false }))
      .catch(() => ({ events: [] as BsActivityEvent[], total: 0, error: true })),
    // An indexer failure here used to read as "this project is on one chain": the page
    // rendered fully, but cross-chain stats, per-chain tabs and authorities all silently
    // shrank to the home chain. Carry the failure so the UI can say so instead.
    (project.suckerGroupId
      ? getSuckerGroupProjects(project.suckerGroupId, urn.chainId)
      : Promise.resolve([] as BsProject[])
    )
      .then(projects => ({ projects, error: false }))
      .catch(() => ({ projects: [] as BsProject[], error: true })),
    // `undefined` = the indexer couldn't be read, which is NOT the same claim
    // as "this revnet has no operator" (null). The UI says so rather than
    // hiding the role.
    isRevnet
      ? urn.verifiedIsRevnet && urn.verifiedAuthority
        ? Promise.resolve(urn.verifiedAuthority)
        : getRevnetOperatorCached(urn.chainId, urn.projectId).catch(
            () => undefined,
          )
      : Promise.resolve(null),
  ]);
  const activity = activityResult.events;
  const siblingProjects = siblings.projects;

  const name =
    metadata?.name?.trim() || project.name || `Project ${project.projectId}`;
  const tagline =
    metadata?.projectTagline?.trim() || project.projectTagline || null;
  const logoUri = metadata?.logoUri?.trim() || project.logoUri;
  const chains = resolveProjectDeployments(project, siblingProjects);
  const accountingToken = suckerGroupAccountingToken(chains);
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

  const authority =
    urn.verifiedAuthority ?? (isRevnet ? operator : project.owner);
  const chainPairs: [number, number][] = chains.map((p) => [
    p.chainId,
    p.projectId,
  ]);

  // The owner (custom) / operator (revnet) can DIFFER per chain, so resolve
  // it for every deployment — custom owners come from bendystraw per sibling,
  // revnet operators from the per-chain permissionHolders query.
  const authorities: [number, string | null | undefined][] = isRevnet
    ? await Promise.all(
        chains.map(
          async (p) =>
            [
              p.chainId,
              p.chainId === urn.chainId &&
              p.projectId === urn.projectId &&
              urn.verifiedIsRevnet
                ? urn.verifiedAuthority
                : await getRevnetOperatorCached(p.chainId, p.projectId).catch(
                    () => undefined,
                  ),
            ] as [number, string | null | undefined],
        ),
      )
    : chains.map((p) => [
        p.chainId,
        p.chainId === urn.chainId &&
        p.projectId === urn.projectId &&
        urn.verifiedAuthority
          ? urn.verifiedAuthority
          : p.owner,
      ] as [number, string | null]);
  const authorityDeployments = chains.map((projectOnChain) => ({
    chainId: projectOnChain.chainId as JBChainId,
    projectId: projectOnChain.projectId,
    indexedAuthority: (authorities.find(
      ([chainId]) => chainId === projectOnChain.chainId,
    )?.[1] ?? null) as Address | null,
  }));
  const indexedHandleOperatorCandidates = await getRevnetOperatorCandidatesCached(
    urn.chainId,
    project.projectId,
  ).catch(() => []);
  const handleOperatorCandidates = Array.from(
    new Set([
      ...indexedHandleOperatorCandidates,
      ...(urn.verifiedIsRevnet && urn.verifiedAuthority
        ? [urn.verifiedAuthority]
        : []),
    ].map(candidate => candidate.toLowerCase())),
  );

  const totalRaisedUsd = chains
    .reduce((sum, row) => sum + BigInt(row.volumeUsd || "0"), 0n)
    .toString();
  const paymentsCount = projectGroupPaymentsCount(chains);

  return (
    <ShopCartProvider>
      <ProjectRouteSync route={urn} />
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
            {siblings.error ? (
              // The page otherwise looks complete, so an unannounced failure here reads as
              // "this project is only on one chain" rather than "we couldn't check".
              <p className="mt-2 text-sm text-amber-700">
                Couldn&apos;t load this project&apos;s linked chains. Cross-chain totals and
                per-chain views may be incomplete.
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
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-smoke-500">On:</span>
                    {chains.map((p) => (
                      <ProjectLink
                        key={p.chainId}
                        href={`/${toUrn(p.chainId, p.projectId)}`}
                        projectHint={{ name, logoUri, tagline }}
                        className="transition-opacity hover:opacity-70"
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
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-smoke-500">On:</span>
                  {chains.map((p) => (
                    <ProjectLink
                      key={p.chainId}
                      href={`/${toUrn(p.chainId, p.projectId)}`}
                      projectHint={{ name, logoUri, tagline }}
                      className="transition-opacity hover:opacity-70"
                    >
                      <ChainIcon chainId={p.chainId} standalone />
                    </ProjectLink>
                  ))}
                </span>
              </div>
            </div>
          </div>
        </header>

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
            <section className="min-[801px]:mt-8">
              <ActivityList
                events={activity}
                total={activityResult.total}
                error={activityResult.error}
                chainId={urn.chainId}
                projectId={project.projectId}
                suckerGroupId={project.suckerGroupId}
                accountingToken={accountingToken}
              />
            </section>
          }
          tabs={[
            {
              label: "Overview",
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
                  accountingToken={accountingToken}
                />
              ),
            },
            isRevnet
              ? {
                  label: "Terms",
                  content: (
                    <TermsTab
                      chainId={urn.chainId}
                      projectId={project.projectId}
                    />
                  ),
                }
              : {
                  label: "Rulesets",
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
                    label: "Funds",
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
              label: isRevnet ? "Owners" : "Tokens",
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
              label: "Shop",
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
              label: "Extras",
              content: (
                <ExtrasTab
                  chainId={urn.chainId}
                  projectId={project.projectId}
                  isRevnet={isRevnet}
                  chains={chainPairs}
                  authorities={authorities}
                  profile={{
                    name: metadata?.name ?? name,
                    tagline:
                      metadata?.projectTagline ?? project.projectTagline ?? "",
                    description: metadata?.description ?? "",
                    payNotice: metadata?.payDisclosure ?? "",
                    infoUri: metadata?.infoUri,
                    twitter: metadata?.twitter,
                    discord: metadata?.discord,
                    telegram: metadata?.telegram,
                    whatsapp: metadata?.whatsapp,
                    instagram: metadata?.instagram,
                  }}
                />
              ),
            },
            {
              label: isRevnet ? "Operator" : "Owner",
              content: (
                <BackOfficeTab
                  chainId={urn.chainId}
                  projectId={project.projectId}
                  isRevnet={isRevnet}
                  owner={project.owner}
                  operator={operator ?? null}
                  deployments={authorityDeployments}
                  revnetOperatorCandidates={handleOperatorCandidates as Address[]}
                  profile={{
                    name: metadata?.name ?? name,
                    tagline:
                      metadata?.projectTagline ?? project.projectTagline ?? "",
                    description: metadata?.description ?? "",
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
  );
}
