// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import { WalletBalances } from '@/components/WalletBalances'

const reads = vi.hoisted(() => ({ native: vi.fn(), usdc: vi.fn() }))
vi.mock('wagmi', () => ({
  useBalance: ({ address, chainId }: { address: Address; chainId: number }) => useQuery({
    queryKey: ['wallet-native', address, chainId], queryFn: reads.native, retry: false,
  }),
  useReadContract: ({ args, chainId }: { args: [Address]; chainId: number }) => useQuery({
    queryKey: ['wallet-usdc', args[0], chainId], queryFn: reads.usdc, retry: false,
  }),
}))
const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let host: HTMLDivElement | undefined
let root: Root | undefined
let queries: QueryClient | undefined
const values = () => Array.from(host!.querySelectorAll('dd')).map(row => row.textContent)
async function waitFor(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    check()
  })
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); queries?.clear() })

describe('wallet balance query recovery', () => {
  it('follows actual pending, failed and recovered query states independently for native currency and USDC', async () => {
    const native = deferred<{ value: bigint }>()
    const usdc = deferred<bigint>()
    reads.native.mockReset().mockReturnValueOnce(native.promise)
    reads.usdc.mockReset().mockReturnValueOnce(usdc.promise)
    queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    host = document.createElement('div'); document.body.append(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(<QueryClientProvider client={queries!}><WalletBalances address={ACCOUNT} chainId={1} /></QueryClientProvider>)
    })
    expect(values()).toEqual(['Loading…', 'Loading…'])
    await act(async () => { native.reject(new Error('RPC unavailable')); usdc.resolve(0n) })
    await waitFor(() => expect(values()).toEqual(['Unavailable', '0 USDC']))

    const recoveredNative = deferred<{ value: bigint }>()
    reads.native.mockReturnValueOnce(recoveredNative.promise)
    let nativeRetry!: Promise<void>
    await act(async () => { nativeRetry = queries!.refetchQueries({ queryKey: ['wallet-native', ACCOUNT, 1] }) })
    await waitFor(() => expect(values()).toEqual(['Loading…', '0 USDC']))
    await act(async () => { recoveredNative.resolve({ value: 0n }); await nativeRetry })
    await waitFor(() => expect(values()).toEqual(['0 ETH', '0 USDC']))

    reads.usdc.mockRejectedValueOnce(new Error('USDC read failed after a cached success'))
    await act(async () => { await queries!.refetchQueries({ queryKey: ['wallet-usdc', ACCOUNT, 1] }) })
    await waitFor(() => expect(values()).toEqual(['0 ETH', 'Unavailable']))
    reads.usdc.mockResolvedValueOnce(12_500_000n)
    await act(async () => { await queries!.refetchQueries({ queryKey: ['wallet-usdc', ACCOUNT, 1] }) })
    await waitFor(() => expect(values()).toEqual(['0 ETH', '12.5 USDC']))
    expect(reads.native).toHaveBeenCalledTimes(2)
    expect(reads.usdc).toHaveBeenCalledTimes(3)
  })
})
