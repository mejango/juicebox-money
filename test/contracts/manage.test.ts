import {
  JBCoreContracts,
  jbContractAddress,
  jbControllerAbi,
} from '@bananapus/nana-sdk-core'
import { decodeFunctionData, encodeFunctionData, type Address } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  buildDeployTokenRequest,
  buildSetUriTx,
  isKnownController,
} from '@/lib/manage'

const OTHER = '0x1111111111111111111111111111111111111111' as Address
const SALT = `0x${'ab'.repeat(32)}` as const

describe('owner-management requests', () => {
  const controller = jbContractAddress['6'][JBCoreContracts.JBController][1] as Address

  it('only treats the canonical controller as a supported write target', () => {
    expect(isKnownController(1, controller)).toBe(true)
    expect(isKnownController(1, controller.toUpperCase() as Address)).toBe(true)
    expect(isKnownController(1, OTHER)).toBe(false)
    expect(isKnownController(1, undefined)).toBe(false)
  })

  it('encodes setUriOf against the selected project controller', () => {
    const request = buildSetUriTx({
      chainId: 1,
      projectId: 42n,
      projectUri: 'ipfs://QmMetadata',
      controller,
    })
    const data = encodeFunctionData(request)
    const decoded = decodeFunctionData({ abi: jbControllerAbi, data })

    expect(request.address).toBe(controller)
    expect(data.slice(0, 10)).toBe('0x702a3977')
    expect(decoded.args).toEqual([42n, 'ipfs://QmMetadata'])
  })

  it('encodes deterministic deployERC20For args and validates symbols', () => {
    const request = buildDeployTokenRequest({
      chainId: 1,
      projectId: 42n,
      name: '  Example Token  ',
      symbol: 'EXAMPLE',
      salt: SALT,
      controller,
    })
    const data = encodeFunctionData(request)
    const decoded = decodeFunctionData({ abi: request.abi, data })

    expect(data.slice(0, 10)).toBe('0x58178191')
    expect(decoded.args).toEqual([42n, 'Example Token', 'EXAMPLE', SALT])
    expect(() =>
      buildDeployTokenRequest({
        chainId: 1,
        projectId: 42n,
        name: 'Token',
        symbol: 'lowercase',
        salt: SALT,
      }),
    ).toThrow(/uppercase letters or digits/)
  })
})
