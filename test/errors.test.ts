import { UnknownRpcError, InvalidInputRpcError, UserRejectedRequestError } from 'viem'
import { describe, expect, it } from 'vitest'

import { FlowError, friendlyError, shortError } from '@/lib/errors'
import { TransactionReviewCancelledError } from '@/lib/transaction-review'
import { transactionMessage } from '@/lib/transaction-message'

describe('rpc error text', () => {
  it('prefers the transport detail over viem generic labels', () => {
    const unknown = new UnknownRpcError(new Error('JB Center request failed (429)'))
    expect(shortError(unknown)).toBe('JB Center request failed (429)')
    expect(friendlyError(unknown)).toBe('JB Center request failed (429)')
    const invalid = new InvalidInputRpcError(new Error('intrinsic gas too high'))
    expect(shortError(invalid)).toBe('intrinsic gas too high')
  })

  it('keeps specific viem labels and the cancel mapping', () => {
    const rejected = new UserRejectedRequestError(new Error('User rejected the request.'))
    expect(shortError(rejected)).toBe('Transaction cancelled.')
    expect(friendlyError(rejected)).toBe('You cancelled in your wallet.')
    expect(shortError(new Error('plain\nsecond line'))).toBe('plain')
  })

  it('reports copy that is already user-ready as itself, even when it names cancelling', () => {
    const line = 'This launch\'s earlier signature may already have run. Check the project, then cancel this deployment to start over.'
    expect(friendlyError(new FlowError(line))).toBe(line)
    expect(friendlyError(new Error(line))).toBe('You cancelled in your wallet.')
  })

  it('reports a closed review or fee picker as itself, not as a wallet cancel', () => {
    const review = new TransactionReviewCancelledError()
    const picker = new TransactionReviewCancelledError('Funding chain selection cancelled. Nothing was sent.')
    expect(friendlyError(review)).toBe('Review closed. Nothing was sent.')
    expect(shortError(review)).toBe('Review closed. Nothing was sent.')
    expect(friendlyError(picker)).toBe('Funding chain selection cancelled. Nothing was sent.')
    expect(shortError(picker)).toBe('Funding chain selection cancelled. Nothing was sent.')
  })

  it('keeps the simulation reason and chain while leaving its error and diagnostics intact', () => {
    const cause = { status: 406, body: '{"SimulationReverted":{"transaction":{"chain":1,"data":"0x1234"}}}' }
    const error = new Error('Relayr HTTP 406: SimulationReverted on chain 1: execution reverted: GS013', { cause })
    const original = error.message
    expect(shortError(error)).toBe('Transaction simulation failed on chain 1: execution reverted: GS013')
    expect(friendlyError(error)).toBe('Transaction simulation failed on chain 1: execution reverted: GS013')
    expect(error.message).toBe(original)
    expect(error.cause).toBe(cause)
    expect(transactionMessage('Relayr HTTP 503: request denied')).toBe('Transaction request failed (HTTP 503): request denied')
    expect(friendlyError(new Error('Relayr HTTP 503: request denied'))).not.toMatch(/cancelled/)
    expect(shortError(new Error('Relayr HTTP 503: request denied'))).not.toMatch(/cancelled/)
  })

  it('presents legacy recovery text without changing funding uncertainty or verification claims', () => {
    const saved = { message: 'Your wallet may have sent the Relayr payment. Do not pay again.', title: 'Relayr bundle' }
    const original = JSON.stringify(saved)
    expect(transactionMessage(saved.message)).toBe('Your wallet may have sent the payment. Do not pay again.')
    expect(transactionMessage(saved.title)).toBe('Bundle')
    expect(transactionMessage('The Relayr entry differs from the selected Relayr option.')).toBe('The entry differs from the selected option.')
    expect(transactionMessage('Saved Relayr authorizations may still run.')).toBe('Saved authorizations may still run.')
    expect(transactionMessage('Relayr-reported; onchain proof pending')).toBe('Reported; onchain proof pending')
    expect(transactionMessage("Relayr's response could not be verified. Keep the original bundle pending.")).toBe("The execution service's response could not be verified. Keep the original bundle pending.")
    expect(JSON.stringify(saved)).toBe(original)
    expect(transactionMessage('GS013 on Ethereum. Keep the original bundle pending.')).toBe('GS013 on Ethereum. Keep the original bundle pending.')
  })
})
