import {
  isEip7702DelegatedEoaRuntime,
  proveSafeCreation,
  readCrossChainHandleAuthority as readSdkHandleAuthority,
  readMatchingAuthorityIdentities as readSdkMatchingIdentities,
  type AuthorityIdentity,
  type CrossChainHandleAuthority,
  type SafeCreation,
} from '@bananapus/nana-sdk-core/safe'
import {
  fetchSafeCreation,
  type SafeServiceOptions,
} from '@bananapus/nana-sdk-core/safe-service'
import type { Address } from 'viem'
import { chainName } from '@/lib/urn'

type AuthorityClient = Parameters<typeof readSdkMatchingIdentities>[0]['sourceClient']

/** The line shown when a Safe's creation can't be proven (Ruling R90). */
export function unprovenSafeLine(chainId: number): string {
  return `Can't verify this Safe is the same on ${chainName(chainId)}.`
}

/** A refusal because a Safe's creation can't be proven on `chainId`; its message is the R90 line. */
export class UnprovenSafeError extends Error {
  constructor(chainId: number) {
    super(unprovenSafeLine(chainId))
    this.name = 'UnprovenSafeError'
  }
}

/** A record that proves a Safe's address never changes; a missing one is asked for again soon. */
const PROVEN_CREATION_TTL_MS = 24 * 60 * 60_000
const UNPROVEN_CREATION_TTL_MS = 60_000
const MAX_CACHED_CREATIONS = 500

/** Each Safe's creation record per chain, kept for the life of the page or the server process. */
const creations = new Map<string, { read: Promise<SafeCreation | null>; expires: number }>()

/**
 * The record of how the Safe at `safe` was made, from `chainId`'s Safe service
 * only, or null. Reads of one Safe share a request; a record that proves the
 * Safe's address is kept for a day, anything else (no record, a failed
 * request) for a minute.
 */
export function readSafeCreation(
  chainId: number,
  safe: Address,
  service?: SafeServiceOptions,
): Promise<SafeCreation | null> {
  const key = `${chainId}:${safe.toLowerCase()}`
  const cached = creations.get(key)
  if (cached && cached.expires > Date.now()) return cached.read
  const entry = {
    read: fetchSafeCreation(safe, chainId, service),
    expires: Date.now() + UNPROVEN_CREATION_TTL_MS,
  }
  creations.delete(key)
  creations.set(key, entry)
  // ponytail: oldest-first eviction at 500 Safes; an LRU if one page ever reads more
  if (creations.size > MAX_CACHED_CREATIONS) {
    creations.delete(creations.keys().next().value!)
  }
  void entry.read.then(creation => {
    if (creation && proveSafeCreation(creation, safe).valid) {
      entry.expires = Date.now() + PROVEN_CREATION_TTL_MS
    }
  })
  return entry.read
}

/**
 * The creation record that proves how a Safe at `authority` was made, from
 * `chainId`'s Safe service only, or null. An address without contract code is
 * never a Safe, so an EOA costs no service request.
 */
async function creationRecordOf(
  client: AuthorityClient,
  chainId: number,
  authority: Address,
  service?: SafeServiceOptions,
): Promise<SafeCreation | null> {
  let code: unknown
  try {
    code = await client.getCode({ address: authority })
  } catch {
    return null
  }
  if (
    typeof code !== 'string' ||
    code === '0x' ||
    isEip7702DelegatedEoaRuntime(code)
  ) {
    return null
  }
  return readSafeCreation(chainId, authority, service)
}

/**
 * Both chains' identities and whether one authority controls `authority` on
 * both, or null when either chain cannot be read. A Safe matches only with the
 * record of how it was made, read from `sourceChainId`'s Safe service; without
 * one, `creationUnproven` is true.
 */
export async function readMatchingAuthorityIdentities({
  sourceChainId,
  sourceClient,
  destinationClient,
  authority,
  service,
}: {
  sourceChainId: number
  sourceClient: AuthorityClient
  destinationClient: AuthorityClient
  authority: Address
  service?: SafeServiceOptions
}): Promise<{
  source: AuthorityIdentity
  destination: AuthorityIdentity
  matches: boolean
  creationUnproven: boolean
} | null> {
  const creation = await creationRecordOf(
    sourceClient,
    sourceChainId,
    authority,
    service,
  )
  return readSdkMatchingIdentities({
    sourceClient,
    destinationClient,
    authority,
    creation,
  })
}

/**
 * Whether `authority`, the project's live owner or operator on
 * `sourceChainId`, may publish its Ethereum handle. A Safe is trusted on
 * Ethereum only with the record of how it was made, read from
 * `sourceChainId`'s Safe service; without one it is `unproven-creation`.
 */
export async function readCrossChainHandleAuthority({
  sourceChainId,
  sourceClient,
  mainnetClient,
  authority,
  service,
}: {
  sourceChainId: number
  sourceClient: AuthorityClient
  mainnetClient: AuthorityClient
  authority: Address
  service?: SafeServiceOptions
}): Promise<CrossChainHandleAuthority> {
  const creation = await creationRecordOf(
    sourceClient,
    sourceChainId,
    authority,
    service,
  )
  return readSdkHandleAuthority({
    sourceChainId,
    sourceClient,
    mainnetClient,
    authority,
    creation,
  })
}
