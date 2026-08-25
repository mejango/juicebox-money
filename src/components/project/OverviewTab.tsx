import Link from "next/link";
import type { JBChainId } from "@bananapus/nana-sdk-core";
import { ChainIcon } from "@/components/ChainIcon";
import { RichContent } from "@/components/RichContent";
import { CopyProjectAuditPrompt } from "@/components/project/CopyProjectAuditPrompt";
import { FundingChart } from "@/components/project/FundingChart";
import { RevnetPriceCard } from "@/components/project/RevnetPriceCard";
import { TokenPanel } from "@/components/project/TokenPanel";
import { AddressLink } from "@/components/ui/AddressLink";
import { chainName, toUrn } from "@/lib/urn";

/** The owner/operator address, linked to its own chain's explorer. */
function AuthorityLink({
  chainId,
  address,
}: {
  chainId: number;
  address: string;
}) {
  return <AddressLink address={address} chainId={chainId} />;
}

function ExternalLinkIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      className="h-3.5 w-3.5"
    >
      <path
        d="M5 11 11 5m-4 0h4v4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The owner/operator row(s). One row when every chain agrees; a per-chain
 * breakdown when they differ (a project's owner — or a revnet's operator —
 * can be set independently on each chain).
 */
function AuthorityRows({
  label,
  authorities,
}: {
  label: string;
  /** `null` = the indexer says there is none; `undefined` = it couldn't be read. */
  authorities: [number, string | null | undefined][];
}) {
  const known = authorities.filter(([, a]) => !!a) as [number, string][];
  const unreadable = authorities.some(([, a]) => a === undefined);
  if (known.length === 0) {
    // "No operator" and "we couldn't check" are different claims.
    return unreadable ? (
      <div className="flex items-center justify-between gap-3 pt-1">
        <dt className="text-smoke-700">{label}</dt>
        <dd className="text-smoke-500">Couldn&apos;t load</dd>
      </div>
    ) : null;
  }

  const uniform = known.every(
    ([, a]) => a.toLowerCase() === known[0][1].toLowerCase(),
  );

  if (uniform) {
    return (
      <div className="flex items-center justify-between gap-3 pt-1">
        <dt className="shrink-0 text-smoke-700">{label}</dt>
        {/* A long ENS name truncates rather than overflowing the card. */}
        <dd className="min-w-0 truncate">
          <AuthorityLink chainId={known[0][0]} address={known[0][1]} />
        </dd>
      </div>
    );
  }

  return (
    <div className="pt-1">
      <dt className="text-smoke-700">{label} — differs by chain</dt>
      <dd className="mt-1 space-y-1">
        {known.map(([id, a]) => (
          <div key={id} className="flex items-center justify-between gap-3">
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-smoke-500">
              <ChainIcon chainId={id} size={14} />
              {chainName(id)}
            </span>
            <span className="min-w-0 truncate">
              <AuthorityLink chainId={id} address={a} />
            </span>
          </div>
        ))}
      </dd>
    </div>
  );
}

/**
 * Overview tab (website/ parity: About card + Other info panel), leading
 * with the human story — description and links first, protocol details
 * after.
 */
export function OverviewTab({
  chainId,
  projectId,
  description,
  descriptionFallback,
  socialLinks,
  isRevnet,
  authorities,
  chains,
  suckerGroupId,
}: {
  chainId: JBChainId;
  projectId: number;
  description: string;
  descriptionFallback: string[];
  socialLinks: [string, string | null][];
  isRevnet: boolean;
  /** Owner (custom) or operator (revnet) address; null hides the row. */
  authority: string | null;
  /** The authority per chain — [chainId, address|null]. Can differ.
   *  `undefined` for a chain whose authority could not be read. */
  authorities: [number, string | null | undefined][];
  /** Per-chain deployments: [chainId, projectId]. */
  chains: [number, number][];
  suckerGroupId: string | null;
}) {
  const links = socialLinks.filter(([, href]) => href);
  return (
    <div className="space-y-5">
      {description || links.length > 0 ? (
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-agrandir text-xl font-medium">About</h2>
            <CopyProjectAuditPrompt urn={toUrn(chainId, projectId)} />
          </div>
          {description ? (
            <RichContent
              html={description}
              fallback={descriptionFallback}
              className="card p-5 text-sm leading-relaxed text-ink/90 [&>*+*]:mt-3 [&_a]:break-words [&_a]:font-medium [&_a]:text-bluebs-600 [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-smoke-300 [&_blockquote]:pl-3 [&_img]:rounded-lg [&_li+li]:mt-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5"
            />
          ) : null}
          {links.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {links.map(([label, href]) => (
                <a
                  key={label}
                  href={href!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-tertiary min-h-10 gap-2 px-3.5 text-sm transition-colors hover:bg-bluebs-50 hover:text-bluebs-700"
                >
                  <span>{label}</span>
                  <ExternalLinkIcon />
                </a>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {isRevnet ? (
        <RevnetPriceCard
          chainId={chainId}
          projectId={projectId}
          chains={chains}
          suckerGroupId={suckerGroupId}
        />
      ) : (
        <FundingChart suckerGroupId={suckerGroupId} />
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TokenPanel
          chainId={chainId}
          projectId={projectId}
          chainIds={chains.map(([id]) => id)}
        />

        <div className="card p-5">
          <span className="field-label">Details</span>
          <dl className="mt-2 space-y-1.5 text-sm">
            {chains.map(([id, pid]) => (
              <div key={id} className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-1.5 text-smoke-700">
                  <ChainIcon chainId={id} size={16} />
                  {chainName(id)}
                </dt>
                <dd>
                  <Link
                    href={`/${toUrn(id, pid)}`}
                    className="text-ink hover:underline"
                  >
                    Project #{pid}
                  </Link>
                </dd>
              </div>
            ))}
            <AuthorityRows
              label={isRevnet ? "Revnet operator" : "Project owner"}
              authorities={authorities}
            />
          </dl>
        </div>
      </div>
    </div>
  );
}
