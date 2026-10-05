import {
  authorityIdentitiesMatch,
  readAuthorityIdentity as readSdkAuthorityIdentity,
  type AuthorityIdentity,
  type AuthorityReadOptions,
  type SafeCreation,
} from '@bananapus/nana-sdk-core/safe'
import type { Address } from 'viem'

type AuthorityClient = Parameters<typeof readSdkAuthorityIdentity>[0]

// The Safe releases this app treats as a Safe: Safe and SafeL2 1.3.0 and 1.4.1
// from Safe's canonical deployments. The SDK also recognizes Safe 1.3.0's
// EIP-155 deployment, which this app has never accepted, so an authority on it
// stays an unsupported contract here.
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
 * Both chains' identities and whether one authority controls `authority` on
 * both, or null when either chain cannot be read.
 */
export async function readMatchingAuthorityIdentities({
  sourceClient,
  destinationClient,
  authority,
}: {
  sourceClient: AuthorityClient
  destinationClient: AuthorityClient
  authority: Address
}): Promise<{
  source: AuthorityIdentity
  destination: AuthorityIdentity
  matches: boolean
} | null> {
  const [source, destination] = await Promise.all([
    readAuthorityIdentity(sourceClient, authority),
    readAuthorityIdentity(destinationClient, authority),
  ])
  if (!source || !destination) return null
  return {
    source,
    destination,
    matches: authorityIdentitiesMatch(source, destination),
  }
}
