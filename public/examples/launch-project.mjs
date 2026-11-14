// Build and simulate a project launch on Base Sepolia. This script never signs or sends.
// npm install --save-exact @bananapus/nana-sdk-core@6.8.0 viem@2.55.19
// JB_OWNER=0xYourPublicWalletAddress node launch-project.mjs
import { createPublicClient, decodeFunctionData, encodeFunctionData, http, isAddress, parseEther, zeroAddress } from 'viem'
import { baseSepolia } from 'viem/chains'
import {
  buildLaunchProjectTx, buildRulesetConfiguration, buildRulesetMetadata,
  buildTerminalConfigurations, getProjectCreationFee,
} from '@bananapus/nana-sdk-core/v6'

const owner = process.env.JB_OWNER
if (!owner || !isAddress(owner) || owner.toLowerCase() === zeroAddress) {
  throw new Error('Set JB_OWNER to the public wallet address that will own the project, never a private key.')
}
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? 'https://juicebox.center/v1/rpc/84532', {
    timeout: 20_000, retryCount: 1,
  }),
})
if (await client.getChainId() !== baseSepolia.id) throw new Error('The RPC must serve Base Sepolia (84532).')

// The launch must send exactly this fee as value. Read it right before each launch.
const creationFee = await getProjectCreationFee(client, baseSepolia.id)
const request = buildLaunchProjectTx({
  chainId: baseSepolia.id,
  owner, // receives the project NFT and controls the project
  projectUri: '', // ipfs:// URI of your pinned metadata JSON (name, description, logo)
  rulesetConfigurations: [buildRulesetConfiguration({
    duration: 0, // seconds per cycle; 0 = these rules hold until the owner replaces them
    weight: parseEther('10000'), // tokens per ETH paid, 18 decimals: 10,000 tokens
    weightCutPercent: 0, // issuance cut each cycle, out of 1,000,000,000
    metadata: buildRulesetMetadata({
      reservedPercent: 1000, // out of 10,000: 10% of new tokens are reserved
      cashOutTaxRate: 2000, // out of 10,000: 0 = full share of the balance, 10,000 = cash outs off
      baseCurrency: 1, // weight is per ETH (1) or per USD (2)
    }),
    // No fundAccessLimitGroups: the owner can pay out nothing, so funds leave only through cash outs.
  })],
  // The main terminal accepting native ETH, plus the router registry where it is deployed.
  terminalConfigurations: buildTerminalConfigurations({ chainId: baseSepolia.id }),
  memo: 'Launch example',
  creationFee, // wei
})
const data = encodeFunctionData(request)
const decoded = decodeFunctionData({ abi: request.abi, data })
// The balance override covers the fee for this simulation only; it changes nothing on the chain.
const simulation = await client.simulateContract({
  ...request,
  account: owner,
  stateOverride: [{ address: owner, balance: creationFee + parseEther('1') }],
})
console.log(JSON.stringify({
  state: 'simulated-only',
  chainId: baseSepolia.id,
  owner,
  controller: request.address,
  functionName: request.functionName,
  creationFee,
  nativeValue: request.value,
  simulatedProjectId: simulation.result,
  data,
  decoded,
  next: 'Review every term, then launch at https://juicebox.money/create or send this request from a wallet client in your app. This script has not submitted a transaction.',
}, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2))
