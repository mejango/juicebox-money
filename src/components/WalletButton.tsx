'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  JB_CHAINS,
  JBCoreContracts,
  USDC_ADDRESSES,
  jbContractAddress,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { erc20Abi, formatUnits, type Address } from 'viem'
import { useAccount, useBalance, useConfig, useReadContract } from 'wagmi'
import { getBalance, readContract } from 'wagmi/actions'
import { AddressLabel } from '@/components/ui/AddressLabel'
import { ViewAsForm } from '@/components/ViewAsForm'
import { GetFunds } from '@/components/GetFunds'
import { useOutsideClose } from '@/hooks/useOutsideClose'
import { useProjectTokenSymbol } from '@/hooks/useProjectTokenSymbol'
import { useWallet } from '@/hooks/useWallet'
import { preloadParaHost } from '@/providers/preload-para'
import { parseUrn } from '@/lib/urn'
import {
  projectHandleFromRoute,
  projectRouteSegmentFromPathname,
} from '@/lib/project-handles'
import { useViewAs } from '@/lib/viewAs'
import { useResolvedProjectRoute } from '@/providers/ProjectRouteContext'
import {
  getProject,
  getSuckerGroupProjects,
  resolveProjectDeployments,
} from '@/lib/bendystraw'

function formatWalletBalance(
  value: bigint | undefined,
  decimals: number,
  symbol: string,
) {
  if (value === undefined) return 'Loading…'
  return `${Number(formatUnits(value, decimals)).toLocaleString(undefined, {
    maximumFractionDigits: 4,
  })} ${symbol}`
}

function BalanceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-5">
      <dt className="text-smoke-600">{label}</dt>
      <dd className="whitespace-nowrap font-medium text-ink">{value}</dd>
    </div>
  )
}

function ProjectWalletBalances({
  address,
  chainId,
  projectId,
}: {
  address: Address
  chainId: JBChainId
  projectId: number
}) {
  const config = useConfig()
  const { data: projectToken, isLoading: projectTokenLoading } =
    useProjectTokenSymbol(chainId, projectId)
  const deployments = useQuery({
    queryKey: ['walletProjectDeployments', chainId, projectId],
    staleTime: 60_000,
    queryFn: async () => {
      const home = await getProject(chainId, projectId)
      if (!home) return [{ chainId, projectId }]
      const peers = home.suckerGroupId
        ? await getSuckerGroupProjects(home.suckerGroupId, chainId)
        : []
      return resolveProjectDeployments(home, peers).map(project => ({
        chainId: project.chainId as JBChainId,
        projectId: project.projectId,
      }))
    },
  })
  const deploymentKey = (deployments.data ?? [])
    .map(project => `${project.chainId}:${project.projectId}`)
    .join(',')
  const balances = useQuery({
    queryKey: ['walletProjectBalances', address, deploymentKey],
    enabled: !!deploymentKey,
    staleTime: 30_000,
    queryFn: async () => {
      const rows = await Promise.all(
        (deployments.data ?? []).map(async project => {
          const tokens = jbContractAddress['6'][JBCoreContracts.JBTokens][
            project.chainId
          ] as Address | undefined
          if (!tokens) throw new Error(`Unsupported chain ${project.chainId}`)
          const usdc = USDC_ADDRESSES[project.chainId]
          const [nativeBalance, usdcBalance, projectBalance] = await Promise.all([
            getBalance(config, { address, chainId: project.chainId }),
            usdc
              ? readContract(config, {
                  abi: erc20Abi,
                  address: usdc,
                  chainId: project.chainId,
                  functionName: 'balanceOf',
                  args: [address],
                })
              : Promise.resolve(0n),
            readContract(config, {
              abi: jbTokensAbi,
              address: tokens,
              chainId: project.chainId,
              functionName: 'totalBalanceOf',
              args: [address, BigInt(project.projectId)],
            }),
          ])
          return { nativeBalance, usdcBalance, projectBalance }
        }),
      )
      return {
        native: rows.reduce((sum, row) => sum + row.nativeBalance.value, 0n),
        nativeSymbol: rows[0]?.nativeBalance.symbol ?? 'ETH',
        project: rows.reduce((sum, row) => sum + row.projectBalance, 0n),
        usdc: rows.reduce((sum, row) => sum + row.usdcBalance, 0n),
      }
    },
  })
  const chainCount = deployments.data?.length ?? 0
  const loading = deployments.isLoading || balances.isLoading

  return (
    <div className="border-b border-smoke-200 px-4 py-3 text-xs">
      <div className="mb-2 text-smoke-600">
        {chainCount ? `Across ${chainCount} project chains` : 'Across project chains'}
      </div>
      <dl className="space-y-1.5">
        <BalanceRow
          label={balances.data?.nativeSymbol ?? 'ETH'}
          value={
            loading
              ? 'Loading…'
              : balances.data
                ? formatWalletBalance(
                    balances.data.native,
                    18,
                    balances.data.nativeSymbol,
                  )
                : 'Unavailable'
          }
        />
        <BalanceRow
          label="USDC"
          value={
            loading
              ? 'Loading…'
              : balances.data
                ? formatWalletBalance(balances.data.usdc, 6, 'USDC')
                : 'Unavailable'
          }
        />
        <BalanceRow
          label={projectToken?.symbol ?? 'Project token'}
          value={
            loading || projectTokenLoading
              ? 'Loading…'
              : balances.data && projectToken
                ? formatWalletBalance(
                    balances.data.project,
                    18,
                    projectToken.symbol,
                  )
                : 'Unavailable'
          }
        />
      </dl>
    </div>
  )
}

function SingleChainWalletBalances({
  address,
  chainId,
}: {
  address: Address
  chainId: JBChainId
}) {
  const chain = JB_CHAINS[chainId]
  const nativeSymbol = chain?.nativeTokenSymbol ?? 'ETH'
  const usdc = USDC_ADDRESSES[chainId]
  const { data: nativeBalance } = useBalance({ address, chainId })
  const { data: usdcBalance } = useReadContract({
    abi: erc20Abi,
    address: usdc,
    chainId,
    functionName: 'balanceOf',
    args: [address],
    query: { enabled: !!usdc },
  })
  return (
    <div className="border-b border-smoke-200 px-4 py-3 text-xs">
      <div className="mb-2 text-smoke-600">{chain?.name ?? `Chain ${chainId}`}</div>
      <dl className="space-y-1.5">
        <BalanceRow
          label={nativeSymbol}
          value={formatWalletBalance(nativeBalance?.value, 18, nativeSymbol)}
        />
        <BalanceRow
          label="USDC"
          value={
            usdc
              ? formatWalletBalance(usdcBalance, 6, 'USDC')
              : 'Unavailable'
          }
        />
      </dl>
    </div>
  )
}

function WalletBalances({
  address,
  chainId,
  projectId,
}: {
  address: Address
  chainId: JBChainId
  projectId?: number
}) {
  return projectId ? (
    <ProjectWalletBalances
      address={address}
      chainId={chainId}
      projectId={projectId}
    />
  ) : (
    <SingleChainWalletBalances address={address} chainId={chainId} />
  )
}

/** Inline "View as…" prompt: an address or ENS name turns on view-as mode. */
export function WalletButton() {
  const { isConnected, address, openSignIn, disconnect } = useWallet()
  const { viewAs, clearViewAs } = useViewAs()
  const [menuOpen, setMenuOpen] = useState(false)
  const [viewAsOpen, setViewAsOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const pathname = usePathname()
  const { chainId: connectedChainId } = useAccount()
  const routeSegment = projectRouteSegmentFromPathname(pathname) ?? ''
  const parsedRouteProject = parseUrn(routeSegment)
  const routeHandle = projectHandleFromRoute(routeSegment)?.handle ?? null
  const resolvedRouteProject = useResolvedProjectRoute()
  const routeProject =
    parsedRouteProject ??
    (routeHandle && resolvedRouteProject?.handle === routeHandle
      ? resolvedRouteProject
      : null)
  const balanceChainId =
    routeProject?.chainId ?? (connectedChainId as JBChainId | undefined)

  // Wallet state only exists client-side; render the signed-out shell on the
  // server so hydration always matches.
  useEffect(() => setMounted(true), [])

  const closeMenu = () => {
    setMenuOpen(false)
    setViewAsOpen(false)
  }

  useOutsideClose(menuRef, closeMenu, menuOpen)

  const connected = mounted && isConnected && !!address
  const activeViewAs = mounted ? viewAs : null
  // While view-as is active, "View account" follows the impersonated account.
  const accountAddress = activeViewAs ?? address

  const viewAsItem = (
    <button
      onClick={() => setViewAsOpen(open => !open)}
      aria-expanded={viewAsOpen}
      className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-smoke-25"
    >
      View as…
      <span className="block text-xs font-normal text-smoke-700">
        Browse the site as any address
      </span>
    </button>
  )

  return (
    <div className="relative" ref={menuRef}>
      {activeViewAs ? (
        <button
          onClick={() => setMenuOpen(o => !o)}
          aria-expanded={menuOpen}
          className="flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-lg border border-amber-400 bg-amber-100 px-4 text-sm font-medium text-amber-900 hover:bg-amber-200"
        >
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          <span className="hidden sm:inline">Viewing as</span>
          <AddressLabel address={activeViewAs} />
        </button>
      ) : connected ? (
        <button
          onClick={() => setMenuOpen(o => !o)}
          aria-expanded={menuOpen}
          className="btn-secondary flex min-h-[44px] items-center gap-2 whitespace-nowrap px-4 py-1.5 text-sm"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-melon-500" />
          {/* The state is the headline; which account is the detail. */}
          <span className="flex flex-col items-start leading-tight">
            <span className="font-medium">Signed in</span>
            <span className="text-[11px] font-normal text-smoke-600">
              <AddressLabel address={address} />
            </span>
          </span>
        </button>
      ) : (
        // The sheet now carries every way in — email, phone, socials, wallets —
        // so a menu in front of it would only ask which door to use twice.
        <div className="flex items-center gap-3">
          <button
            onClick={openSignIn}
            // Fetch Para's runtime as the pointer arrives, so the click has
            // nothing left to wait for.
            onMouseEnter={preloadParaHost}
            onFocus={preloadParaHost}
            onTouchStart={preloadParaHost}
            className="btn-primary min-h-[44px] whitespace-nowrap px-5 text-sm"
          >
            Sign in
          </button>
        </div>
      )}

      {menuOpen ? (
        <div className="card absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden py-1.5 shadow-[0_12px_32px_rgba(32,30,26,0.12)]">
          {viewAsOpen ? (
            <ViewAsForm onDone={closeMenu} />
          ) : activeViewAs ? (
            <>
              {accountAddress && balanceChainId ? (
                <WalletBalances
                  address={accountAddress}
                  chainId={balanceChainId}
                  projectId={routeProject?.projectId}
                />
              ) : null}
              <Link
                href={`/account/${activeViewAs}`}
                onClick={closeMenu}
                className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-smoke-25"
              >
                View account
              </Link>
              <div className="mx-4 my-1 border-t border-smoke-200" />
              <button
                onClick={() => {
                  closeMenu()
                  clearViewAs()
                }}
                className="block w-full px-4 py-3 text-left text-sm font-medium text-amber-800 hover:bg-amber-50"
              >
                {connected ? 'View as connected wallet' : 'Exit View as'}
              </button>
              <div className="mx-4 my-1 border-t border-smoke-200" />
              {viewAsItem}
            </>
          ) : connected ? (
            <>
              {accountAddress && balanceChainId ? (
                <WalletBalances
                  address={accountAddress}
                  chainId={balanceChainId}
                  projectId={routeProject?.projectId}
                />
              ) : null}
              <Link
                href={`/account/${accountAddress}`}
                onClick={closeMenu}
                className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-smoke-25"
              >
                View account
              </Link>
              {balanceChainId ? (
                <GetFunds
                  symbol="ETH"
                  chainId={balanceChainId}
                  onNavigate={closeMenu}
                  className="block w-full px-4 py-3 text-left text-sm font-medium text-ink no-underline hover:bg-smoke-25"
                />
              ) : null}
              <div className="mx-4 my-1 border-t border-smoke-200" />
              <button
                onClick={() => {
                  closeMenu()
                  disconnect()
                }}
                className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-smoke-25"
              >
                Sign out
              </button>
              <div className="mx-4 my-1 border-t border-smoke-200" />
              {viewAsItem}
            </>
          ) : (
            // Signing in is the button's own job now; the only thing left that
            // needs a surface here is impersonation.
            <ViewAsForm onDone={closeMenu} />
          )}
        </div>
      ) : null}
    </div>
  )
}
