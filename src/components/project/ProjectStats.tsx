'use client'

import {
  JBCoreContracts,
  USD_CURRENCY_ID,
  jbContractAddress,
  jbPricesAbi,
  jbTerminalStoreAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { getAccountingContexts } from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { type Address, type PublicClient } from 'viem'
import { useConfig } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { ChainIcon } from '@/components/ChainIcon'
import { Skeleton } from '@/components/ui/Skeleton'
import type { BsParticipant } from '@/lib/bendystraw'
import { formatTokenAmount, formatUsd18 } from '@/lib/format'
import { tokenSymbol } from '@/lib/token-symbol'
import { chainName } from '@/lib/urn'

type TreasuryRow = {
  chainId: number
  symbol: string
  decimals: number
  balance: bigint
  /** 18-decimal fixed-point USD. Null means no trustworthy USD feed. */
  usd: bigint | null
}

type ChainTreasury = {
  chainId: number
  verified: boolean
  rows: TreasuryRow[]
}

type ParticipantPage = {
  items: BsParticipant[]
  totalCount: number
}

async function fetchParticipants(query: string): Promise<ParticipantPage> {
  const response = await fetch(`/api/participants?${query}`)
  if (!response.ok) throw new Error('Holder data unavailable')
  return (await response.json()) as ParticipantPage
}

async function readChainTreasury(
  config: ReturnType<typeof useConfig>,
  [rawChainId, rawProjectId]: [number, number],
): Promise<ChainTreasury> {
  const chainId = rawChainId as JBChainId
  const client = getPublicClient(config, { chainId }) as
    | PublicClient
    | undefined
  const terminal = jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][
    chainId
  ] as Address | undefined
  const store = jbContractAddress['6'][JBCoreContracts.JBTerminalStore][
    chainId
  ] as Address | undefined
  const prices = jbContractAddress['6'][JBCoreContracts.JBPrices][chainId] as
    | Address
    | undefined

  if (!client || !terminal || !store || !prices) {
    return { chainId, verified: false, rows: [] }
  }

  try {
    const projectId = BigInt(rawProjectId)
    const contexts = await getAccountingContexts(client, {
      chainId,
      projectId,
    })
    const rows = await Promise.all(
      contexts.map(async (context): Promise<TreasuryRow> => {
        const [balance, symbol] = await Promise.all([
          client.readContract({
            address: store,
            abi: jbTerminalStoreAbi,
            functionName: 'balanceOf',
            args: [terminal, projectId, context.token],
          }),
          tokenSymbol(client, context.token, { chainId }),
        ])

        // JBPrices checks this project's feeds first, then protocol defaults.
        // Asking for 18 decimals gives an exact fixed-point USD price for one
        // whole accounting-token unit.
        const usdPrice =
          balance === 0n
            ? 0n
            : await client
                .readContract({
                  address: prices,
                  abi: jbPricesAbi,
                  functionName: 'pricePerUnitOf',
                  args: [
                    projectId,
                    BigInt(USD_CURRENCY_ID(6)),
                    BigInt(context.currency),
                    18n,
                  ],
                })
                .catch(() => null)
        const usd =
          usdPrice == null
            ? null
            : (balance * usdPrice) / 10n ** BigInt(context.decimals)

        return {
          chainId,
          symbol,
          decimals: context.decimals,
          balance,
          usd,
        }
      }),
    )

    return { chainId, verified: true, rows }
  } catch {
    return { chainId, verified: false, rows: [] }
  }
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="text-base sm:text-lg">
      <dd>
        <span className="font-agrandir font-medium text-ink">{value}</span>{" "}
        <span className="text-smoke-600">{label}</span>
      </dd>
    </div>
  )
}

export function HoverBreakdownStat({
  label,
  value,
  tooltipId,
  align = 'right',
  children,
}: {
  label: string
  value: ReactNode
  tooltipId: string
  align?: 'left' | 'right'
  children: ReactNode
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [isMobile, setIsMobile] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)')
    const update = () => {
      setIsMobile(query.matches)
      if (!query.matches) setMobileOpen(false)
    }
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!isMobile || !mobileOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!cardRef.current?.contains(event.target as Node)) {
        setMobileOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside, true)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [isMobile, mobileOpen])

  return (
    <div
      ref={cardRef}
      className="group relative text-base sm:text-lg"
    >
      <dd>
        <button
          type="button"
          className="cursor-help font-agrandir font-medium text-ink underline decoration-smoke-300 decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-bluebs-500"
          aria-describedby={tooltipId}
          aria-expanded={isMobile ? mobileOpen : undefined}
          onClick={() => {
            if (isMobile) setMobileOpen(open => !open)
          }}
        >
          {value}
        </button>
        <span className="text-smoke-600"> {label}</span>
        <div
          id={tooltipId}
          role="tooltip"
          aria-hidden={isMobile ? !mobileOpen : undefined}
          className={`invisible absolute top-[calc(100%+0.5rem)] z-40 max-h-[min(24rem,60vh)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-smoke-200 bg-white p-3 opacity-0 shadow-lg sm:group-hover:visible sm:group-hover:opacity-100 sm:group-focus-within:visible sm:group-focus-within:opacity-100 ${
            mobileOpen ? 'visible opacity-100' : ''
          } ${
            align === 'left' ? 'left-3' : 'right-3'
          }`}
        >
          {children}
        </div>
      </dd>
    </div>
  )
}

export function ProjectStats({
  totalRaisedUsd,
  raisedByChain,
  paymentsCount,
  suckerGroupId,
  chains,
  isRevnet,
}: {
  /** Bendystraw's indexed, 18-decimal fixed-point USD volume. */
  totalRaisedUsd: string
  /** Bendystraw's indexed USD volume for each deployment. */
  raisedByChain: { chainId: number; usd: string }[]
  paymentsCount: number
  suckerGroupId: string | null
  /** [chainId, projectId] pairs across the sucker group. */
  chains: [number, number][]
  isRevnet: boolean
}) {
  const config = useConfig()
  const raisedTooltipId = useId()
  const treasuryTooltipId = useId()
  const { data, isLoading } = useQuery({
    queryKey: ['projectTreasuryUsd', chains],
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      const chainResults = await Promise.all(
        chains.map(pair => readChainTreasury(config, pair)),
      )
      const rows = chainResults.flatMap(result => result.rows)
      const failedChainIds = chainResults
        .filter(result => !result.verified)
        .map(result => result.chainId)
      const fullyPriced =
        failedChainIds.length === 0 &&
        rows.every(row => row.balance === 0n || row.usd != null)
      const pricedTotal = rows.reduce(
        (sum, row) => sum + (row.usd ?? 0n),
        0n,
      )

      return {
        rows,
        failedChainIds,
        totalUsd: fullyPriced ? pricedTotal : null,
      }
    },
  })

  const {
    data: participantData,
    isLoading: holdersLoading,
    isError: holdersError,
  } = useQuery({
    queryKey: [
      'participants',
      suckerGroupId ??
        chains
          .map(([chainId, projectId]) => `${chainId}:${projectId}`)
          .join(','),
    ],
    enabled: chains.length > 0,
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      // A sucker-group query returns every deployment in one response. Fall
      // back to the verified chain/project pairs if that aggregate is not yet
      // available, as can happen while the indexer catches up to a new group.
      if (suckerGroupId) {
        try {
          // The chainId rides along as an endpoint-routing hint (testnet
          // groups live on the testnet indexer).
          const grouped = await fetchParticipants(
            `suckerGroupId=${encodeURIComponent(suckerGroupId)}&chainId=${chains[0]?.[0] ?? ''}`,
          )
          if (grouped.items.length > 0) return grouped
        } catch {
          // The per-deployment reads below are the authoritative fallback.
        }
      }

      const pages = await Promise.all(
        chains.map(([chainId, projectId]) =>
          fetchParticipants(`chainId=${chainId}&projectId=${projectId}`),
        ),
      )
      return {
        items: pages.flatMap(page => page.items),
        totalCount: pages.reduce((sum, page) => sum + page.totalCount, 0),
      }
    },
  })

  // Bendystraw emits one participant row per deployment. Count each address
  // once so an omnichain token holder is still one holder in this card.
  const holderCount = useMemo(() => {
    const addresses = new Set<string>()
    for (const participant of participantData?.items ?? []) {
      try {
        if (BigInt(participant.balance) > 0n) {
          addresses.add(participant.address.toLowerCase())
        }
      } catch {
        // Ignore malformed indexer rows rather than calling them holders.
      }
    }
    return addresses.size
  }, [participantData])
  const holderCountIsExact =
    !!participantData &&
    participantData.totalCount <= participantData.items.length
  const holderValue = holdersLoading
    ? <Skeleton className="h-7 w-20 rounded" />
    : holdersError || !participantData
      ? '—'
      : `${holderCount.toLocaleString('en-US')}${holderCountIsExact ? '' : '+'}`

  const hasBreakdown =
    !!data && (data.rows.length > 0 || data.failedChainIds.length > 0)
  const treasuryValue = isLoading
    ? <Skeleton className="h-7 w-24 rounded" />
    : data?.totalUsd != null
      ? formatUsd18(data.totalUsd)
      : '—'

  return (
    <dl className="mt-2 grid grid-cols-2 items-center gap-x-4 gap-y-1 [&>div:nth-child(even)]:border-l [&>div:nth-child(even)]:border-smoke-200 [&>div:nth-child(even)]:pl-4 sm:grid-cols-4 sm:[&>div:not(:first-child)]:border-l sm:[&>div:not(:first-child)]:border-smoke-200 sm:[&>div:not(:first-child)]:pl-4">
      <HoverBreakdownStat
        label="raised"
        value={formatUsd18(totalRaisedUsd)}
        tooltipId={raisedTooltipId}
        align="left"
      >
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-smoke-500">
          Raised by chain
        </p>
        <div className="space-y-2">
          {raisedByChain.map(row => (
            <div
              key={row.chainId}
              className="flex items-center justify-between gap-4 text-xs"
            >
              <span className="inline-flex min-w-0 items-center gap-1.5 text-smoke-600">
                <ChainIcon chainId={row.chainId} size={17} />
                <span className="truncate">{chainName(row.chainId)}</span>
              </span>
              <span className="shrink-0 tabular-nums text-ink">
                {formatUsd18(row.usd)}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between gap-4 border-t border-smoke-200 pt-2 text-xs font-medium text-ink">
          <span>All chains</span>
          <span className="tabular-nums">{formatUsd18(totalRaisedUsd)}</span>
        </div>
      </HoverBreakdownStat>

      {hasBreakdown ? (
        <HoverBreakdownStat
          label="balance"
          value={treasuryValue}
          tooltipId={treasuryTooltipId}
        >
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-smoke-500">
            Balance breakdown
          </p>
          <div className="space-y-2">
            {data?.rows.map((row, index) => (
              <div
                key={`${row.chainId}-${row.symbol}-${index}`}
                className={`flex items-start justify-between gap-4 text-xs ${
                  row.balance === 0n ? 'opacity-50' : ''
                }`}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5 text-smoke-600">
                  <ChainIcon chainId={row.chainId} size={17} />
                  <span className="truncate">{chainName(row.chainId)}</span>
                </span>
                <span className="shrink-0 text-right tabular-nums text-ink">
                  <span className="block">
                    {formatTokenAmount(row.balance, row.decimals)} {row.symbol}
                  </span>
                  <span className="block text-[11px] text-smoke-500">
                    {row.usd == null
                      ? 'No USD price'
                      : formatUsd18(row.usd)}
                  </span>
                </span>
              </div>
            ))}
            {data?.failedChainIds.map(chainId => (
              <div
                key={`failed-${chainId}`}
                className="flex items-center justify-between gap-4 text-xs text-smoke-500"
              >
                <span className="inline-flex items-center gap-1.5">
                  <ChainIcon chainId={chainId} size={17} />
                  {chainName(chainId)}
                </span>
                <span>Unavailable</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between gap-4 border-t border-smoke-200 pt-2 text-xs font-medium text-ink">
            <span>All chains</span>
            <span className="tabular-nums">{treasuryValue}</span>
          </div>
        </HoverBreakdownStat>
      ) : (
        <Stat label="balance" value={treasuryValue} />
      )}

      <Stat
        label={paymentsCount === 1 ? "payment" : "payments"}
        value={paymentsCount.toLocaleString('en-US')}
      />
      <Stat
        label={
          isRevnet
            ? holderCountIsExact && holderCount === 1
              ? "owner"
              : "owners"
            : holderCountIsExact && holderCount === 1
              ? "token holder"
              : "token holders"
        }
        value={holderValue}
      />
    </dl>
  )
}
