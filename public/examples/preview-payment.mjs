// Read and simulate a native test-ETH payment. This script never signs or sends.
// npm install --save-exact @bananapus/nana-sdk-core@2.3.2 viem@2.55.19
// JB_PAYER=0xYourPublicWalletAddress node preview-payment.mjs
import { createPublicClient, decodeFunctionData, encodeFunctionData, http, isAddress, parseEther, zeroAddress } from 'viem'
import { baseSepolia } from 'viem/chains'
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { buildPayTx, previewPay, resolvePaymentTerminal, slippageFloor } from '@bananapus/nana-sdk-core/v6'

const payer = process.env.JB_PAYER
if (!payer || !isAddress(payer) || payer.toLowerCase() === zeroAddress) {
  throw new Error('Set JB_PAYER to your public wallet address, never a private key.')
}
const projectIdText = process.env.JB_PROJECT_ID ?? '1'
if (!/^[1-9][0-9]*$/.test(projectIdText) || BigInt(projectIdText) >= 1n << 256n) {
  throw new Error('JB_PROJECT_ID must be a positive uint256 project ID on Base Sepolia.')
}
const projectId = BigInt(projectIdText)
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? 'https://juicebox.center/v1/rpc/84532', {
    timeout: 20_000, retryCount: 1,
  }),
})
if (await client.getChainId() !== baseSepolia.id) throw new Error('The RPC must serve Base Sepolia (84532).')
const amount = parseEther('0.000001')
const terminal = await resolvePaymentTerminal(client, { chainId: baseSepolia.id, projectId, token: NATIVE_TOKEN })
// Terminal preview includes the configured hooks. It is not a best-market-route quote.
const quote = await previewPay(client, {
  chainId: baseSepolia.id, terminal: terminal.address, projectId,
  token: NATIVE_TOKEN, amount, beneficiary: payer,
})
if (quote.beneficiaryTokenCount === 0n) throw new Error('The tutorial expects token output; this route currently quotes zero.')
const minReturnedTokens = slippageFloor(quote.beneficiaryTokenCount, 100n) // 1% below this quote.
if (minReturnedTokens === 0n) throw new Error('The minimum output rounded to zero; inspect the terms before continuing.')
const request = buildPayTx({
  chainId: baseSepolia.id, terminal: terminal.address, projectId,
  token: NATIVE_TOKEN, amount, beneficiary: payer, minReturnedTokens,
  memo: 'Learn, build, inspect: test payment',
})
const data = encodeFunctionData(request)
const decoded = decodeFunctionData({ abi: request.abi, data })
const simulation = await client.simulateContract({ ...request, account: payer })
console.log(JSON.stringify({
  state: 'simulated-only',
  chainId: baseSepolia.id,
  projectId,
  payer,
  terminal: terminal.address,
  nativeValue: request.value,
  quote,
  minReturnedTokens,
  simulatedReturnedTokens: simulation.result,
  data,
  decoded,
  next: `Review a fresh quote in https://juicebox.money/basesep:${projectId}. This script has not submitted a transaction.`,
}, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2))
