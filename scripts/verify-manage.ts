/**
 * Live-Sepolia verification of the owner-manage plumbing in src/lib/manage.ts.
 *
 * Run: npx -y tsx scripts/verify-manage.ts
 *
 * 1. Assemble `buildSetUriTx` + `buildDeployTokenRequest` for a dummy project
 *    and `encodeFunctionData` both (pure, no network).
 * 2. Simulate `setUriOf` on live Sepolia as the project's ACTUAL owner
 *    (read `JBProjects.ownerOf` first) — expect success.
 * 3. Find a Base Sepolia project with no ERC-20 yet (every ETH-Sepolia v6
 *    project already deployed one) and simulate `deployERC20For` as its
 *    owner — expect success and a predicted token address.
 */
import {
  JBCoreContracts,
  jbContractAddress,
  jbDirectoryAbi,
  jbProjectsAbi,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseEther,
  zeroAddress,
} from 'viem'
import { baseSepolia, sepolia } from 'viem/chains'
import {
  buildDeployTokenRequest,
  buildSetUriTx,
  isKnownController,
  randomSalt,
} from '../src/lib/manage'

const CHAIN_ID = sepolia.id as JBChainId

async function main() {
  // ---- 1. Pure assembly + calldata encoding -------------------------------
  const setUri = buildSetUriTx({
    chainId: CHAIN_ID,
    projectId: 1n,
    projectUri: 'ipfs://QmDummyCidForVerification',
  })
  console.log('[1] buildSetUriTx →', {
    to: setUri.address,
    functionName: setUri.functionName,
    args: setUri.args.map(String),
  })
  console.log(
    '    calldata:',
    encodeFunctionData({
      abi: setUri.abi,
      functionName: setUri.functionName,
      args: setUri.args,
    }).slice(0, 74) + '…',
  )

  const salt = randomSalt()
  const deploy = buildDeployTokenRequest({
    chainId: CHAIN_ID,
    projectId: 1n,
    name: 'Verification Token',
    symbol: 'VRFY',
    salt,
  })
  console.log('[1] buildDeployTokenRequest →', {
    to: deploy.address,
    functionName: deploy.functionName,
    args: deploy.args.map(String),
  })
  console.log(
    '    calldata:',
    encodeFunctionData({
      abi: deploy.abi,
      functionName: deploy.functionName,
      args: deploy.args,
    }).slice(0, 74) + '…',
  )

  for (const bad of ['', 'lower', 'WAYTOOLONG', 'A B']) {
    try {
      buildDeployTokenRequest({
        chainId: CHAIN_ID,
        projectId: 1n,
        name: 'x',
        symbol: bad,
      })
      throw new Error(`symbol "${bad}" should have been rejected`)
    } catch (e) {
      if (!(e instanceof Error) || !/uppercase/.test(e.message)) throw e
    }
  }
  console.log('[1] invalid symbols ("", "lower", "WAYTOOLONG", "A B") rejected ✓')

  // ---- 2. Live Sepolia: setUriOf as the real owner -------------------------
  const client = createPublicClient({
    chain: sepolia,
    transport: http('https://ethereum-sepolia-rpc.publicnode.com'),
  })
  const projects = jbContractAddress['6'][JBCoreContracts.JBProjects][CHAIN_ID]
  const tokens = jbContractAddress['6'][JBCoreContracts.JBTokens][CHAIN_ID]
  const directory = jbContractAddress['6'][JBCoreContracts.JBDirectory][CHAIN_ID]

  const controllerOf = (id: bigint) =>
    client.readContract({
      address: directory,
      abi: jbDirectoryAbi,
      functionName: 'controllerOf',
      args: [id],
    })

  const owner5 = await client.readContract({
    address: projects,
    abi: jbProjectsAbi,
    functionName: 'ownerOf',
    args: [5n],
  })
  const controller5 = await controllerOf(5n)
  if (!isKnownController(CHAIN_ID, controller5)) {
    throw new Error(`Project 5's controller ${controller5} is not the canonical v6 controller`)
  }
  console.log('[2] Sepolia project 5 owner:', owner5, 'controller:', controller5)

  const setUriSim = await client.simulateContract({
    account: owner5,
    address: setUri.address,
    abi: setUri.abi,
    functionName: setUri.functionName,
    args: [5n, 'ipfs://QmDummyCidForVerification'],
    stateOverride: [{ address: owner5, balance: parseEther('1') }],
  })
  console.log('[2] setUriOf simulation succeeded as owner ✓', {
    request: {
      to: setUriSim.request.address,
      functionName: setUriSim.request.functionName,
    },
  })

  // ---- 3. Live Base Sepolia: deployERC20For on a token-less project --------
  // Scan newest-first — fresh projects are the ones without an ERC-20 yet.
  const BASE_CHAIN_ID = baseSepolia.id as JBChainId
  const baseClient = createPublicClient({
    chain: baseSepolia,
    transport: http('https://base-sepolia-rpc.publicnode.com'),
  })
  const baseProjects =
    jbContractAddress['6'][JBCoreContracts.JBProjects][BASE_CHAIN_ID]
  const baseTokens = jbContractAddress['6'][JBCoreContracts.JBTokens][BASE_CHAIN_ID]
  const baseDirectory =
    jbContractAddress['6'][JBCoreContracts.JBDirectory][BASE_CHAIN_ID]
  const count = await baseClient.readContract({
    address: baseProjects,
    abi: jbProjectsAbi,
    functionName: 'count',
  })
  let target: { projectId: bigint; owner: `0x${string}` } | null = null
  for (let id = count; id >= 1n; id--) {
    try {
      const token = await baseClient.readContract({
        address: baseTokens,
        abi: jbTokensAbi,
        functionName: 'tokenOf',
        args: [id],
      })
      if (token !== zeroAddress) continue
      // Same gate as the OwnerPanel: only projects on the canonical
      // controller get the manage actions.
      const ctrl = await baseClient.readContract({
        address: baseDirectory,
        abi: jbDirectoryAbi,
        functionName: 'controllerOf',
        args: [id],
      })
      if (!isKnownController(BASE_CHAIN_ID, ctrl)) continue
      const owner = await baseClient.readContract({
        address: baseProjects,
        abi: jbProjectsAbi,
        functionName: 'ownerOf',
        args: [id],
      })
      target = { projectId: id, owner }
      break
    } catch {
      continue // Nonexistent project id — keep scanning.
    }
  }
  if (!target) {
    throw new Error('No token-less Base Sepolia project on the canonical controller')
  }
  console.log(
    `[3] Base Sepolia project ${target.projectId} has no ERC-20; owner:`,
    target.owner,
  )

  const deployReq = buildDeployTokenRequest({
    chainId: BASE_CHAIN_ID,
    projectId: target.projectId,
    name: 'Verification Token',
    symbol: 'VRFY',
    salt,
  })
  const deploySim = await baseClient.simulateContract({
    account: target.owner,
    address: deployReq.address,
    abi: deployReq.abi,
    functionName: deployReq.functionName,
    args: deployReq.args,
    stateOverride: [{ address: target.owner, balance: parseEther('1') }],
  })
  console.log('[3] deployERC20For simulation succeeded as owner ✓', {
    predictedToken: deploySim.result,
  })

  console.log('\nAll manage-surface checks passed.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
