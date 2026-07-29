import { JB_CHAINS, type JBChainId } from "@bananapus/nana-sdk-core";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Address } from "viem";
import { ActivityList } from "@/components/ActivityList";
import { ChainIcon } from "@/components/ChainIcon";
import { TreasuryCard } from "@/components/TreasuryCard";
import { ProjectLogo } from "@/components/ProjectLogo";
import { AddressLink } from "@/components/ui/AddressLink";
import { OverviewTab } from "@/components/project/OverviewTab";
import { ProjectStats } from "@/components/project/ProjectStats";
import { ProjectTabs } from "@/components/project/Tabs";
import { ShopCartProvider } from "@/components/project/ShopCartProvider";
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
  getRevnetOperator,
  getSuckerGroupProjects,
  projectGroupPaymentsCount,
  resolveProjectDeployments,
  suckerGroupAccountingToken,
} from "@/lib/bendystraw";
import { getProjectPageData } from "@/lib/project-fallback";
import { formatDate, ipfsUrl } from "@/lib/format";
import { chainName, parseUrn, toUrn } from "@/lib/urn";

// getProjectPageData is backed by a POST, which Next's fetch cache doesn't
// dedupe — memoize per request so generateMetadata + page share one call.
const getPageDataCached = cache(getProjectPageData);
const getRevnetOperatorCached = cache(getRevnetOperator);

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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ urn: string }>;
}): Promise<Metadata> {
  // notFound() here (not just in the page) so the 404 status is set before
  // streaming starts — metadata is awaited ahead of the response shell.
  const urn = parseUrn((await params).urn);
  if (!urn) notFound();
  const result = await getPageDataCached(urn.chainId, urn.projectId);
  if (!result) notFound();
  const project = result.project;
  const name = project.name ?? `Project ${project.projectId}`;
  return {
    title: name,
    description:
      project.projectTagline ??
      `Support ${name} on Juicebox — transparent, onchain funding.`,
    openGraph: {
      title: `${name} — Juicebox`,
      description: project.projectTagline ?? undefined,
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
  urnChainId,
  project,
  reason,
}: {
  urnChainId: JBChainId;
  project: BsProject;
  reason: "not-indexed" | "indexer-error";
}) {
  const metadata = await fetchProjectMetadata(project.metadataUri);
  const name = metadata?.name ?? `Project ${project.projectId}`;
  const etherscan = JB_CHAINS[urnChainId]?.etherscanHostname;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <ProjectLogo
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
            {project.owner ? (
              <>
                <span>
                  <span className="text-smoke-500">Project owner:</span>{" "}
                  <AddressLink
                    address={project.owner}
                    host={etherscan}
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
              <ChainIcon chainId={urnChainId} />
              <span>{chainName(urnChainId)}</span>
            </span>
          </div>
        </div>
      </header>
      <div className="mt-8 rounded-xl border border-smoke-200 bg-smoke-50 p-6 text-sm text-smoke-700">
        {reason === "not-indexed"
          ? "This project exists onchain, but its indexed data isn't available yet — it may have just launched. Stats, activity, and actions will appear once indexing catches up."
          : "Project stats are temporarily unavailable — the data indexer isn't responding. The project itself is unaffected onchain."}{" "}
        Refresh in a few minutes.
      </div>
    </div>
  );
}

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ urn: string }>;
}) {
  const urn = parseUrn((await params).urn);
  if (!urn) notFound();

  const result = await getPageDataCached(urn.chainId, urn.projectId);
  if (!result) notFound();
  if (result.degraded) {
    return (
      <DegradedProjectShell
        urnChainId={urn.chainId}
        project={result.project}
        reason={result.reason}
      />
    );
  }
  const project = result.project;

  const isRevnet = !!project.isRevnet;
  const [metadata, activity, siblings, operator] = await Promise.all([
    fetchProjectMetadata(project.metadataUri),
    project.suckerGroupId
      ? getProjectActivity(project.suckerGroupId, 100, urn.chainId).catch(
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
  ]);

  const name = project.name ?? `Project ${project.projectId}`;
  const chains = resolveProjectDeployments(project, siblings);
  const accountingToken = suckerGroupAccountingToken(chains);
  const etherscan = JB_CHAINS[urn.chainId]?.etherscanHostname;
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

  const authority = isRevnet ? operator : project.owner;
  const chainPairs: [number, number][] = chains.map((p) => [
    p.chainId,
    p.projectId,
  ]);

  // The owner (custom) / operator (revnet) can DIFFER per chain, so resolve
  // it for every deployment — custom owners come from bendystraw per sibling,
  // revnet operators from the per-chain permissionHolders query.
  const authorities: [number, string | null][] = isRevnet
    ? await Promise.all(
        chains.map(
          async (p) =>
            [
              p.chainId,
              await getRevnetOperatorCached(p.chainId, p.projectId),
            ] as [number, string | null],
        ),
      )
    : chains.map((p) => [p.chainId, p.owner] as [number, string | null]);
  const authorityDeployments = chains.map((projectOnChain) => ({
    chainId: projectOnChain.chainId as JBChainId,
    projectId: projectOnChain.projectId,
    indexedAuthority: (authorities.find(
      ([chainId]) => chainId === projectOnChain.chainId,
    )?.[1] ?? null) as Address | null,
  }));

  const totalRaisedUsd = chains
    .reduce((sum, row) => sum + BigInt(row.volumeUsd || "0"), 0n)
    .toString();
  const paymentsCount = projectGroupPaymentsCount(chains);

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
            <div className="mt-2 text-sm text-smoke-700">
              <div className="space-y-1 lg:hidden">
                <div className="flex items-center">
                  <span>
                    <span className="text-smoke-500">Type:</span>{" "}
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
                          {isRevnet ? "Revnet operator:" : "Project owner:"}
                        </span>{" "}
                        <AddressLink
                          address={authority}
                          host={etherscan}
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
                      <Link
                        key={p.chainId}
                        href={`/${toUrn(p.chainId, p.projectId)}`}
                        className="transition-opacity hover:opacity-70"
                      >
                        <ChainIcon chainId={p.chainId} standalone />
                      </Link>
                    ))}
                  </span>
                </div>
              </div>

              <div className="hidden items-center whitespace-nowrap lg:flex">
                <span>
                  <span className="text-smoke-500">Type:</span>{" "}
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
                        {isRevnet ? "Revnet operator:" : "Project owner:"}
                      </span>{" "}
                      <AddressLink
                        address={authority}
                        host={etherscan}
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
                    <Link
                      key={p.chainId}
                      href={`/${toUrn(p.chainId, p.projectId)}`}
                      className="transition-opacity hover:opacity-70"
                    >
                      <ChainIcon chainId={p.chainId} standalone />
                    </Link>
                  ))}
                </span>
              </div>
            </div>
          </div>
        </header>

        {/* Stats */}
        <ProjectStats
          totalRaisedUsd={totalRaisedUsd}
          raisedByChain={chains.map((row) => ({
            chainId: row.chainId,
            usd: row.volumeUsd || "0",
          }))}
          paymentsCount={paymentsCount}
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
                  etherscanHost={etherscan}
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
                      tokenSymbol=""
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
                  tokenSymbol={project.tokenSymbol ?? "tokens"}
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
                  chains={chainPairs}
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
                  operator={operator}
                  deployments={authorityDeployments}
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
