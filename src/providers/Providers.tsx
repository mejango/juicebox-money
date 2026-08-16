'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  lazy,
  PropsWithChildren,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { createConfig, http, injected, WagmiProvider } from 'wagmi'
import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { getDwellirRpcUrl } from '@/lib/dwellir'
import { installQueryPersistence } from '@/lib/query-persist'
import {
  ParaAuthContext,
  type ParaAddFundsRequest,
  type ParaRequest,
} from './ParaAuthContext'
import { ProjectRouteProvider } from './ProjectRouteContext'
import { lazyParaConnector } from './lazy-para-connector'
import { SignInPlaceholder } from './SignInPlaceholder'
import { externalWalletConnectors } from './wallet-connectors'
import { verifyMarkedParaSession } from './para-session'
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  sepolia,
} from 'wagmi/chains'

export const IS_DETERMINISTIC_BROWSER =
  process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'
const BROWSER_FIXTURE_ORIGIN =
  process.env.NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN ?? 'http://127.0.0.1:4399'

export { SUPPORTED_CHAINS } from '@/lib/chains'

const rpcTransport = (chainId: number, fixtureNetwork: string) => {
  if (IS_DETERMINISTIC_BROWSER) {
    return http(`${BROWSER_FIXTURE_ORIGIN}/rpc/${fixtureNetwork}`)
  }
  const url = getDwellirRpcUrl(chainId)
  return url ? http(url) : http()
}

const transports = {
  [mainnet.id]: rpcTransport(mainnet.id, 'mainnet'),
  [optimism.id]: rpcTransport(optimism.id, 'optimism-mainnet'),
  [base.id]: rpcTransport(base.id, 'base-mainnet'),
  [arbitrum.id]: rpcTransport(arbitrum.id, 'arbitrum-mainnet'),
  [sepolia.id]: rpcTransport(sepolia.id, 'sepolia'),
  [optimismSepolia.id]: rpcTransport(
    optimismSepolia.id,
    'optimism-sepolia',
  ),
  [baseSepolia.id]: rpcTransport(baseSepolia.id, 'base-sepolia'),
  [arbitrumSepolia.id]: rpcTransport(
    arbitrumSepolia.id,
    'arbitrum-sepolia',
  ),
}

const ParaModalHost = lazy(() => import('./ParaModalHost'))


/**
 * The app's single wagmi config — the one source of truth for connections,
 * chain switching, and writes. EIP-6963 discovery plus a generic injected
 * fallback cover browser wallets. Every remaining wallet — Para, WalletConnect,
 * Coinbase, Safe — sits behind a lazy delegate, so no vendor SDK is downloaded
 * until that wallet is picked or restored. `reconnect()` probes every connector
 * on mount, which is exactly what those delegates short-circuit.
 */
export const wagmiConfig = createConfig({
  chains: SUPPORTED_CHAINS,
  transports,
  connectors: IS_DETERMINISTIC_BROWSER
    ? []
    : [
        injected({ shimDisconnect: true }),
        lazyParaConnector(),
        ...externalWalletConnectors(),
      ],
  multiInjectedProviderDiscovery: !IS_DETERMINISTIC_BROWSER,
  ssr: true,
})

/**
 * Root providers: react-query + wagmi only. Both render children
 * synchronously, so server-rendered pages stream unblocked. The Para provider
 * intentionally does NOT wrap the app — it gates its entire subtree behind an
 * async client init (rendering nothing until Para's API responds), which
 * would break SSR, 404 statuses, and resilience. It's mounted as a
 * self-contained modal host instead (see ParaHost).
 */
export function Providers({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          gcTime: 10 * 60_000,
          retry: 1,
          refetchOnWindowFocus: false,
        },
      },
    })
    return client
  })
  // Last session's values are, by definition, values the server did not render, and
  // streamed segments keep hydrating after this effect fires. Seeding the cache before
  // the document settles re-renders a tree React is still matching against the server's
  // HTML, which it reports as a hydration failure.
  useEffect(() => {
    let teardown: (() => void) | undefined
    const restore = () => {
      teardown = installQueryPersistence(queryClient)
    }
    if (document.readyState === 'complete') restore()
    else window.addEventListener('load', restore, { once: true })
    return () => {
      window.removeEventListener('load', restore)
      teardown?.()
    }
  }, [queryClient])
  const [paraHostLoaded, setParaHostLoaded] = useState(false)
  const [paraRequestId, setParaRequestId] = useState(0)
  const [paraRequest, setParaRequest] = useState<ParaRequest>({ kind: 'auth' })
  const [paraModalOpen, setParaModalOpen] = useState(false)
  const [paraSessionVersion, setParaSessionVersion] = useState(0)

  // Preserve embedded-wallet sessions without penalizing anonymous visitors:
  // only a browser that previously completed Para auth loads its runtime.
  // Para's own session is authoritative; transient verification failures keep
  // the marker intact so a later page load can recover.
  useEffect(() => {
    if (!IS_DETERMINISTIC_BROWSER) void verifyMarkedParaSession()
  }, [])

  const requestSignIn = useCallback(() => {
    if (IS_DETERMINISTIC_BROWSER) return
    setParaHostLoaded(true)
    setParaRequest({ kind: 'auth' })
    setParaRequestId(current => current + 1)
  }, [])
  const requestAddFunds = useCallback((request: ParaAddFundsRequest) => {
    if (IS_DETERMINISTIC_BROWSER) return
    setParaHostLoaded(true)
    setParaRequest({ kind: 'addFunds', ...request })
    setParaRequestId(current => current + 1)
  }, [])
  const markParaSettled = useCallback(
    () => setParaSessionVersion(current => current + 1),
    [],
  )
  const paraAuth = useMemo(
    () => ({
      modalOpen: paraModalOpen,
      sessionVersion: paraSessionVersion,
      requestSignIn,
      requestAddFunds,
    }),
    [paraModalOpen, paraSessionVersion, requestSignIn, requestAddFunds],
  )

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider
        config={wagmiConfig}
        reconnectOnMount={!IS_DETERMINISTIC_BROWSER}
      >
        <ParaAuthContext.Provider value={paraAuth}>
          <ProjectRouteProvider>
            <TransactionReviewProvider>{children}</TransactionReviewProvider>
          </ProjectRouteProvider>
          {/* Para renders its own overlay, so it must stay in the browser's
              top layer: `openSignIn` is reachable from inside app modals
              (AddShopItemsModal, RedeemShopItemsModal), and everything outside
              the topmost `showModal()` dialog is inert — body-level portals
              included. ParaModalHost owns a `showModal()` dialog for exactly
              that reason. Any future overlay that renders to the body needs
              the same treatment before it can be opened from a modal. */}
          {paraHostLoaded ? (
            <Suspense
              fallback={
                paraRequest.kind === 'auth' ? <SignInPlaceholder /> : null
              }
            >
              <ParaModalHost
                requestId={paraRequestId}
                request={paraRequest}
                onOpenChange={setParaModalOpen}
                onSettled={markParaSettled}
              />
            </Suspense>
          ) : null}
        </ParaAuthContext.Provider>
      </WagmiProvider>
    </QueryClientProvider>
  )
}
