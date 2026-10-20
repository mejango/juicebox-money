import { JB_CHAINS } from '@bananapus/nana-sdk-core'
import { createPublicClient } from 'viem'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'
import { PROJECT_HANDLES_CHAIN_ID } from '@/lib/project-handles'

/**
 * The mainnet client ENS reads use. ENS lives on mainnet regardless of which
 * chains a project launches to. Lookups import this module, so a page loads a
 * public client (every viem action) only when it first resolves a name.
 */
export const ensClient = createPublicClient({
  chain: JB_CHAINS[PROJECT_HANDLES_CHAIN_ID].chain,
  transport: jbCenterRpcTransport(PROJECT_HANDLES_CHAIN_ID),
})
