import Link from "next/link";
import type { JBChainId } from "@bananapus/nana-sdk-core";
import { ChainIcon } from "@/components/ChainIcon";
import { RichContent } from "@/components/RichContent";
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
  authorities: [number, string | null][];
}) {
  const known = authorities.filter(([, a]) => !!a) as [number, string][];
  if (known.length === 0) return null;

  const uniform = known.every(
    ([, a]) => a.toLowerCase() === known[0][1].toLowerCase(),
  );

  if (uniform) {
    return (
      <div className="flex items-center justify-between gap-3 pt-1">
        <dt className="text-smoke-700">{label}</dt>
        <dd>
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
            <span className="flex items-center gap-1.5 text-xs text-smoke-500">
              <ChainIcon chainId={id} size={14} />
              {chainName(id)}
            </span>
            <AuthorityLink chainId={id} address={a} />
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
  etherscanHost,
}: {
  chainId: JBChainId;
  projectId: number;
  description: string;
  descriptionFallback: string[];
  socialLinks: [string, string | null][];
  isRevnet: boolean;
  /** Owner (custom) or operator (revnet) address; null hides the row. */
  authority: string | null;
  /** The authority per chain — [chainId, address|null]. Can differ. */
  authorities: [number, string | null][];
  /** Per-chain deployments: [chainId, projectId]. */
  chains: [number, number][];
  suckerGroupId: string | null;
  etherscanHost?: string;
}) {
  const links = socialLinks.filter(([, href]) => href);
  return (
    <div className="space-y-5">
      {isRevnet ? (
        <RevnetPriceCard
          chainId={chainId}
          projectId={projectId}
          chains={chains}
          suckerGroupId={suckerGroupId}
        />
      ) : null}
      {description || links.length > 0 ? (
        <section>
          <h2 className="mb-3 font-agrandir text-xl font-medium">About</h2>
          {description ? (
            <RichContent
              html={description}
              fallback={descriptionFallback}
              className="card whitespace-pre-wrap p-5 text-sm leading-relaxed text-ink/90 [&>*+*]:mt-3 [&_a]:break-words [&_a]:font-medium [&_a]:text-bluebs-600 [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-smoke-300 [&_blockquote]:pl-3 [&_li+li]:mt-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5"
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
                  className="btn-secondary min-h-11 px-3.5 text-xs"
                >
                  {label}
                </a>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TokenPanel
          chainId={chainId}
          projectId={projectId}
          chainIds={chains.map(([id]) => id)}
          etherscanHost={etherscanHost}
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
              label={isRevnet ? "Project operator" : "Project owner"}
              authorities={authorities}
            />
          </dl>
        </div>
      </div>
    </div>
  );
}
