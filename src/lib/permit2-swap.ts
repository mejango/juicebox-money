import type { TxRequest } from '@/hooks/useSafeTx'
import { encodeAbiParameters, type Address, type Hex } from 'viem'

export const PERMIT2_ADDRESS: Address =
  '0x000000000022D473030F116dDEE9F6B43aC78BA3'

export const PERMIT2_TYPES = {
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
} as const

export type Permit2SignatureAuthorization = {
  chainId: number
  token: Address
  spender: Address
  amount: bigint
  expiration: number
  nonce: number
  sigDeadline: bigint
}

export function shouldUsePermit2Signature({
  needsApproval,
  walletLookupSettled,
  walletBytecode,
  isSafe,
}: {
  needsApproval: boolean
  walletLookupSettled: boolean
  walletBytecode?: Hex
  isSafe: boolean
}): boolean {
  return (
    needsApproval &&
    walletLookupSettled &&
    !walletBytecode &&
    !isSafe
  )
}

export function permit2TypedData(
  authorization: Permit2SignatureAuthorization,
) {
  return {
    domain: {
      name: 'Permit2' as const,
      chainId: authorization.chainId,
      verifyingContract: PERMIT2_ADDRESS,
    },
    types: PERMIT2_TYPES,
    primaryType: 'PermitSingle' as const,
    message: {
      details: {
        token: authorization.token,
        amount: authorization.amount,
        expiration: authorization.expiration,
        nonce: authorization.nonce,
      },
      spender: authorization.spender,
      sigDeadline: authorization.sigDeadline,
    },
  }
}

/** Prepend Universal Router's PERMIT2_PERMIT command to an exact V4 swap. */
export function addPermit2SignatureToSwap(
  request: TxRequest,
  authorization: Permit2SignatureAuthorization,
  signature: Hex,
): TxRequest {
  if (
    request.functionName !== 'execute' ||
    request.address.toLowerCase() !== authorization.spender.toLowerCase()
  ) {
    throw new Error('The reviewed Permit2 authorization does not match the swap.')
  }
  const [commands, inputs, deadline] = request.args as readonly [
    Hex,
    readonly Hex[],
    bigint,
  ]
  if (commands.toLowerCase() !== '0x10' || inputs.length !== 1) {
    throw new Error('The reviewed swap has an unsupported Universal Router shape.')
  }
  const permitInput = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            type: 'tuple',
            components: [
              { type: 'address' },
              { type: 'uint160' },
              { type: 'uint48' },
              { type: 'uint48' },
            ],
          },
          { type: 'address' },
          { type: 'uint256' },
        ],
      },
      { type: 'bytes' },
    ],
    [
      [
        [
          authorization.token,
          authorization.amount,
          authorization.expiration,
          authorization.nonce,
        ],
        authorization.spender,
        authorization.sigDeadline,
      ],
      signature,
    ],
  )
  return {
    ...request,
    args: ['0x0a10', [permitInput, ...inputs], deadline],
  }
}

/** Fall back only for wallets that cannot sign Permit2 typed data, never rejection. */
export function permit2SignatureNeedsOnchainFallback(error: unknown): boolean {
  const messages: string[] = []
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== 'object') break
    const value = current as Record<string, unknown>
    for (const key of ['code', 'shortMessage', 'message', 'details']) {
      if (value[key] !== undefined) messages.push(String(value[key]))
    }
    current = value.cause
  }
  const text = messages.join(' ').toLowerCase()
  if (/user rejected|rejected the request|denied|4001/.test(text)) return false
  return /(^|\s)-32602(\s|$)|(^|\s)-32601(\s|$)|(^|\s)4200(\s|$)|invalid parameters|method .*not supported|unsupported method|typed data.*not supported/.test(
    text,
  )
}
