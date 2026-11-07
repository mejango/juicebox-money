'use client'

import { createPublicClient, type Chain, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'

const clients = new Map<number, PublicClient>()

function payClient(chain: Chain): PublicClient {
  let client = clients.get(chain.id)
  if (!client) {
    client = createPublicClient({
      chain,
      batch: { multicall: true },
      transport: jbCenterRpcTransport(chain.id, undefined, 'first'),
    }) as PublicClient
    clients.set(chain.id, client)
  }
  return client
}

/** The client for the reads a payer waits on: the same RPC, ahead of the page's other reads. */
export function usePayPublicClient(chainId: JBChainId): PublicClient | undefined {
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  return client?.chain ? payClient(client.chain) : client
}
