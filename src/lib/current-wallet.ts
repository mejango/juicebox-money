import { getAccount, getWalletClient, switchChain, type Config } from '@wagmi/core'
import { ReviewLineError, viemWalletAdapter, type WalletAdapter } from '@bananapus/nana-sdk-core/review'
import type { WalletClient } from 'viem'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

/** Core's wallet adapter over the connected wagmi connector, checked again as each request reaches the wallet. */
type CurrentWalletAdapter = WalletAdapter & { withFinalCheck(check: () => void): WalletAdapter }

export function currentWalletAdapter(config: Config, isSafe: () => boolean, finalCheck?: () => void): CurrentWalletAdapter {
  return {
    ...viemWalletAdapter({
      walletClient: () => {
        const { connector, address } = getAccount(config)
        return getWalletClient(config, { connector, account: address }) as Promise<WalletClient>
      },
      account: () => getAccount(config).address,
      chainId: () => getAccount(config).chainId,
      isSafe,
      switchChain: target => switchChain(config, { chainId: target as never }),
      connector: () => getAccount(config).connector?.uid,
      check: () => {
        if (getViewAs()) throw new ReviewLineError(VIEW_AS_WRITE_BLOCKED)
        finalCheck?.()
      },
    }),
    withFinalCheck: check => currentWalletAdapter(config, isSafe, () => { finalCheck?.(); check() }),
  }
}
