// Juicebox V6: read Base Sepolia project 1 without a wallet or private key.
// npm install --save-exact @bananapus/nana-sdk-core@2.3.2 viem@2.55.19
import { createPublicClient, http, zeroAddress } from 'viem'
import { baseSepolia } from 'viem/chains'
import {
  getJBContractAddress, JBCoreContracts, jbDirectoryAbi, jbControllerAbi,
} from '@bananapus/nana-sdk-core'

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
if (await client.getChainId() !== baseSepolia.id) {
  throw new Error('The RPC must serve Base Sepolia (84532).')
}

// Resolve the project's controller and read its terms at the same block.
const block = await client.getBlock()
const controller = await client.readContract({
  address: getJBContractAddress(JBCoreContracts.JBDirectory, 6, baseSepolia.id),
  abi: jbDirectoryAbi,
  functionName: 'controllerOf',
  args: [projectId],
  blockNumber: block.number,
})
if (controller === zeroAddress) throw new Error('No controller: check the project ID and network.')
const [ruleset, metadata] = await client.readContract({
  address: controller,
  abi: jbControllerAbi,
  functionName: 'currentRulesetOf',
  args: [projectId],
  blockNumber: block.number,
})
if (ruleset.id === 0) throw new Error('This project has no active ruleset.')
const canonical = await client.getBlock({ blockNumber: block.number })
if (canonical.hash !== block.hash) throw new Error('The observation was reorganized. Run the read again.')

console.log(JSON.stringify({
  protocolVersion: 6,
  chainId: baseSepolia.id,
  projectId,
  blockNumber: block.number,
  blockHash: block.hash,
  blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
  controller,
  ruleset,
  metadata,
  projectUrl: `https://juicebox.money/basesep:${projectId}`,
  inspectUrl: `https://juicebox.center/inspect/basesep/${projectId}`,
}, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2))
