import { describe, expect, it, vi } from 'vitest'
import { zeroAddress, type Address, type PublicClient } from 'viem'
import { readRouterPath, rolloutAddress, rolloutChain, rolloutContractName, rolloutTargets } from '@/lib/protocol-rollout'

const CHAIN = 11155111
const MAINNETS = [1, 10, 8453, 42161] as const
const gateway = rolloutAddress('JBRouterTerminalGateway', CHAIN)!
const router = rolloutAddress('JBRouterTerminal', CHAIN)!
const previous = rolloutChain(CHAIN)!.history.JBRouterTerminal.previous as Address

function clientFor(terminal: Address, { attached = true, failRouter = false, underlyingRouter = router } = {}) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'isTerminalOf') return attached
    if (functionName === 'terminalOf') return terminal
    if (functionName === 'ROUTER') {
      if (failRouter) throw new Error('RPC unavailable')
      return underlyingRouter
    }
    throw new Error(`Unexpected read: ${functionName}`)
  })
  return { readContract } as unknown as PublicClient & { readContract: typeof readContract }
}

describe('executed per-chain rollout', () => {
  it.each(MAINNETS)('exposes the recorded hook and gateway on mainnet chain %i while retaining earlier generations', chainId => {
    const hook = rolloutAddress('JBBuybackHook', chainId)
    const currentGateway = rolloutAddress('JBRouterTerminalGateway', chainId)
    const currentRouter = rolloutAddress('JBRouterTerminal', chainId)
    const history = rolloutChain(chainId)!.history
    expect(hook).not.toBeNull()
    expect(currentGateway).not.toBeNull()
    expect(currentRouter).not.toBeNull()
    expect(hook!.toLowerCase()).not.toBe(history.JBBuybackHook.previous)
    expect(currentRouter!.toLowerCase()).not.toBe(history.JBRouterTerminal.previous)
    expect(rolloutTargets(chainId)).toEqual({ hook, terminal: currentGateway })
    expect(rolloutContractName(chainId, currentGateway!)).toBe('JBRouterTerminalGateway (current)')
    expect(rolloutContractName(chainId, history.JBRouterTerminal.previous as Address)).toBe('JBRouterTerminal (previous)')
    expect(rolloutContractName(chainId, history.JBBuybackHook.v1 as Address)).toBe('JBBuybackHook (v1)')
  })

  it('recognizes previous and v1 targets after the canonical deployment changes', () => {
    expect(rolloutContractName(CHAIN, previous)).toBe('JBRouterTerminal (previous)')
    expect(rolloutContractName(CHAIN, rolloutChain(CHAIN)!.history.JBBuybackHook.v1 as Address)).toBe('JBBuybackHook (v1)')
    expect(rolloutContractName(CHAIN, gateway)).toBe('JBRouterTerminalGateway (current)')
  })
})

describe('effective project router path', () => {
  it.each(MAINNETS)('follows the live mainnet project selection on chain %i before and after gateway migration', async chainId => {
    const currentGateway = rolloutAddress('JBRouterTerminalGateway', chainId)!
    const currentRouter = rolloutAddress('JBRouterTerminal', chainId)!
    const previousRouter = rolloutChain(chainId)!.history.JBRouterTerminal.previous as Address
    const oldSelection = clientFor(previousRouter)
    expect(await readRouterPath(oldSelection, chainId, 2n)).toMatchObject({ terminal: previousRouter, gateway: null, router: previousRouter })
    expect(oldSelection.readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: 'ROUTER' }))

    const migratedSelection = clientFor(currentGateway, { underlyingRouter: currentRouter })
    expect(await readRouterPath(migratedSelection, chainId, 2n)).toMatchObject({ terminal: currentGateway, gateway: currentGateway, router: currentRouter })
    expect(migratedSelection.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: currentGateway, functionName: 'ROUTER' }))
  })

  it('resolves a selected gateway to its immutable router', async () => {
    const client = clientFor(gateway)
    expect(await readRouterPath(client, CHAIN, 2n)).toMatchObject({ terminal: gateway, gateway, router })
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: gateway, functionName: 'ROUTER' }))
  })

  it('keeps a previous selected router usable without assuming migration', async () => {
    const client = clientFor(previous)
    expect(await readRouterPath(client, CHAIN, 2n)).toMatchObject({ terminal: previous, gateway: null, router: previous })
    expect(client.readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: 'ROUTER' }))
  })

  it('does not invent a route for a detached registry or empty selection', async () => {
    expect(await readRouterPath(clientFor(gateway, { attached: false }), CHAIN, 2n)).toBeNull()
    expect(await readRouterPath(clientFor(zeroAddress), CHAIN, 2n)).toBeNull()
  })

  it('keeps unknown selections and failed underlying reads explicit', async () => {
    const unknown = '0x1234567890123456789012345678901234567890'
    expect(await readRouterPath(clientFor(unknown), CHAIN, 2n)).toMatchObject({ terminal: unknown, gateway: null, router: null })
    expect(await readRouterPath(clientFor(gateway, { failRouter: true }), CHAIN, 2n)).toMatchObject({ gateway, router: null })
  })
})
