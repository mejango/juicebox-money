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
import { ParaAuthContext } from './ParaAuthContext'
import { lazyParaConnector } from './lazy-para-connector'
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

const IS_TESTNET = process.env.NEXT_PUBLIC_TESTNET === 'true'
const INFURA_ID = process.env.NEXT_PUBLIC_INFURA_ID ?? ''
export const IS_DETERMINISTIC_BROWSER =
  process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'
const BROWSER_FIXTURE_ORIGIN =
  process.env.NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN ?? 'http://127.0.0.1:4399'

export const SUPPORTED_CHAINS = IS_TESTNET
  ? ([sepolia, optimismSepolia, baseSepolia, arbitrumSepolia] as const)
  : ([mainnet, optimism, base, arbitrum] as const)

// A direct project URL may target either environment. Keep all supported
// chains available for client-side reads while preserving the environment's
// narrower discovery/create defaults above.
const WAGMI_CHAINS = [
  mainnet,
  optimism,
  base,
  arbitrum,
  sepolia,
  optimismSepolia,
  baseSepolia,
  arbitrumSepolia,
] as const

const infura = (network: string) =>
  IS_DETERMINISTIC_BROWSER
    ? http(`${BROWSER_FIXTURE_ORIGIN}/rpc/${network}`)
    : INFURA_ID
    ? http(`https://${network}.infura.io/v3/${INFURA_ID}`)
    : http()

const transports = {
  [mainnet.id]: infura('mainnet'),
  [optimism.id]: infura('optimism-mainnet'),
  [base.id]: infura('base-mainnet'),
  [arbitrum.id]: infura('arbitrum-mainnet'),
  [sepolia.id]: infura('sepolia'),
  [optimismSepolia.id]: infura('optimism-sepolia'),
  [baseSepolia.id]: infura('base-sepolia'),
  [arbitrumSepolia.id]: infura('arbitrum-sepolia'),
}

const ParaModalHost = lazy(() => import('./ParaModalHost'))

/**
 * The app's single wagmi config — the one source of truth for connections,
 * chain switching, and writes. Para has a stable, publicly configured lazy
 * connector: its SDK is not imported until a marked session is restored or an
 * auth attempt settles. EIP-6963 discovery plus a generic injected fallback
 * cover browser wallets without eager vendor SDKs.
 */
export const wagmiConfig = createConfig({
  chains: WAGMI_CHAINS,
  transports,
  connectors: IS_DETERMINISTIC_BROWSER
    ? []
    : [injected({ shimDisconnect: true }), lazyParaConnector()],
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
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 10 * 60_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  )
  const [paraHostLoaded, setParaHostLoaded] = useState(false)
  const [paraRequestId, setParaRequestId] = useState(0)
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
    }),
    [paraModalOpen, paraSessionVersion, requestSignIn],
  )

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider
        config={wagmiConfig}
        reconnectOnMount={!IS_DETERMINISTIC_BROWSER}
      >
        <ParaAuthContext.Provider value={paraAuth}>
          <TransactionReviewProvider>{children}</TransactionReviewProvider>
          {paraHostLoaded ? (
            <Suspense fallback={null}>
              <ParaModalHost
                requestId={paraRequestId}
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
