import Link from 'next/link'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { ChainIcon } from '@/components/ChainIcon'
import { TokenPanel } from '@/components/project/TokenPanel'
import { truncateAddress } from '@/lib/format'
import { chainName, toUrn } from '@/lib/urn'

/**
 * Overview tab (website/ parity: About card + Other info panel), leading
 * with the human story — description and links first, protocol details
 * after.
 */
export function OverviewTab({
  chainId,
  projectId,
  description,
  socialLinks,
  isRevnet,
  authority,
  chains,
  etherscanHost,
}: {
  chainId: JBChainId
  projectId: number
  description: string[]
  socialLinks: [string, string | null][]
  isRevnet: boolean
  /** Owner (custom) or operator (revnet) address; null hides the row. */
  authority: string | null
  /** Per-chain deployments: [chainId, projectId]. */
  chains: [number, number][]
  etherscanHost?: string
}) {
  const links = socialLinks.filter(([, href]) => href)
  return (
    <div className="space-y-5">
      {description.length > 0 || links.length > 0 ? (
        <section>
          <h2 className="mb-3 font-agrandir text-xl font-medium">About</h2>
          {description.length > 0 ? (
            <div className="card space-y-3 p-5 text-sm leading-relaxed text-ink/90">
              {description.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          ) : null}
          {links.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {links.map(([label, href]) => (
                <a
                  key={label}
                  href={href!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary min-h-[36px] px-3.5 text-xs"
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
            {authority ? (
              <div className="flex items-center justify-between gap-3 pt-1">
                <dt className="text-smoke-700">
                  {isRevnet ? 'Operator' : 'Owner'}
                </dt>
                <dd>
                  {etherscanHost ? (
                    <a
                      href={`https://${etherscanHost}/address/${authority}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-ink hover:underline"
                    >
                      {truncateAddress(authority)}
                    </a>
                  ) : (
                    <span className="text-ink">
                      {truncateAddress(authority)}
                    </span>
                  )}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </div>
    </div>
  )
}
