import { createWalletClient, custom, hexToBigInt, numberToHex, type Address, type Hex, type WalletClient } from 'viem'

type Sent = { account?: Address; chain: { id: number }; to: Address; data: Hex; value: bigint; gas?: bigint }

/**
 * A real viem wallet client whose provider hands each `eth_sendTransaction` to `send`, as a test's
 * fake wallet takes it. Core's wallet adapter checks the connection at the provider request, so a
 * fake wallet must be reached through a provider, never as an object with methods.
 */
export function viemWallet(
  send: (tx: Sent) => Promise<Hex> | Hex,
  chainId: () => number | undefined,
  /** A Safe app's `wallet_sendCalls`, when the fake wallet takes batches. */
  sendCalls?: (batch: { calls: readonly { to: Address; data: Hex; value?: bigint }[] }) => Promise<{ id: Hex }>,
): WalletClient {
  return createWalletClient({
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method === 'eth_chainId') return numberToHex(chainId() ?? 1)
        if (method === 'wallet_sendCalls' && sendCalls) {
          const [batch] = params as [{ calls: { to: Address; data?: Hex; value?: Hex }[] }]
          return sendCalls({ calls: batch.calls.map(call => ({ to: call.to, data: call.data ?? '0x', value: call.value ? hexToBigInt(call.value) : 0n })) })
        }
        if (method !== 'eth_sendTransaction') throw new Error(`Unexpected wallet request ${method}`)
        const [tx] = params as [{ from?: Address; to: Address; data?: Hex; value?: Hex; gas?: Hex; chainId?: Hex }]
        return send({
          ...(tx.from ? { account: tx.from } : {}),
          chain: { id: Number(tx.chainId ?? numberToHex(chainId() ?? 1)) },
          to: tx.to,
          data: tx.data ?? '0x',
          value: tx.value ? hexToBigInt(tx.value) : 0n,
          ...(tx.gas ? { gas: hexToBigInt(tx.gas) } : {}),
        })
      },
    }, { retryCount: 0 }),
  })
}
