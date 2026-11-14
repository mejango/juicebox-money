import { decodeFunctionData, zeroHash, type Abi, type Address } from 'viem'
import { JBCoreContracts, jbV6ContractAddress } from '@bananapus/nana-sdk-core'
import { describe, expect, it } from 'vitest'
import { tokenDeployPlan, tokenDeploySalt } from '@/components/project/AuthorityEditsCard'
import { legacyTokenSalt, omnichainTokenSalt, predictTokenAddress } from '@/lib/manage'
import { buildDeployTokenAuthorityCall } from '@/lib/transaction-builders'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const CONTROLLER = '0x2222222222222222222222222222222222222222' as Address
const TOKEN = '0x3333333333333333333333333333333333333333' as Address

/** One chain of the project, as the Edits card reads it. */
function chain(
  chainId: number,
  projectId: number,
  token: { address: Address; name: string; symbol: string } | null = null,
) {
  return {
    chainId,
    projectId,
    token: token?.address ?? null,
    tokenName: token?.name ?? null,
    tokenSymbol: token?.symbol ?? null,
  }
}

/** The multichain "Set token metadata" review, for chains without a token. */
function deployCalls(
  rows: ReturnType<typeof chain>[],
  name: string,
  symbol: string,
) {
  const salt = tokenDeploySalt(rows, name, symbol)
  return rows
    .filter(row => !row.token)
    .map(row =>
      buildDeployTokenAuthorityCall({
        chainId: row.chainId as 1,
        authority: OWNER,
        controller: CONTROLLER,
        projectId: BigInt(row.projectId),
        name: name.trim(),
        symbol,
        salt,
      }),
    )
}

function saltsOf(calls: ReturnType<typeof deployCalls>) {
  return calls.map(call => {
    const decoded = decodeFunctionData({ abi: call.abi as Abi, data: call.data })
    return (decoded.args as readonly unknown[])[3] as string
  })
}

describe('tokenDeploySalt', () => {
  it('gives every chain of one deploy the same non-zero salt', () => {
    // Project ids differ per chain, so the salt may not be derived from them.
    const rows = [chain(1, 5), chain(8453, 12), chain(10, 7)]
    const calls = deployCalls(rows, ' Example Token ', 'EXAM')
    const salts = saltsOf(calls)

    expect(calls).toHaveLength(3)
    expect(new Set(salts).size).toBe(1)
    expect(salts[0]).not.toBe(zeroHash)
    expect(salts[0]).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('is stable across rebuilds of the same review, so a retry re-deploys to the same address', () => {
    const rows = [chain(1, 5), chain(8453, 12)]
    expect(saltsOf(deployCalls(rows, 'Example Token', 'EXAM'))).toEqual(
      saltsOf(deployCalls(rows, ' Example Token', 'EXAM ')),
    )
  })

  it('anchors on an already-deployed token so a rename cannot move the address', () => {
    const rows = [
      chain(1, 5, { address: TOKEN, name: 'Original', symbol: 'ORIG' }),
      chain(8453, 12),
    ]
    const salts = saltsOf(deployCalls(rows, 'Renamed Token', 'RENAME'))

    expect(salts).toEqual([omnichainTokenSalt('Original', 'ORIG')])
    expect(salts[0]).not.toBe(omnichainTokenSalt('Renamed Token', 'RENAME'))
  })

  it('separates distinct tokens so one signer’s deploys do not collide', () => {
    expect(omnichainTokenSalt('Example Token', 'EXAM')).not.toBe(
      omnichainTokenSalt('Other Token', 'EXAM'),
    )
    expect(omnichainTokenSalt('Example Token', 'EXAM')).not.toBe(
      omnichainTokenSalt('Example Token', 'OTHER'),
    )
  })

  it('encodes the deploy against the project’s own controller and chain id', () => {
    const [call] = deployCalls([chain(8453, 12)], 'Example Token', 'EXAM')
    const decoded = decodeFunctionData({ abi: call.abi as Abi, data: call.data })

    expect(call.chainId).toBe(8453)
    expect(call.target).toBe(CONTROLLER)
    expect(call.functionName).toBe('deployERC20For')
    expect((decoded.args as readonly unknown[]).slice(0, 3)).toEqual([
      12n,
      'Example Token',
      'EXAM',
    ])
  })

  describe('extending an existing token', () => {
    const live = {
      sender: '0x5a6d1c0e1e6b0c9d2e2e5b6c5d7e8f9a0b1c2d3e' as Address,
      controller: CONTROLLER,
      implementation: '0x4444444444444444444444444444444444444444' as Address,
    }
    const row = (chainId: number, projectId: number, token: Address | null) => ({
      chainId,
      projectId,
      name: `chain ${chainId}`,
      authority: live.sender,
      controller: live.controller,
      tokenImplementation: live.implementation,
      token,
      tokenName: token ? 'Original' : null,
      tokenSymbol: token ? 'ORIG' : null,
    })
    const tokensOn = (chainId: number) =>
      jbV6ContractAddress[JBCoreContracts.JBTokens][chainId as 1]

    it('keeps the shared salt when it reproduces the existing address', () => {
      const salt = omnichainTokenSalt('Original', 'ORIG')
      const token = predictTokenAddress({ ...live, tokens: tokensOn(8453), salt })
      const plan = tokenDeployPlan([row(1, 5, token), row(8453, 12, null)], 'New', 'NEW')
      expect(plan).toMatchObject({ salt, sameAddress: true })
    })

    it('falls back to the older Juicescan salt when that is the one that matches', () => {
      const salt = legacyTokenSalt(5n, 'ORIG')
      const token = predictTokenAddress({ ...live, tokens: tokensOn(8453), salt })
      const plan = tokenDeployPlan([row(1, 5, token), row(8453, 12, null)], 'New', 'NEW')
      expect(plan).toMatchObject({ salt, sameAddress: true })
    })

    it('says so when this account cannot reproduce the address', () => {
      const plan = tokenDeployPlan([row(1, 5, TOKEN), row(8453, 12, null)], 'New', 'NEW')
      expect(plan).toMatchObject({
        salt: omnichainTokenSalt('Original', 'ORIG'),
        sameAddress: false,
      })
    })

    it('only checks the chains being deployed to', () => {
      const salt = omnichainTokenSalt('Original', 'ORIG')
      const token = predictTokenAddress({ ...live, tokens: tokensOn(8453), salt })
      const other = { ...row(10, 7, null), authority: OWNER }
      const rows = [row(1, 5, token), row(8453, 12, null), other]
      expect(tokenDeployPlan(rows, 'New', 'NEW', new Set([8453])).sameAddress).toBe(true)
      expect(tokenDeployPlan(rows, 'New', 'NEW').sameAddress).toBe(false)
    })
  })

  it('predicts the address of a live token (GLORY on Base)', () => {
    expect(
      predictTokenAddress({
        sender: '0x19ce092bc3f9662e40c4670c68ff03c8322d0e76',
        salt: '0x5d47b2cdb7e79169820a6610386dbb301fad7dc98980fac0c7286d08d984a111',
        controller: '0x3fcec3572e84b624477bcff4e2cf1f7deab648f1',
        tokens: '0x1f80d8f057eE36b4C2656D107E4e4558B71bA7D9',
        implementation: '0x6DB9Cf17222D8DE2012Fe13B9FA5bB7981fa0b17',
      }).toLowerCase(),
    ).toBe('0xe940dd603fa8cf3f67d4e465d785fb261c41f1db')
  })
})
