'use client'

import { JBCoreContracts, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { relayrForwardRequest, relayrSignedRequests, type RelayrEntry, type RelayrSignedRequest } from '@bananapus/nana-sdk-core/review/relayr'
import { isAddressEqual, type Address } from 'viem'
import { loadLaunchSession } from '@/lib/launch-session'
import type { RelayrPendingSession } from '@/lib/relayr'

type Pending = { scope: string; session: RelayrPendingSession | null }

/** Only forwarded authorizations consume this nonce; raw payer and Safe calls do not. */
function authorizes(entry: RelayrEntry, account: Address, chains: Set<number>): boolean {
  if (!chains.has(entry.chain)) return false
  const forwarder = jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][entry.chain as JBChainId]
  if (!forwarder || !isAddressEqual(entry.target, forwarder)) return false
  const request = relayrForwardRequest(entry)
  // A saved call to this forwarder that is not a readable execute cannot prove its nonce is free.
  if (!request) throw new Error('A saved forwarder authorization cannot be read. Recover its original action before signing another.')
  return isAddressEqual(request.from, account)
}

/** A saved session or launch whose signed requests would use a nonce this action needs. */
type Reservation = { key: string; requests: RelayrSignedRequest[] | null }

/**
 * Project-action locks alone do not protect ERC2771's account-wide nonce. Hold
 * these sorted signer/destination locks through signatures, publication and
 * payment. Existing durable journals remain the reservation ledger after reload.
 * A saved session or launch reserves its signer's nonces on its chains exactly
 * while one of its requests is live (ruling R117): `requestsDead` classifies
 * each one once before `execute`, and one published since counts as live.
 * Paid recovery may run without asserting availability so old conflicts can resolve.
 */
export async function withForwarderAuthorizationLock<T>({ account, chainIds, owner, pendingSessions, requestsDead, execute }: {
  account: Address
  chainIds: number[]
  owner: `relayr:${string}` | `launch:${string}`
  pendingSessions: () => Pending[]
  /** Whether every given request is dead by ruling R114's classification, anything unknown counting as live. */
  requestsDead: (requests: readonly RelayrSignedRequest[]) => Promise<boolean>
  execute: (assertAvailable: (destinations?: number[]) => void) => Promise<T>
}): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('This browser cannot coordinate forwarder authorizations across tabs. Use a browser with Web Locks support.')
  }
  const chains = [...new Set(chainIds)].sort((a, b) => a - b)
  /** What would reserve `wanted`, each keyed by the exact requests it published. */
  const reservations = (wanted: Set<number>): Reservation[] => {
    const found: Reservation[] = []
    for (const { scope, session } of pendingSessions()) {
      if (!session || owner === `relayr:${scope}`) continue
      const entries = [...(session.publishedEntries ?? []), ...(session.expectedEntries ?? []),
        ...(session.expectedTransactions?.map(item => item.entry) ?? [])]
      const key = JSON.stringify(['relayr', scope, entries, session.publishedNonces ?? null])
      if (entries.some(entry => authorizes(entry, account, wanted))) found.push({ key, requests: relayrSignedRequests(session.publishedEntries, session.publishedNonces) })
      // Legacy authority sessions without exact entries still reserve their account/chain.
      // Safe execution journals have a different nonce and are deliberately excluded.
      else if (!entries.length && !scope.startsWith('safe-queue:') && !session.expectedSafeExecutions?.length &&
          (!session.account || session.account.toLowerCase() === account.toLowerCase()) && session.chainIds.some(chain => wanted.has(chain))) {
        found.push({ key, requests: null })
      }
    }
    const launch = loadLaunchSession({ strict: true })
    if (launch?.relayr && owner !== `launch:${launch.salt}` && launch.relayr.published && !launch.relayr.abandonable) {
      const outstanding = [...launch.relayr.signed, ...(launch.relayr.superseded ?? [])]
        .filter(signed => launch.statuses[signed.chainId]?.phase !== 'done')
      if (outstanding.some(signed => authorizes(signed.entry, account, wanted))) {
        found.push({ key: JSON.stringify(['launch', launch.salt, outstanding]),
          requests: outstanding.map(({ chainId, deadline, nonce }) => ({ chainId, signer: account, deadline, nonce })) })
      }
    }
    return found
  }
  /** Reservations whose every request was dead before this run: none of them reserves anything (ruling R117). */
  const dead = new Set<string>()
  const assertAvailable = (destinations = chains) => {
    if (destinations.some(chain => !chains.includes(chain))) throw new Error('An authorization destination changed. Review the action again.')
    if (reservations(new Set(destinations)).some(({ key }) => !dead.has(key))) {
      throw new Error('Another published action uses this wallet’s forwarder nonce on a selected chain. Complete or recover that original action before signing or paying for another.')
    }
  }
  const lock = async (index: number): Promise<T> => {
    if (index === chains.length) {
      // A ledger that cannot be read is refused by assertAvailable when a new authorization needs it, not here,
      // so paid recovery still runs.
      let found: Reservation[] = []
      try { found = reservations(new Set(chains)) } catch { /* assertAvailable refuses it. */ }
      for (const { key, requests } of found) if (requests && await requestsDead(requests)) dead.add(key)
      return execute(assertAvailable)
    }
    return navigator.locks.request(`jb-forwarder-authorization:${account.toLowerCase()}:${chains[index]}`, { ifAvailable: true }, async held => {
      if (!held) throw new Error('Another action is authorizing or recovering this wallet on a selected chain. Wait for it to finish before continuing.')
      return lock(index + 1)
    })
  }
  return lock(0)
}
