import { decodeFunctionData, zeroHash, type Abi, type Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { tokenDeploySalt } from '@/components/project/AuthorityEditsCard'
import { omnichainTokenSalt } from '@/lib/manage'
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
})
