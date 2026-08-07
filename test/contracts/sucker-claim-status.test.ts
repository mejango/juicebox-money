// Claim status must come from the CHAIN, not the indexer. jbm assembles its movement list
// from indexed outbox/claim rows, so under indexer lag an already-claimed move still shows a
// Claim button — and a move whose root hasn't arrived yet looks claimable too. The SDK
// verifies each leaf against the destination inbox root, so its `status` is authoritative;
// `buildClaim` refuses rather than sending a transaction that must revert.
import { buildClaim } from '@/lib/sucker-claims'
import { describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'

const LEAF = {
  index: 7n,
  beneficiary: `0x${'00'.repeat(12)}${'11'.repeat(20)}` as const,
  projectTokenCount: 1000n,
  terminalTokenAmount: 500n,
}

const indexed = {
  index: 7,
  sourceSucker: '0x1111111111111111111111111111111111111111',
  destSucker: '0x2222222222222222222222222222222222222222',
  token: '0x3333333333333333333333333333333333333333',
  beneficiary: `0x${'11'.repeat(20)}`,
  projectTokenCount: '1000',
  terminalTokenAmount: '500',
  sourceChainId: 1,
  destChainId: 8453,
} as unknown as Parameters<typeof buildClaim>[2]

function movementWith(status: string, proof: unknown = { branch: [], leaf: LEAF }) {
  return [{ leaf: LEAF, status, proof }]
}

const mocks = vi.hoisted(() => ({ getSuckerMovements: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSuckerMovements: mocks.getSuckerMovements,
  claimFromSuckerMovement: () => ({ ok: true }),
}))

const client = {} as PublicClient

describe('buildClaim status gate', () => {
  it('refuses a movement the chain says is already claimed', async () => {
    mocks.getSuckerMovements.mockResolvedValue(movementWith('claimed'))
    await expect(buildClaim(client, client, indexed)).rejects.toThrow(/already been claimed/i)
  })

  it('refuses a movement whose root has not been delivered yet', async () => {
    mocks.getSuckerMovements.mockResolvedValue(movementWith('pending', null))
    await expect(buildClaim(client, client, indexed)).rejects.toThrow(/not been delivered/i)
  })

  it('refuses a claimable movement that carries no verified proof', async () => {
    mocks.getSuckerMovements.mockResolvedValue(movementWith('claimable', null))
    await expect(buildClaim(client, client, indexed)).rejects.toThrow(/not been delivered/i)
  })

  it('builds the claim when the chain says it is claimable and proved', async () => {
    mocks.getSuckerMovements.mockResolvedValue(movementWith('claimable'))
    await expect(buildClaim(client, client, indexed)).resolves.toEqual({ ok: true })
  })
})
