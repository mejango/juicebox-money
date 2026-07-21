'use client'

import { createParaWagmiConfig } from '@getpara/evm-wallet-connectors'
import ParaWeb, {
  ParaProvider,
  type Environment,
} from '@getpara/react-sdk-lite'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PropsWithChildren, useState } from 'react'
import { http, WagmiProvider } from 'wagmi'
import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
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
const PARA_API_KEY = process.env.NEXT_PUBLIC_PARA_API_KEY ?? ''
const INFURA_ID = process.env.NEXT_PUBLIC_INFURA_ID ?? ''

export const SUPPORTED_CHAINS = IS_TESTNET
  ? ([sepolia, optimismSepolia, baseSepolia, arbitrumSepolia] as const)
  : ([mainnet, optimism, base, arbitrum] as const)

const infura = (network: string) =>
  INFURA_ID
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

export const paraClient = new ParaWeb(
  (process.env.NEXT_PUBLIC_PARA_ENV as Environment) || 'BETA',
  PARA_API_KEY,
)

const APP = {
  appName: 'Juicebox',
  appDescription: 'Fund your thing. Programmable money for projects.',
  appUrl: 'https://juicebox.money',
}

const WALLET_CONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ?? ''

/**
 * The app's single wagmi config — the one source of truth for connections,
 * chain switching, and writes. It includes Para's `para` connector (bridging
 * embedded wallets into wagmi) plus the external wallet connectors.
 */
export const wagmiConfig = createParaWagmiConfig(paraClient, {
  appName: APP.appName,
  appDescription: APP.appDescription,
  appUrl: APP.appUrl,
  projectId: WALLET_CONNECT_PROJECT_ID,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore Para's connector types lag wagmi's chain tuple type.
  chains: SUPPORTED_CHAINS,
  transports,
  // Browser wallet connectors touch IndexedDB during initialization. Keep
  // them out of the server bundle so SSR cannot trip Next's error overlay and
  // leave an otherwise rendered page unable to receive pointer events.
  wallets:
    typeof window === 'undefined'
      ? []
      : WALLET_CONNECT_PROJECT_ID
        ? ['METAMASK', 'COINBASE', 'WALLETCONNECT']
        : ['METAMASK', 'COINBASE'],
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

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>
        <TransactionReviewProvider>{children}</TransactionReviewProvider>
      </WagmiProvider>
    </QueryClientProvider>
  )
}

/**
 * Hosts Para's auth modal and client machinery without wrapping any app
 * content. Email/social sign-in happens here; the resulting embedded wallet
 * reaches the app through wagmiConfig's `para` connector (see useWallet).
 * External wallets are deliberately excluded from the modal — they connect
 * through wagmiConfig directly so connection state lives in one place.
 */
export function ParaHost() {
  return (
    <ParaProvider
      paraClientConfig={paraClient}
      config={{ appName: APP.appName }}
      paraModalConfig={{
        authLayout: ['AUTH:FULL'],
        oAuthMethods: ['GOOGLE', 'TWITTER', 'APPLE', 'DISCORD', 'FARCASTER'],
        theme: {
          mode: 'light',
          backgroundColor: '#FFF7E8',
          foregroundColor: '#5777EB',
          borderRadius: 'md',
        },
      }}
      externalWalletConfig={{ wallets: [] }}
    >
      {null}
    </ParaProvider>
  )
}
