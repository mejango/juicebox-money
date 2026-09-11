import { describe, expect, it, vi } from 'vitest'
import { zeroAddress, type Address, type PublicClient } from 'viem'
import { readRouterPath, rolloutAddress, rolloutChain, rolloutContractName } from '@/lib/protocol-rollout'

const CHAIN = 11155111
const gateway = rolloutAddress('JBRouterTerminalGateway', CHAIN)!
const router = rolloutAddress('JBRouterTerminal', CHAIN)!
const previous = rolloutChain(CHAIN)!.history.JBRouterTerminal.previous as Address

function clientFor(terminal: Address, { attached = true, failRouter = false } = {}) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'isTerminalOf') return attached
    if (functionName === 'terminalOf') return terminal
    if (functionName === 'ROUTER') {
      if (failRouter) throw new Error('RPC unavailable')
      return router
    }
    throw new Error(`Unexpected read: ${functionName}`)
  })
  return { readContract } as unknown as PublicClient & { readContract: typeof readContract }
}

describe('executed per-chain rollout', () => {
  it('recognizes previous and v1 targets after the canonical deployment changes', () => {
    expect(rolloutContractName(CHAIN, previous)).toBe('JBRouterTerminal (previous)')
    expect(rolloutContractName(CHAIN, rolloutChain(CHAIN)!.history.JBBuybackHook.v1 as Address)).toBe('JBBuybackHook (v1)')
    expect(rolloutContractName(CHAIN, gateway)).toBe('JBRouterTerminalGateway (current)')
  })
})

describe('effective project router path', () => {
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
