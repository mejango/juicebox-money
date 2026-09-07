'use client'

import { erc2771ForwarderAbi, JBCoreContracts, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { decodeFunctionData, isAddressEqual, type Address } from 'viem'
import { loadLaunchSession } from '@/lib/launch-session'
import type { RelayrEntry, RelayrPendingSession } from '@/lib/relayr'

type Pending = { scope: string; session: RelayrPendingSession | null }

/** Only forwarded authorizations consume this nonce; raw payer and Safe calls do not. */
function authorizes(entry: RelayrEntry, account: Address, chains: Set<number>): boolean {
  if (!chains.has(entry.chain)) return false
  const forwarder = jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][entry.chain as JBChainId]
  if (!forwarder || !isAddressEqual(entry.target, forwarder)) return false
  try {
    const decoded = decodeFunctionData({ abi: erc2771ForwarderAbi, data: entry.data })
    return decoded.functionName === 'execute' && isAddressEqual(decoded.args[0].from, account)
  } catch {
    // A saved call to this forwarder with unreadable calldata cannot prove its nonce is free.
    throw new Error('A saved forwarder authorization cannot be read. Recover its original action before signing another.')
  }
}

/**
 * Project-action locks alone do not protect ERC2771's account-wide nonce. Hold
 * these sorted signer/destination locks through signatures, publication and
 * payment. Existing durable journals remain the reservation ledger after reload.
 * Paid recovery may run without asserting availability so old conflicts can resolve.
 */
export async function withForwarderAuthorizationLock<T>({ account, chainIds, owner, pendingSessions, execute }: {
  account: Address
  chainIds: number[]
  owner: `relayr:${string}` | `launch:${string}`
  pendingSessions: () => Pending[]
  execute: (assertAvailable: (destinations?: number[]) => void) => Promise<T>
}): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('This browser cannot coordinate forwarder authorizations across tabs. Use a browser with Web Locks support.')
  }
  const chains = [...new Set(chainIds)].sort((a, b) => a - b)
  const assertAvailable = (destinations = chains) => {
    if (destinations.some(chain => !chains.includes(chain))) throw new Error('An authorization destination changed. Review the action again.')
    const wanted = new Set(destinations)
    const conflict = () => { throw new Error('Another published action uses this wallet’s forwarder nonce on a selected chain. Complete or recover that original action before signing or paying for another.') }
    for (const { scope, session } of pendingSessions()) {
      if (!session || owner === `relayr:${scope}`) continue
      const entries = [...(session.publishedEntries ?? []), ...(session.expectedEntries ?? []),
        ...(session.expectedTransactions?.map(item => item.entry) ?? [])]
      if (entries.some(entry => authorizes(entry, account, wanted))) conflict()
      // Legacy authority sessions without exact entries still reserve their account/chain.
      // Safe execution journals have a different nonce and are deliberately excluded.
      if (!entries.length && !scope.startsWith('safe-queue:') && !session.expectedSafeExecutions?.length &&
          (!session.account || session.account.toLowerCase() === account.toLowerCase()) && session.chainIds.some(chain => wanted.has(chain))) conflict()
    }
    const launch = loadLaunchSession({ strict: true })
    if (launch?.relayr && owner !== `launch:${launch.salt}` && launch.relayr.published && !launch.relayr.abandonable) {
      const outstanding = [...launch.relayr.signed, ...(launch.relayr.superseded ?? [])]
        .filter(signed => launch.statuses[signed.chainId]?.phase !== 'done')
      if (outstanding.some(signed => authorizes(signed.entry, account, wanted))) conflict()
    }
  }
  const lock = async (index: number): Promise<T> => index === chains.length ? execute(assertAvailable)
    : navigator.locks.request(`jb-forwarder-authorization:${account.toLowerCase()}:${chains[index]}`, { ifAvailable: true }, async held => {
      if (!held) throw new Error('Another action is authorizing or recovering this wallet on a selected chain. Wait for it to finish before continuing.')
      return lock(index + 1)
    })
  return lock(0)
}
