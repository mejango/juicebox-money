import { NATIVE_TOKEN, jbRouterTerminalRegistryAbi } from '@bananapus/nana-sdk-core'
import { buildPayTx } from '@bananapus/nana-sdk-core/v6'
import { ContractFunctionRevertedError, zeroAddress, type Address, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { attachedPaymentRouterEntries, readPaymentRouterEntry } from '@/lib/payment-router-entry'
import { rolloutAddress, rolloutChain } from '@/lib/protocol-rollout'
import * as rollout from '@/lib/protocol-rollout'
import { buildErc20ApproveRequest } from '@/lib/transaction-builders'

const chainId = 11155111
const registry = rolloutAddress('JBRouterTerminalRegistry', chainId)!
const gateway = rolloutAddress('JBRouterTerminalGateway', chainId)!
const router = rolloutAddress('JBRouterTerminal', chainId)!
const unknown = '0x1111111111111111111111111111111111111111' as Address
const args = { chainId, projectId: 3n, token: NATIVE_TOKEN, decimals: 18 }

function clientWith(readContract: ReturnType<typeof vi.fn>): Pick<PublicClient, 'readContract'> {
  return { readContract } as unknown as Pick<PublicClient, 'readContract'>
}

describe('attached payment router entry', () => {
  it.each([1, 10, 8453, 42161, chainId] as const)('keeps the recorded gateway as the preview, approval, and payment target when attached directly on chain %i', async deployedChainId => {
    const deployedGateway = rolloutAddress('JBRouterTerminalGateway', deployedChainId)!
    expect(deployedGateway).not.toBeNull()
    const readContract = vi.fn().mockResolvedValue([{ id: 1n }])
    const terminal = await readPaymentRouterEntry(clientWith(readContract), { ...args, chainId: deployedChainId, terminals: [deployedGateway] })
    expect(terminal).toBe(deployedGateway)
    expect(readContract).toHaveBeenCalledExactlyOnceWith({
      address: deployedGateway,
      abi: jbRouterTerminalRegistryAbi,
      functionName: 'previewPayFor',
      args: [3n, NATIVE_TOKEN, 10n ** 18n, '0x0000000000000000000000000000000000000001', '0x'],
    })
    expect(buildErc20ApproveRequest({ chainId: deployedChainId, token: unknown, spender: terminal!, amount: 1n }).args[0]).toBe(deployedGateway)
    expect(buildPayTx({ chainId: deployedChainId, terminal: terminal!, projectId: 3n, token: unknown, amount: 1n, beneficiary: unknown }).address).toBe(deployedGateway)
  })

  it.each([
    ['current', router],
    ...Object.entries(rolloutChain(chainId)!.history.JBRouterTerminal),
  ])('preserves an attached %s raw router', async (_generation, address) => {
    const terminal = address as Address
    const readContract = vi.fn().mockResolvedValue([{ id: 1n }])
    expect(await readPaymentRouterEntry(clientWith(readContract), { ...args, terminals: [terminal] })).toBe(terminal)
    expect(readContract).toHaveBeenCalledOnce()
    expect(readContract.mock.calls[0][0].address).toBe(terminal)
  })

  it('prefers an attached registry and never infers attachment from a direct entry', () => {
    expect(attachedPaymentRouterEntries(chainId, [gateway])).toEqual([gateway])
    expect(attachedPaymentRouterEntries(chainId, [gateway, registry])).toEqual([registry, gateway])
  })

  it('rejects unknown entries and a gateway whose chain deployment record is missing', async () => {
    const unrecordedGateway = rolloutAddress('JBRouterTerminalGateway', 1)!
    const recordedAddress = rollout.rolloutAddress
    vi.spyOn(rollout, 'rolloutAddress').mockImplementation((name, id) =>
      id === 1 && name === 'JBRouterTerminalGateway' ? null : recordedAddress(name, id),
    )
    const readContract = vi.fn()
    expect(await readPaymentRouterEntry(clientWith(readContract), { ...args, chainId: 1, terminals: [unrecordedGateway, unknown, zeroAddress] })).toBeNull()
    expect(readContract).not.toHaveBeenCalled()
  })

  it('tries another attached entry when the first contract rejects the token', async () => {
    const revert = new ContractFunctionRevertedError({ abi: jbRouterTerminalRegistryAbi, functionName: 'previewPayFor', message: 'Unsupported token' })
    const readContract = vi.fn().mockRejectedValueOnce(revert).mockResolvedValueOnce([{ id: 1n }])
    expect(await readPaymentRouterEntry(clientWith(readContract), { ...args, terminals: [registry, gateway] })).toBe(gateway)
    expect(readContract.mock.calls.map(call => call[0].address)).toEqual([registry, gateway])
  })

  it('treats a successful zero-ruleset preview as an unavailable route', async () => {
    const readContract = vi.fn().mockResolvedValue([{ id: 0n }])
    expect(await readPaymentRouterEntry(clientWith(readContract), { ...args, terminals: [gateway] })).toBeNull()
  })

  it('propagates an RPC failure without substituting a different entry and permits a fresh retry', async () => {
    const failure = new Error('RPC unavailable')
    const readContract = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce([{ id: 1n }])
    const client = clientWith(readContract)
    await expect(readPaymentRouterEntry(client, { ...args, terminals: [registry, gateway] })).rejects.toBe(failure)
    expect(readContract).toHaveBeenCalledOnce()
    expect(await readPaymentRouterEntry(client, { ...args, terminals: [registry, gateway] })).toBe(registry)
    expect(readContract).toHaveBeenCalledTimes(2)
  })

  it('rechecks the actual entry after the project changes its attached route', async () => {
    const readContract = vi.fn().mockResolvedValue([{ id: 1n }])
    const client = clientWith(readContract)
    expect(await readPaymentRouterEntry(client, { ...args, terminals: [router] })).toBe(router)
    expect(await readPaymentRouterEntry(client, { ...args, terminals: [gateway] })).toBe(gateway)
    expect(readContract.mock.calls.map(call => call[0].address)).toEqual([router, gateway])
  })
})
