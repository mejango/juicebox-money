'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  JB_CHAINS,
  JBCoreContracts,
  USDC_ADDRESSES,
  jbContractAddress,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { erc20Abi, formatUnits, isAddress, type Address } from 'viem'
import { useAccount, useBalance, useConfig, useReadContract } from 'wagmi'
import { getBalance, readContract } from 'wagmi/actions'
import { AddressLabel } from '@/components/ui/AddressLabel'
import { useOutsideClose } from '@/hooks/useOutsideClose'
import { useMobileWallet } from '@/hooks/useMobileWallet'
import { useProjectTokenSymbol } from '@/hooks/useProjectTokenSymbol'
import { useWallet } from '@/hooks/useWallet'
import { looksLikeEns, lookupEnsAddress } from '@/lib/ens'
import { mobileWalletLinks, walletDappUrl } from '@/lib/walletLinks'
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
function ViewAsPrompt({ onDone }: { onDone: () => void }) {
  const { setViewAs } = useViewAs()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const input = value.trim()
    setError(null)
    if (isAddress(input)) {
      setViewAs(input as Address)
      onDone()
      return
    }
    if (looksLikeEns(input)) {
      setBusy(true)
      try {
        const resolved = await lookupEnsAddress(input)
        if (resolved) {
          setViewAs(resolved)
          onDone()
          return
        }
        setError('Could not resolve that ENS name.')
      } finally {
        setBusy(false)
      }
      return
    }
    setError('Enter an address or ENS name.')
  }

  return (
    <form onSubmit={submit} className="px-4 py-3">
      <label className="block text-xs font-medium text-smoke-700">
        View the site as
      </label>
      <input
        value={value}
        onChange={event => setValue(event.target.value)}
        placeholder="Address or ENS"
        autoFocus
        className="mt-1.5 h-9 w-full rounded-lg border border-smoke-200 bg-white px-2.5 text-sm text-ink placeholder:text-smoke-500 focus:border-bluebs-500 focus:outline-none"
      />
      {error ? <p className="mt-1.5 text-xs text-crush-600">{error}</p> : null}
      <button
        type="submit"
        disabled={busy}
        className="btn-secondary mt-2 h-9 w-full text-sm"
      >
        {busy ? 'Resolving…' : 'View as'}
      </button>
    </form>
  )
}

export function WalletButton() {
  const { isConnected, address, connectors, connectWith, openSignIn, disconnect } =
    useWallet()
  const { viewAs, clearViewAs } = useViewAs()
  const [menuOpen, setMenuOpen] = useState(false)
  const [viewAsOpen, setViewAsOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const mobileWallet = useMobileWallet()
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
  const externalConnectors =
    mobileWallet === 'checking' || mobileWallet === 'handoff'
      ? connectors.filter(connector => connector.id !== 'injected')
      : connectors

  const mobileWalletOptions =
    mobileWallet === 'checking' ? (
      <p className="px-4 py-3 text-xs text-smoke-700">
        Checking this browser for MetaMask…
      </p>
    ) : mobileWallet === 'handoff' && typeof window !== 'undefined' ? (
      <div className="px-2 py-2">
        <p className="px-2 pb-1.5 text-xs text-smoke-700">
          Open this page inside a wallet app to connect.
        </p>
        {mobileWalletLinks(window.location.href).map(link => (
          <a
            key={link.name}
            href={link.url}
            onClick={closeMenu}
            className="block min-h-11 w-full px-2 py-2.5 text-left text-sm font-medium text-ink hover:bg-smoke-25"
          >
            Open in {link.name}
          </a>
        ))}
        {typeof navigator.share === 'function' ? (
          <button
            type="button"
            onClick={() => {
              void navigator
                .share({
                  title: document.title,
                  url: walletDappUrl(window.location.href),
                })
                .catch(error => {
                  if (error instanceof Error && error.name === 'AbortError') {
                    return
                  }
                  console.error('Wallet handoff share failed:', error)
                })
            }}
            className="block min-h-11 w-full px-2 py-2.5 text-left text-sm font-medium text-ink hover:bg-smoke-25"
          >
            Open in another wallet…
          </button>
        ) : null}
      </div>
    ) : null

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
          className="btn-secondary flex min-h-[44px] items-center gap-2 whitespace-nowrap px-4 text-sm"
        >
          <span className="h-2 w-2 rounded-full bg-melon-500" />
          <AddressLabel address={address} />
        </button>
      ) : (
        <button
          onClick={() => setMenuOpen(o => !o)}
          aria-expanded={menuOpen}
          className="btn-primary min-h-[44px] whitespace-nowrap px-5 text-sm"
        >
          Sign in
        </button>
      )}

      {menuOpen ? (
        <div className="card absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden py-1.5 shadow-[0_12px_32px_rgba(32,30,26,0.12)]">
          {viewAsOpen ? (
            <ViewAsPrompt onDone={closeMenu} />
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
            <>
              <button
                onClick={() => {
                  closeMenu()
                  openSignIn()
                }}
                className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-smoke-25"
              >
                Email or social
                <span className="block text-xs font-normal text-smoke-700">
                  No wallet needed — we make one for you
                </span>
              </button>
              <div className="mx-4 my-1 border-t border-smoke-200" />
              {externalConnectors.map(c => (
                <button
                  key={c.id}
                  onClick={() => {
                    closeMenu()
                    connectWith(c.id).catch(() => {})
                  }}
                  className="block w-full px-4 py-2.5 text-left text-sm font-medium text-ink/90 hover:bg-smoke-25"
                >
                  {c.name}
                </button>
              ))}
              {mobileWalletOptions ? (
                <>
                  <div className="mx-4 my-1 border-t border-smoke-200" />
                  {mobileWalletOptions}
                </>
              ) : null}
              <div className="mx-4 my-1 border-t border-smoke-200" />
              {viewAsItem}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
