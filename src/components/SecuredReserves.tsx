import type { HomepageReserves } from '@/lib/homepage-reserves'
import { chainName } from '@/lib/urn'
import { ChainIcon } from './ChainIcon'
import { SecuredReserveChart } from './SecuredReserveChart'

function amount(value: number, maximumFractionDigits: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits })
}

function usd(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function SecuredReserves({ data }: { data: HomepageReserves }) {
  return (
    <section className="flex flex-col gap-3 border-b border-smoke-200 pb-4 sm:gap-4">
      <div className="flex flex-col items-start gap-1">
        <span className="group relative inline-flex font-agrandir text-3xl font-medium leading-none sm:text-4xl">
          <span
            tabIndex={0}
            aria-describedby="secured-reserves-breakdown"
            className="cursor-help tabular-nums underline decoration-dotted decoration-smoke-400 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-bluebs-500"
          >
            {usd(data.totalUsd)}
          </span>
          <span
            id="secured-reserves-breakdown"
            role="tooltip"
            className="pointer-events-none absolute left-0 top-full z-20 mt-2 hidden w-64 rounded border border-smoke-200 bg-white px-3 py-2 text-left text-xs font-normal leading-relaxed text-smoke-700 shadow-lg group-hover:block group-focus-within:block"
          >
            {data.chains.map((chain, index) => {
              const hasReserves =
                chain.eth > 0 ||
                chain.usdc > 0 ||
                chain.otherAssets.length > 0
              return (
                <span
                  key={chain.chainId}
                  className={`block py-1.5 ${
                    index ? 'border-t border-smoke-100' : ''
                  }`}
                >
                  <span className="block font-medium text-ink">
                    {chainName(chain.chainId)}
                  </span>
                  {hasReserves ? (
                    <>
                      {chain.eth > 0 ? (
                        <span className="block tabular-nums">
                          ETH: {amount(chain.eth, 3)}
                        </span>
                      ) : null}
                      {chain.usdc > 0 ? (
                        <span className="block tabular-nums">
                          USDC: {amount(chain.usdc, 2)}
                        </span>
                      ) : null}
                      {chain.otherAssets.length ? (
                        <span className="block">
                          Other: {chain.otherAssets.join(', ')}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="block text-smoke-500">No reserves</span>
                  )}
                </span>
              )
            })}
          </span>
        </span>
        <span className="flex items-center gap-2 font-agrandir text-xs text-smoke-500 sm:text-sm">
          <span>Secured by Juicebox</span>
          <span
            className="inline-flex items-center gap-1"
            aria-label="Ethereum, Arbitrum, Base, and Optimism"
          >
            {[1, 42161, 8453, 10].map(chainId => (
              <ChainIcon key={chainId} chainId={chainId} size={14} />
            ))}
          </span>
        </span>
      </div>
      <SecuredReserveChart points={data.points} />
    </section>
  )
}
