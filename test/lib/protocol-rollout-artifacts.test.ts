import { describe, expect, it } from 'vitest'
const validatorPath = '../../scripts/lib/protocol-rollout-artifacts.mjs'
const { executedDeploymentAddress } = await import(validatorPath)

const executed = {
  contractName: 'JBRouterTerminalGateway',
  address: '0x1234567890123456789012345678901234567890',
  chainId: '0xaa36a7',
  receipt: { status: '0x1', blockNumber: '0x10', transactionHash: `0x${'ab'.repeat(32)}`, blockHash: `0x${'cd'.repeat(32)}` },
}

describe('canonical execution evidence', () => {
  it('accepts successful matching artifacts and absent deployments', () => {
    expect(executedDeploymentAddress(executed, 11155111, 'JBRouterTerminalGateway')).toBe(executed.address)
    expect(executedDeploymentAddress(null, 1, 'JBRouterTerminalGateway')).toBeNull()
  })

  it('rejects proposals, failed receipts and records for a different deployment', () => {
    for (const artifact of [
      { ...executed, receipt: undefined },
      { ...executed, receipt: { ...executed.receipt, status: '0x0' } },
      { ...executed, receipt: { ...executed.receipt, transactionHash: null } },
      { ...executed, receipt: { ...executed.receipt, blockHash: null } },
      { ...executed, receipt: { ...executed.receipt, blockNumber: '0x0' } },
      { ...executed, chainId: '0x1' },
      { ...executed, contractName: 'JBRouterTerminal' },
    ]) expect(() => executedDeploymentAddress(artifact, 11155111, 'JBRouterTerminalGateway')).toThrow('Unverified executed deployment')
  })
})
