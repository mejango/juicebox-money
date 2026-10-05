import {
  isEip7702DelegatedEoaRuntime,
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
  return fetchSafeCreation(authority, chainId, service)
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
