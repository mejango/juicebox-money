import { decodeFunctionData, parseAbi, type Hex } from 'viem'

// Interface of the SDK-authenticated immutable prepaid payment contract.
const RELAYR_PAYMENT_ABI = parseAbi([
  'function prepayment(bytes16 payment_uuid, uint40 deadline) payable',
])

/** Decode the exact reviewed bytes; authentication remains with relayrPaymentDetails. */
export function relayrPaymentReview(data: Hex) {
  const { functionName, args } = decodeFunctionData({ abi: RELAYR_PAYMENT_ABI, data })
  return { abi: RELAYR_PAYMENT_ABI, functionName, args, contractName: 'Network-fee payment' }
}
