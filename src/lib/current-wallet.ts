import { getAccount, getWalletClient, switchChain, type Config } from '@wagmi/core'
import { ReviewLineError, type WalletAdapter } from '@bananapus/nana-sdk-core/review'
import type { Address, Chain, WalletClient } from 'viem'
import { WalletNotInvokedError } from '@/lib/wallet-refusal'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

/** Acquisition and invocation share one continuation: never return a stale-capable client. */
type CurrentWalletAdapter = WalletAdapter & { withFinalCheck(check: () => void): WalletAdapter }

export function currentWalletAdapter(config: Config, isSafe: () => boolean, finalCheck?: () => void): CurrentWalletAdapter {
  const account = () => getAccount(config).address
  const chainId = () => getAccount(config).chainId
  // SDK 4 recognizes code 4001 as definitely unsent. This local mark is used only
  // before invoking a wallet method; real wallet errors never enter this catch.
  const unsent = (error: unknown, submission = false) => new WalletNotInvokedError(error, submission)
  async function invoke<T>(invokeWallet: (wallet: WalletClient, account: Address) => Promise<T>, submission = false): Promise<T> {
    const expected = account()
    if (!expected) throw unsent(new ReviewLineError('Connect a wallet first.'), submission)
    const chain = chainId()
    const safe = isSafe()
    const check = () => {
      if (getViewAs()) throw new ReviewLineError(VIEW_AS_WRITE_BLOCKED)
      if (account()?.toLowerCase() !== expected.toLowerCase()) throw new ReviewLineError('The connected account changed. Review again.')
      if (chainId() !== chain || isSafe() !== safe) throw new ReviewLineError('Wallet connection changed. Review the transaction again.')
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const connector = getAccount(config).connector
      let wallet: WalletClient
      try {
        check()
        try { wallet = await getWalletClient(config, { connector, account: expected }) as WalletClient }
        catch (error) {
          check()
          if (getAccount(config).connector?.uid !== connector?.uid) continue
          throw error
        }
        check()
        if (getAccount(config).connector?.uid !== connector?.uid) continue
        if (wallet.account && wallet.account.address.toLowerCase() !== expected.toLowerCase()) throw new ReviewLineError('The connected account changed. Review again.')
        finalCheck?.()
        check()
        if (getAccount(config).connector?.uid !== connector?.uid) continue
      } catch (error) { throw unsent(error, submission) }
      // No await or catch between final checks and invocation. Preserve real wallet errors.
      return invokeWallet(wallet, expected)
    }
    throw unsent(new ReviewLineError('Wallet connection changed. Review the transaction again.'), submission)
  }
  const chainOf = (wallet: WalletClient, target: number) => wallet.chain?.id === target ? wallet.chain : { id: target } as Chain
  return {
    kind: 'wallet', account, chainId, isSafe,
    withFinalCheck: check => currentWalletAdapter(config, isSafe, () => { finalCheck?.(); check() }),
    switchChain: async target => { await switchChain(config, { chainId: target as never }) },
    sendTransaction: tx => invoke((wallet, account) => wallet.sendTransaction({
      account, chain: chainOf(wallet, tx.chainId), to: tx.to, data: tx.data, value: tx.value,
      ...(tx.gas === undefined ? {} : { gas: tx.gas }),
    }), true),
    signTypedData: typedData => invoke((wallet, account) => {
      if (typedData.domain?.chainId !== undefined && chainId() !== Number(typedData.domain.chainId)) throw unsent(new ReviewLineError('Your wallet changed networks. Review again.'))
      return wallet.signTypedData({ ...typedData, account })
    }),
    signMessage: message => invoke((wallet, account) => wallet.signMessage({ account, message })),
    sendCalls: (target, calls) => invoke((wallet, account) => wallet.sendCalls({
      account, chain: chainOf(wallet, target), calls: calls.map(({ to, data, value }) => ({ to, data, value })),
    }), true).then(({ id }) => id),
  }
}
