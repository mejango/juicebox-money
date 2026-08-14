import type { Address, Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/Providers', () => ({
  wagmiConfig: {},
  SUPPORTED_CHAINS: [
    { id: 1, name: 'Ethereum' },
    { id: 10, name: 'Optimism' },
  ],
}))

import {
  RelayrExecutionError,
  RelayrPaymentSubmittedError,
  relayrCallsScope,
  relayrDestinationHash,
  relayrErrorIsUncertain,
  relayrPaymentLabel,
  relayrProgress,
  relayrRecordChain,
  relayrStateIsFailed,
  relayrStateIsSuccess,
  saveRelayrPendingSession,
  type RelayrCall,
  type RelayrPendingSession,
} from '@/lib/relayr'

const TARGET = '0x1111111111111111111111111111111111111111' as Address
const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address
const PAYMENT_HASH = `0x${'ab'.repeat(32)}` as Hex
const DESTINATION_HASH = `0x${'cd'.repeat(32)}` as Hex

describe('Relayr deterministic planning', () => {
  const calls: RelayrCall[] = [
    { chainId: 1, target: TARGET, data: '0x1234', value: 5n },
    { chainId: 10, target: ACCOUNT, data: '0xabcd' },
  ]

  it('scopes pending sessions to the ordered chain/target/data/value tuple', () => {
    const scope = relayrCallsScope(calls)

    expect(scope).toMatch(/^authority:0x[0-9a-f]{64}$/)
    expect(relayrCallsScope(calls)).toBe(scope)
    expect(relayrCallsScope([...calls].reverse())).not.toBe(scope)
    expect(relayrCallsScope([{ ...calls[0], value: 6n }, calls[1]])).not.toBe(
      scope,
    )
  })

  it('normalizes success/failure states and preserves missing expected rows', () => {
    expect(relayrStateIsSuccess(' Completed ')).toBe(true)
    expect(relayrStateIsSuccess('pending')).toBe(false)
    expect(relayrStateIsFailed(' FAILED ')).toBe(true)
    expect(
      relayrProgress(
        [
          { status: { state: 'success' } },
          { status: { state: 'failed' } },
          { status: { state: 'submitted' } },
        ],
        4,
      ),
    ).toEqual({ confirmed: 1, failed: 1, pending: 2, total: 4 })
  })

  it('keeps paid-but-unknown outcomes explicitly uncertain', () => {
    const submitted = new RelayrPaymentSubmittedError(PAYMENT_HASH, 1)
    const timeout = new RelayrExecutionError(
      'still processing',
      'RELAYR_TIMEOUT',
      'bundle-1',
      [],
      true,
    )
    const failed = new RelayrExecutionError(
      'failed',
      'RELAYR_FAILED',
      'bundle-1',
      [],
      false,
    )

    expect(relayrErrorIsUncertain(submitted)).toBe(true)
    expect(relayrErrorIsUncertain(timeout)).toBe(true)
    expect(relayrErrorIsUncertain(failed)).toBe(false)
    expect(submitted.message).toMatch(/Do not pay again/)
  })

  it('labels payments in native units without losing their chain identity', () => {
    expect(
      relayrPaymentLabel({
        chain: 10,
        amount: '1000000000000000',
        calldata: '0x',
        target: TARGET,
      }),
    ).toBe('Optimism — ~0.00100 ETH')
  })
})

describe('Relayr pending-session snapshots', () => {
  it('stores only resumable status fields and filters invalid chain IDs', () => {
    const session: RelayrPendingSession = {
      bundleUuid: 'bundle-1',
      paymentHash: PAYMENT_HASH,
      paymentChainId: 1,
      paymentStatus: 'submitted',
      chainIds: [1, -1, 10, 1.5],
      expectedCount: 2,
      records: [
        {
          tx_uuid: 'fedcba98-7654-3210-fedc-ba9876543210',
          request: {
            chain: 1,
            target: TARGET,
            data: '0x1234',
            value: '5',
            virtual_nonce: 0,
          },
          status: {
            state: 'success',
            data: { transaction: { hash: DESTINATION_HASH } },
          },
        },
      ],
      itemCount: 2,
      account: ACCOUNT,
      createdAt: 123,
    }

    const saved = saveRelayrPendingSession('scope', session)

    expect(saved.chainIds).toEqual([1, 10])
    expect(saved.records).toEqual([
      {
        chain: 1,
        tx_uuid: 'fedcba98-7654-3210-fedc-ba9876543210',
        request: {
          chain: 1,
          target: TARGET,
          data: '0x1234',
          value: '5',
          virtual_nonce: 0,
        },
        status: { state: 'success', data: { hash: DESTINATION_HASH } },
      },
    ])
    expect(relayrDestinationHash(saved.records[0])).toBe(DESTINATION_HASH)
    expect(relayrRecordChain(saved.records[0])).toBe(1)
  })

  it('prefers a direct destination hash and handles absent status data', () => {
    expect(
      relayrDestinationHash({
        status: {
          data: {
            hash: DESTINATION_HASH,
            transaction: { hash: PAYMENT_HASH },
          },
        },
      }),
    ).toBe(DESTINATION_HASH)
    expect(relayrDestinationHash({})).toBeNull()
  })
})
