import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import { clearTabWriteRecovery, openWriteRecovery, writeNonceEvidence } from '@/lib/write-recovery'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const input = { chainId: 10, account: ACCOUNT, safe: false, call: { to: TARGET, data: '0x1234' as const, value: 5n } }

function storage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

async function reserve() {
  const journal = openWriteRecovery(input)
  return journal.withLock(async () => journal.reserve(undefined, { nonce: 3, blockNumber: 100n }))
}

describe('write recovery storage', () => {
  it("keeps a held write in the browser's storage, so it outlives a reload", async () => {
    const browser = storage()
    vi.stubGlobal('localStorage', browser)
    const record = await reserve()
    expect([...browser.values.values()].map(value => JSON.parse(value).id)).toEqual([record.id])
    expect(record).toMatchObject({ nonce: '3', fromBlock: '100' })
    expect(openWriteRecovery(input).read()?.id).toBe(record.id)
  })

  it("keeps it in this tab's memory where storage is refused, instead of refusing the write", async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('SecurityError') } })
    const record = await reserve()
    expect(openWriteRecovery(input).read()?.id).toBe(record.id)
    clearTabWriteRecovery()
    expect(openWriteRecovery(input).read()).toBeNull()
  })

  it("leaves no nonce evidence when the node can't say", async () => {
    const client = { getBlockNumber: vi.fn(async () => 100n), getTransactionCount: vi.fn(async (): Promise<number> => { throw new Error('rate limited') }) }
    await expect(writeNonceEvidence(client, ACCOUNT)).resolves.toBeUndefined()
    client.getTransactionCount.mockResolvedValueOnce(4)
    await expect(writeNonceEvidence(client, ACCOUNT)).resolves.toEqual({ nonce: 4, blockNumber: 100n })
    await expect(writeNonceEvidence(undefined, ACCOUNT)).resolves.toBeUndefined()
  })
})
