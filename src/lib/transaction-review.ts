'use client'

import {
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
} from 'viem'

export type TransactionReviewCall = {
  chainId: number
  to: Address
  data: Hex
  value?: bigint
  from?: Address
  abi?: Abi
  functionName?: string
  args?: readonly unknown[]
  /** Plain-language action shown above the decoded call. */
  label?: string
  /** Optional known contract name. The full address is always shown too. */
  contractName?: string
}

export type TransactionReviewRequest = {
  calls: readonly TransactionReviewCall[]
  title?: string
  description?: string
  confirmLabel?: string
  /** Distinguishes a wallet transaction from an authorization which a relayer/Safe will submit. */
  kind?: 'transaction' | 'authorization'
  /** Exact typed data committed by a Safe/relayer signature, when applicable. */
  authorization?: unknown
}

export type ContractTransactionReviewCall = {
  chainId: number
  address: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
  value?: bigint
  account?: Address
}

export type TransactionReviewOptions = Omit<TransactionReviewRequest, 'calls'> & {
  label?: string
  contractName?: string
}

type TransactionReviewHandler = (
  request: TransactionReviewRequest,
) => Promise<boolean>

let transactionReviewHandler: TransactionReviewHandler | null = null

/**
 * The provider registers the only UI capable of approving a transaction.
 * Keeping the entry point in a small client module lets non-React wallet
 * helpers (Safe and Relayr) use the same mandatory review queue.
 */
export function registerTransactionReviewHandler(
  handler: TransactionReviewHandler,
): () => void {
  transactionReviewHandler = handler
  return () => {
    if (transactionReviewHandler === handler) transactionReviewHandler = null
  }
}

export async function requestTransactionReview(
  request: TransactionReviewRequest,
): Promise<boolean> {
  if (!request.calls.length) {
    throw new Error('There is no transaction to review.')
  }
  if (!transactionReviewHandler) {
    throw new Error(
      'Transaction review is unavailable. Reload the page before continuing.',
    )
  }
  return transactionReviewHandler(request)
}

/** Encode once for review using the same ABI/function/args passed to wagmi. */
export function contractCallForReview(
  call: ContractTransactionReviewCall,
  options: Pick<TransactionReviewOptions, 'label' | 'contractName'> = {},
): TransactionReviewCall {
  const data = encodeFunctionData({
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
  })
  return {
    chainId: call.chainId,
    to: call.address,
    data,
    value: call.value,
    from: call.account,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    label: options.label,
    contractName: options.contractName,
  }
}

export function requestContractTransactionReview(
  call: ContractTransactionReviewCall,
  options: TransactionReviewOptions = {},
): Promise<boolean> {
  const { label, contractName, ...requestOptions } = options
  const reviewed = contractCallForReview(call, { label, contractName })
  return requestTransactionReview({
    ...requestOptions,
    calls: [reviewed],
  }).then(approved => {
    if (!approved) return false
    const current = contractCallForReview(call, { label, contractName })
    if (
      current.chainId !== reviewed.chainId ||
      current.to.toLowerCase() !== reviewed.to.toLowerCase() ||
      (current.value ?? 0n) !== (reviewed.value ?? 0n) ||
      current.data !== reviewed.data
    ) {
      throw new Error(
        'Transaction data changed after review. Nothing was sent; review it again.',
      )
    }
    return true
  })
}

export class TransactionReviewCancelledError extends Error {
  constructor() {
    super('Review closed. Nothing was sent.')
    this.name = 'TransactionReviewCancelledError'
  }
}

export async function requireTransactionReview(
  request: TransactionReviewRequest,
): Promise<void> {
  if (!(await requestTransactionReview(request))) {
    throw new TransactionReviewCancelledError()
  }
}

export async function requireContractTransactionReview(
  call: ContractTransactionReviewCall,
  options: TransactionReviewOptions = {},
): Promise<void> {
  if (!(await requestContractTransactionReview(call, options))) {
    throw new TransactionReviewCancelledError()
  }
}

export function transactionReviewJson(
  request: TransactionReviewRequest,
): string {
  const transactions = request.calls.map(call => ({
    chainId: call.chainId,
    from: call.from,
    to: call.to,
    value: `0x${(call.value ?? 0n).toString(16)}`,
    data: call.data,
  }))
  const calls = transactions.length === 1 ? transactions[0] : { transactions }
  const payload = request.authorization
    ? { authorization: request.authorization, resultingCall: calls }
    : calls
  return JSON.stringify(
    payload,
    (_, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  )
}

const EXPLORER_BY_CHAIN: Record<number, string> = {
  1: 'https://etherscan.io',
  10: 'https://optimistic.etherscan.io',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  11155111: 'https://sepolia.etherscan.io',
  11155420: 'https://sepolia-optimism.etherscan.io',
  84532: 'https://sepolia.basescan.org',
  421614: 'https://sepolia.arbiscan.io',
}

/** A website/-style prompt which keeps the exact reviewed RPC call intact. */
export function buildTransactionReviewPrompt(
  request: TransactionReviewRequest,
): string {
  const lines: string[] = [
    "I'm about to authorize a blockchain transaction in the Juicebox V6 app (the nana V6 / revnet V6 protocol release, not an older Juicebox version). Act as a careful security reviewer. Independently verify the payload against the deployed contracts and V6 source, confirm it matches my intent, and give a go/no-go. Assume the UI could be spoofed; trust the onchain call and verified V6 source over the page.",
    '',
    'Exact app-controlled transaction payload:',
    '```json',
    transactionReviewJson(request),
    '```',
    '',
  ]

  if (typeof window !== 'undefined') {
    lines.push('Audit the app build I am using:')
    lines.push(`- Page: ${window.location.href}`)
    lines.push(
      '- Confirm this page builds exactly the destination, native value, and calldata above, with no hidden or substituted call.',
    )
    lines.push('')
  }

  lines.push('Verify the contracts and protocol version:')
  lines.push(
    '- Juicebox V6 ecosystem source: https://github.com/Bananapus/version-6',
  )
  lines.push(
    '- Use only V6 repositories (normally ending in `-v6`); same-named repositories without that suffix may be older and incompatible.',
  )
  request.calls.forEach((call, index) => {
    const explorer = EXPLORER_BY_CHAIN[call.chainId]
    const prefix = request.calls.length > 1 ? `Transaction ${index + 1}` : 'Target'
    lines.push(
      explorer
        ? `- ${prefix} onchain: ${explorer}/address/${call.to}`
        : `- ${prefix}: chain ${call.chainId}, address ${call.to}`,
    )
  })
  lines.push('')
  lines.push('Check specifically:')
  lines.push(
    '1. Decode the calldata selector and every argument. Explain in plain English what state, permissions, ownership, tokens, or funds can change.',
  )
  lines.push(
    '2. Verify the chain ID, `to` address, native `value`, and calldata exactly. Flag any unexpected non-zero value or unknown target.',
  )
  lines.push(
    '3. Identify every beneficiary, recipient, spender, operator, owner, hook, terminal, and permission-bearing address in the decoded arguments.',
  )
  lines.push(
    '4. Warn about unlimited approvals, arbitrary-call capability, delegatecalls, ownership transfers, permission grants, upgradeability, or drain paths.',
  )
  lines.push(
    '5. For multiple chains, confirm the intended change is consistent and that no extra chain or call was added.',
  )
  lines.push('')
  lines.push(
    'Before your verdict, quiz me with 2–4 short plain-English questions about what I expect to happen (what changes, who receives or controls what, how much value moves, and on which chain). Wait for my answers, compare them with the decoded payload, and flag every mismatch.',
  )
  lines.push('')
  lines.push(
    'End with one verdict: SAFE TO SIGN / DO NOT SIGN / NEEDS MORE INFO, followed by the most important reasons. If the target is not a recognizable verified Juicebox V6 deployment, say so explicitly.',
  )
  return lines.join('\n')
}
