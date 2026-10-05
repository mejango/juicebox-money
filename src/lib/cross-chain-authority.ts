import {
  isEip7702DelegatedEoaRuntime,
  readAuthorityIdentity as readSdkAuthorityIdentity,
  readCrossChainHandleAuthority as readSdkHandleAuthority,
  readMatchingAuthorityIdentities as readSdkMatchingIdentities,
  type AuthorityIdentity,
  type AuthorityReadOptions,
  type CrossChainHandleAuthority,
  type SafeCreation,
} from '@bananapus/nana-sdk-core/safe'
import {
  fetchSafeCreation,
  type SafeServiceOptions,
} from '@bananapus/nana-sdk-core/safe-service'
import type { Address } from 'viem'
import { chainName } from '@/lib/urn'

type AuthorityClient = Parameters<typeof readSdkAuthorityIdentity>[0]

// The Safe releases this app treats as a Safe: Safe and SafeL2 1.3.0 and 1.4.1
// from Safe's canonical deployments. The SDK also recognizes Safe 1.3.0's
// EIP-155 deployment, which this app has never accepted, so an authority on it
// stays an unsupported contract here, and that factory's records prove nothing.
const CANONICAL_SAFE_SINGLETONS = new Set([
  '0xd9db270c1b5e3bd161e8c8503c55ceabee709552',
  '0x3e5c63644e683549055b9be8653de26e0b4cd36e',
  '0x41675c099f32341bf84bfc5382af534df5c7461a',
  '0x29fcb43b46531bca003ddc8fcb67ffe91900c762',
])
const CANONICAL_SAFE_FACTORIES = new Set([
  '0xa6b71e26c5e0845f74c812102ca7114b6a896ab2',
  '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67',
])

function canonicalOnly(identity: AuthorityIdentity): AuthorityIdentity {
  return identity.kind === 'safe' &&
    !CANONICAL_SAFE_SINGLETONS.has(identity.singleton.toLowerCase())
    ? { kind: 'contract' }
    : identity
}

/** Whether a Safe's creation record names a canonical factory and singleton. */
export function isCanonicalSafeCreation(creation: SafeCreation): boolean {
  return (
    CANONICAL_SAFE_FACTORIES.has(creation.factory.toLowerCase()) &&
    CANONICAL_SAFE_SINGLETONS.has(creation.singleton.toLowerCase())
  )
}

/** The line shown when a Safe's creation can't be proven (Ruling R90). */
export function unprovenSafeLine(chainId: number): string {
  return `Can't verify this Safe is the same on ${chainName(chainId)}.`
}

/**
 * Who controls `authority`, as the SDK reads it, with a Safe outside the
 * canonical releases read as a contract. Null when a read fails.
 */
export async function readAuthorityIdentity(
  client: AuthorityClient,
  authority: Address,
  options?: AuthorityReadOptions,
): Promise<AuthorityIdentity | null> {
  const identity = await readSdkAuthorityIdentity(client, authority, options)
  return identity && canonicalOnly(identity)
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
  const creation = await fetchSafeCreation(authority, chainId, service)
  return creation && isCanonicalSafeCreation(creation) ? creation : null
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
  const result = await readSdkMatchingIdentities({
    sourceClient,
    destinationClient,
    authority,
    creation,
  })
  if (!result) return null
  const source = canonicalOnly(result.source)
  const destination = canonicalOnly(result.destination)
  return source === result.source && destination === result.destination
    ? result
    : { source, destination, matches: false, creationUnproven: false }
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
  const result = await readSdkHandleAuthority({
    sourceChainId,
    sourceClient,
    mainnetClient,
    authority,
    creation,
  })
  const source = result.source && canonicalOnly(result.source)
  const mainnet = result.mainnet && canonicalOnly(result.mainnet)
  if (source !== result.source) {
    return { status: 'source-contract', allowed: false, source, mainnet }
  }
  if (mainnet !== result.mainnet) {
    return { status: 'mainnet-contract', allowed: false, source, mainnet }
  }
  return result
}
