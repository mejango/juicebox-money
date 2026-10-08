import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '@wagmi/core'
import { captureWalletContext } from '@/lib/wallet-context'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

const state = vi.hoisted(() => ({ address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined, chainId: 1, connectorUid: 'reviewed' }))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: state.address, chainId: state.chainId, connector: { uid: state.connectorUid } }) }))
const account = '0x1111111111111111111111111111111111111111' as const
const config = {} as Config

beforeEach(() => {
  clearViewAs()
  state.address = account
  state.chainId = 1
  state.connectorUid = 'reviewed'
})

describe('reviewed wallet context', () => {
  it('permits the intentional target-chain switch during preparation', () => {
    const check = captureWalletContext(config, { account, chainId: 10 })
    state.chainId = 10
    expect(check).not.toThrow()
  })
  it.each(['account', 'disconnected', 'chain', 'connector', 'missing expected account'] as const)('refuses %s drift synchronously', drift => {
    const check = captureWalletContext(config, { account: drift === 'missing expected account' ? undefined : account, chainId: 1, message: 'Review again.' })
    if (drift === 'account') state.address = '0x2222222222222222222222222222222222222222'
    if (drift === 'disconnected') state.address = undefined
    if (drift === 'chain') state.chainId = 10
    if (drift === 'connector') state.connectorUid = 'replacement'
    expect(check).toThrow('Review again.')
  })
  it('refuses View as activated during preparation', () => {
    const check = captureWalletContext(config, { account, chainId: 1 })
    setViewAs(account)
    try { expect(check).toThrow(VIEW_AS_WRITE_BLOCKED) } finally { clearViewAs() }
  })
})
