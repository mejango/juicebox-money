import { decodeFunctionData, encodeFunctionData, type Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { buildBurnTokensRequest } from '@/lib/burnTokens'

const CONTROLLER = '0x1111111111111111111111111111111111111111' as Address
const HOLDER = '0x2222222222222222222222222222222222222222' as Address

describe('standalone token burning', () => {
  it('pins the reviewed write to the live controller, holder, project, amount, and memo', () => {
    const request = buildBurnTokensRequest({
      chainId: 1,
      controller: CONTROLLER,
      holder: HOLDER,
      projectId: 42n,
      tokenCount: 3n * 10n ** 18n,
      memo: '  reduce supply  ',
    })
    const data = encodeFunctionData(request)

    expect(request).toMatchObject({
      chainId: 1,
      address: CONTROLLER,
      functionName: 'burnTokensOf',
      args: [HOLDER, 42n, 3n * 10n ** 18n, 'reduce supply'],
    })
    expect(decodeFunctionData({ abi: request.abi, data })).toEqual({
      functionName: 'burnTokensOf',
      args: [HOLDER, 42n, 3n * 10n ** 18n, 'reduce supply'],
    })
  })

  it('rejects empty burns before reaching the wallet boundary', () => {
    expect(() =>
      buildBurnTokensRequest({
        chainId: 1,
        controller: CONTROLLER,
        holder: HOLDER,
        projectId: 42n,
        tokenCount: 0n,
        memo: '',
      }),
    ).toThrow(/greater than zero/u)
  })
})
