import { describe, expect, it } from 'vitest'
import { encodeFunctionData, zeroAddress } from 'viem'
import { jbBuybackHookRegistryAbi } from '@bananapus/nana-sdk-core'
import { encodeMultiSend, MULTI_SEND_CALL_ONLY } from '@bananapus/nana-sdk-core/safe'
import { queuedSafeReviewCall } from '@/lib/safe-queue-review'

const to = '0x1111111111111111111111111111111111111111'
const data = encodeFunctionData({ abi: jbBuybackHookRegistryAbi, functionName: 'setHookFor', args: [42n, zeroAddress] })

describe('queued Safe confirmation details', () => {
  it('decodes every action from the exact batch bytes, preserving arguments and values', () => {
    const call = queuedSafeReviewCall(1, { to: MULTI_SEND_CALL_ONLY, operation: 1, value: '0', data: encodeMultiSend([
      { to, data, value: 0n }, { to, data: '0xdeadbeef', value: 9n },
    ]) })
    expect(call.functionName).toBe('multiSend')
    expect(call.calls).toHaveLength(2)
    expect(call.calls?.[0]).toMatchObject({ to, data, functionName: 'setHookFor', args: [42n, zeroAddress], value: 0n })
    expect(call.calls?.[1]).toMatchObject({ to, data: '0xdeadbeef', value: 9n })
    expect(call.calls?.[1].abi).toBeUndefined()
  })

  it('does not present arbitrary delegatecalls as ordinary actions', () => {
    const call = queuedSafeReviewCall(1, { to, data, operation: 1, value: '0' })
    expect(call.label).toContain('DELEGATECALL')
    expect(call.functionName).toBeUndefined()
    expect(call.data).toBe(data)
  })

  it('keeps noncanonical MultiSend bytes intact for raw review', () => {
    const data = `${encodeMultiSend([{ to, data: '0x', value: 0n }])}00` as const
    const call = queuedSafeReviewCall(1, { to: MULTI_SEND_CALL_ONLY, data, operation: 1, value: '0' })
    expect(call.calls).toBeUndefined()
    expect(call.data).toBe(data)
  })
})
