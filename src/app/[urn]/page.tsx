import {
  RevnetCoreContracts,
  jbContractAddress,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { cache, Suspense } from "react";
import { isAddressEqual, type Address } from "viem";
import { ActionRowsSkeleton, ActivityRows, OverviewTabSkeleton, ProjectHeaderSkeleton, ProjectPayPanelSkeleton, ProjectPageSkeleton } from "@/components/LoadingSkeletons";
import { ProjectHeader, ProjectTreasury, ProjectOverview, ProjectExtras, ProjectBackOffice } from "@/app/[urn]/ProjectMetadataSections";
import { ProjectActivity } from "@/app/[urn]/ProjectActivity";
import { PendingPayments } from "@/components/project/PendingPayments";
import { ChainIcon } from "@/components/ChainIcon";
import { ProjectLogoWithFallback } from "@/components/ProjectLogoWithFallback";
import { AddressLink } from "@/components/ui/AddressLink";
import { ProjectDataStatus } from "@/components/project/ProjectDataStatus";
import { ProjectTabs } from "@/components/project/Tabs";
import { ProjectHandleCard } from "@/components/project/ProjectHandleCard";
import { SafeBatchProvider } from "@/components/project/SafeBatchProvider";
import { ShopCartProvider } from "@/components/project/ShopCartProvider";
import { ProjectRouteBoundary } from "@/providers/ProjectRouteContext";
import {
  FundsTab,
  OwnersTab,
  RulesetsTab,
  ShopTab,
  TermsTab,
} from "@/components/project/LazyProjectTabs";
import {
  BsProject,
  getRevnetOperatorCandidates,
  projectGroupPaymentsCount,
  projectGroupIsIncomplete,
  resolveProjectDeployments,
  suckerGroupAccountingToken,
} from "@/lib/bendystraw";
import { getProjectPageData as getPageDataCached, getIndexedProjectDisplay, getProjectSiblings, getProjectMetadata as fetchProjectMetadata } from "@/lib/project-server-data";
import type { ProjectPageData } from "@/lib/project-fallback";
import {
  getProjectLinkPreview,
  previewVersion,
  projectPreviewSlogan,
} from "@/lib/project-link-preview";
import {
  lookupVerifiedProjectHandle,
} from "@/lib/ens";
import {
  canonicalHandleOf,
} from "@/lib/project-handles";
import { chainName, legacyHref, toUrn } from "@/lib/urn";
import { resolveProjectRouteCached, projectRouteSnapshot, type ResolvedProjectRoute } from "@/lib/project-route.server";

const IS_DETERMINISTIC_BROWSER =
  process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === "true";

const getRevnetOperatorCandidatesCached = cache(getRevnetOperatorCandidates);
const getRevnetOperatorCached = cache(async (chainId: number, projectId: number) =>
  (await getRevnetOperatorCandidatesCached(chainId, projectId))[0] ?? null,
);

/**
 * The verified handle names the PROJECT, so it is the canonical URL for every
 * route that reaches it — each chain's URN and the handle itself. The registry
 * keys handles by (chainId, projectId), so every deployment in the group is
 * checked; the authority (owner, or operator for revnets) is the only trusted
 * setter, and a handle counts only when its own route resolves back to its
 * deployment. Cached across requests: one registry read outage or slow read
 * must not tax every page render.
 */
const lookupCanonicalHandleCached = cache(
  unstable_cache(
    async (chainId: number, projectId: number): Promise<string | null> => {
      const result = await getPageDataCached(chainId, projectId);
      if (!result || result.degraded) return null;
      const project = result.project;
      const authority = project.isRevnet
        ? await getRevnetOperatorCached(chainId, projectId).catch(() => null)
        : (project.owner as Address | null);
      if (!authority) return null;
      const deployments: [number, number][] = [[chainId, projectId]];
      if (project.suckerGroupId) {
        const siblings = await getProjectSiblings(
          chainId,
          projectId,
          project.suckerGroupId,
        ).catch(() => [] as BsProject[]);
        for (const sibling of siblings) {
          if (
            !deployments.some(
              ([chain, id]) =>
                chain === sibling.chainId && id === sibling.projectId,
            )
          ) {
            deployments.push([sibling.chainId, sibling.projectId]);
          }
        }
      }
      return canonicalHandleOf({
        deployments,
        readHandle: (chainId, projectId) =>
          lookupVerifiedProjectHandle({
            chainId,
            projectId,
            setter: authority as Address,
          }),
        resolveHandle: handle =>
          resolveProjectRouteCached(`@${encodeURIComponent(handle)}`),
      });
    },
    ["project-canonical-handle"],
    { revalidate: 900 },
  ),
);


export async function generateMetadata({
  params,
}: {
  params: Promise<{ urn: string }>;
}): Promise<Metadata> {
  // Resolve here as well as in the page so metadata preserves the same
  // redirect/404 identity decisions when Next streams metadata separately.
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
  // The handle is always canonical when present, no matter which of the
  // project's URLs — /@handle or any chain's URN — served this render.
  const canonicalHandle =
    urn.handle ??
    (IS_DETERMINISTIC_BROWSER
      ? null
      : await lookupCanonicalHandleCached(urn.chainId, urn.projectId).catch(
          () => null,
        ));
  const pagePath = canonicalHandle
    ? `/@${encodeURIComponent(canonicalHandle)}`
    : `/${toUrn(urn.chainId, urn.projectId)}`;
  const pageUrl = new URL(pagePath, siteOrigin).href;
  // Scrapers cache og:image by URL, so bake the numbers into it: the card refreshes
  // whenever the balance or payment count moves.
  const preview = await getProjectLinkPreview(urn.chainId, urn.projectId).catch(() => null);
  const imageUrl = new URL(
    `/api/project-og/${urn.chainId}/${urn.projectId}?v=${previewVersion(preview)}`,
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
 * exists onchain, but indexed stats are unavailable. Renders identity
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
      The verified handle editor remains available under {roleLabel}.
    </div>
  );
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <ProjectLogoWithFallback
          name={name}
          logoUri={metadata?.logoUri ?? null}
          size={144}
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
                    showSafe
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
      <ProjectDataStatus deployments={[{ chainId: route.chainId, projectId: route.projectId, version: project.version, operator: authority, suckerGroupId: project.suckerGroupId }]} notice={reason} />
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
  // Process-local display cache hits must never turn this route into a static
  // response whose lifetime outlasts the bounded data reads.
  await connection();
  const segment = (await params).urn;
  const urn = await resolveProjectRouteCached(segment);
  if (!urn) redirect(legacyHref(`/${segment}`));

  const pending = getPageDataCached(urn.chainId, urn.projectId);
  // An indexed identity can paint while the current onchain metadata pointer
  // is reconciled. Missing/error identities retain the original fallback/404 path.
  const indexed = await getIndexedProjectDisplay(urn.chainId, urn.projectId).catch(() => null);
  if (!indexed) {
    const result = await pending;
    if (!result) notFound();
    return (
      <ProjectRouteBoundary snapshot={projectRouteSnapshot(urn)}>
        <ProjectPageContents urn={urn} result={result} />
      </ProjectRouteBoundary>
    );
  }
  return (
    <ProjectRouteBoundary snapshot={projectRouteSnapshot(urn)}>
    <Suspense fallback={<ProjectPageSkeleton hint={{
      name: indexed.name?.trim() || `Project ${indexed.projectId}`,
      logoUri: indexed.logoUri,
      tagline: indexed.projectTagline,
    }} />}>
      <ProjectPageContents urn={urn} result={pending} />
    </Suspense>
    </ProjectRouteBoundary>
  );
}

async function ProjectPageContents({ urn, result: pending }: {
  urn: ResolvedProjectRoute;
  result: ProjectPageData | null | Promise<ProjectPageData | null>;
}) {
  const result = await pending;
  if (!result) notFound();
  if (result.degraded) {
    return (
        <DegradedProjectShell
          route={urn}
          project={result.project}
          reason={result.reason}
        />
    );
  }
  const project = result.project;

  const isRevnet = urn.verifiedIsRevnet ?? !!project.isRevnet;
  const metadata = fetchProjectMetadata(project.metadataUri);
  const [siblings, operator] = await Promise.all([
    // An indexer failure here used to read as "this project is on one chain": the page
    // rendered fully, but cross-chain stats, per-chain tabs and authorities all silently
    // shrank to the home chain. Carry the failure so the UI can say so instead.
    (project.suckerGroupId
      ? getProjectSiblings(urn.chainId, project.projectId, project.suckerGroupId)
      : Promise.resolve([] as BsProject[])
    )
      .then(projects => ({ projects, error: projectGroupIsIncomplete(project, projects) }))
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
  const siblingProjects = siblings.projects;

  const chains = resolveProjectDeployments(project, siblingProjects);
  const accountingToken = suckerGroupAccountingToken(chains);

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
  const diagnosticDeployments = chains.map(row => ({
    chainId: row.chainId,
    projectId: row.projectId,
    version: row.version,
    suckerGroupId: row.suckerGroupId,
    operator: authorities.find(([id]) => id === row.chainId)?.[1],
  }));
  const indexedHandleOperatorCandidates = isRevnet ? await getRevnetOperatorCandidatesCached(
    urn.chainId,
    project.projectId,
  ).catch(() => []) : [];
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
    <SafeBatchProvider deployments={authorityDeployments} isRevnet={isRevnet}>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <Suspense fallback={<ProjectHeaderSkeleton hint={{ name: project.name?.trim() || `Project ${project.projectId}`, logoUri: project.logoUri, tagline: project.projectTagline }} />}>
        <ProjectHeader project={project} metadata={metadata} urn={urn} chains={chains} chainPairs={chainPairs} isRevnet={isRevnet} authority={authority} totalRaisedUsd={totalRaisedUsd} paymentsCount={paymentsCount} />
        </Suspense>
        {siblings.error || operator === undefined ? (
          <ProjectDataStatus deployments={diagnosticDeployments} notice="partial" />
        ) : null}

        {/* Content + pay card */}
        <ProjectTabs
          sidebar={
            <Suspense fallback={<div role="status" aria-label="Loading payment details"><ProjectPayPanelSkeleton /></div>}>
              <ProjectTreasury project={project} metadata={metadata}
              chainId={urn.chainId}
              projectId={project.projectId}
              isRevnet={isRevnet}
              chains={chainPairs}
              />
            </Suspense>
          }
          activity={
            <section className="min-[801px]:mt-8">
              <PendingPayments key={`${urn.chainId}:${project.projectId}:${chainPairs.join(';')}`} chainId={urn.chainId} projectId={project.projectId} chains={chainPairs} />
              <Suspense fallback={<div role="status" aria-label="Loading activity"><ActivityRows /></div>}>
              <ProjectActivity
                chainId={urn.chainId}
                projectId={project.projectId}
                suckerGroupId={project.suckerGroupId}
                accountingToken={accountingToken}
                isRevnet={isRevnet}
                deployments={diagnosticDeployments}
              />
              </Suspense>
            </section>
          }
          tabs={[
            {
              label: "Overview",
              content: (
                <Suspense fallback={<div role="status" aria-label="Loading overview"><OverviewTabSkeleton /></div>}>
                  <ProjectOverview project={project} metadata={metadata}
                  chainId={urn.chainId}
                  projectId={project.projectId}
                  isRevnet={isRevnet}
                  authority={authority ?? null}
                  authorities={authorities}
                  chains={chainPairs}
                  suckerGroupId={project.suckerGroupId}
                />
                </Suspense>
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
                <Suspense fallback={<ActionRowsSkeleton label="Loading extras" />}>
                  <ProjectExtras project={project} metadata={metadata}
                  chainId={urn.chainId}
                  projectId={project.projectId}
                  isRevnet={isRevnet}
                  chains={chainPairs}
                  authorities={authorities}
                  deploymentCheck={<ProjectDataStatus deployments={diagnosticDeployments} />}
                />
                </Suspense>
              ),
            },
            {
              label: isRevnet ? "Operator" : "Owner",
              content: (
                <Suspense fallback={<ActionRowsSkeleton label="Loading back office" />}>
                  <ProjectBackOffice project={project} metadata={metadata} suckerGroupId={project.suckerGroupId}
                  chainId={urn.chainId}
                  projectId={project.projectId}
                  isRevnet={isRevnet}
                  owner={project.owner}
                  operator={operator ?? null}
                  deployments={authorityDeployments}
                  revnetOperatorCandidates={handleOperatorCandidates as Address[]}
                />
                </Suspense>
              ),
            },
          ]}
        />
      </div>
    </SafeBatchProvider>
    </ShopCartProvider>
  );
}
