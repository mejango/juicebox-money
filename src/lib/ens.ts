import { JB_CHAINS } from '@bananapus/nana-sdk-core'
import { createPublicClient, http, isAddress, type Address } from 'viem'
import { normalize } from 'viem/ens'
import {
  PROJECT_HANDLES_CHAIN_ID,
  normalizeProjectHandle,
  parseProjectHandleRecord,
  readDirectEnsProjectRecord,
  readBoundedProjectHandle,
  type NormalizedProjectHandle,
} from '@/lib/project-handles'

/**
 * ENS resolution with a synchronous cache. Inputs are validated/encoded
 * synchronously (splitOk, toRecipient), so lookups fill a module cache the
 * sync `resolvedAddress` reads — an ENS name is "valid" only once resolved.
 * ENS lives on mainnet regardless of which chains a project launches to.
 */

const ensClient = createPublicClient({
  chain: JB_CHAINS[PROJECT_HANDLES_CHAIN_ID].chain,
  // CORS-friendly public RPC (several big providers block browser origins).
  transport: http('https://ethereum-rpc.publicnode.com'),
})
const IS_DETERMINISTIC_BROWSER =
  process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'

const addressCache = new Map<string, Address | null>()
const nameCache = new Map<string, string | null>()

export type ProjectHandleTarget = NormalizedProjectHandle & {
  chainId: number
  projectId: number
}

export function looksLikeEns(value: string): boolean {
  const v = value.trim()
  return !isAddress(v) && /^[^\s.]+(\.[^\s.]+)+$/.test(v) && /\.[a-z]{2,}$/i.test(v)
}

/** Sync: the address an input stands for — a literal address, or a cached
 *  ENS resolution. null = not (yet) resolvable. */
export function resolvedAddress(input: string): Address | null {
  const v = input.trim()
  if (isAddress(v)) return v
  if (looksLikeEns(v)) return addressCache.get(v.toLowerCase()) ?? null
  return null
}

/** Async: resolve an ENS name, filling the sync cache. */
export async function lookupEnsAddress(name: string): Promise<Address | null> {
  if (IS_DETERMINISTIC_BROWSER) return null
  const key = name.trim().toLowerCase()
  const cached = addressCache.get(key)
  if (cached !== undefined) return cached
  let address: Address | null = null
  try {
    address = await ensClient.getEnsAddress({ name: normalize(key) })
  } catch {
    address = null
  }
  addressCache.set(key, address)
  return address
}

/** Async: an address's primary ENS name, cached. */
export async function lookupEnsName(address: string): Promise<string | null> {
  if (IS_DETERMINISTIC_BROWSER) return null
  const key = address.trim().toLowerCase()
  const cached = nameCache.get(key)
  if (cached !== undefined) return cached
  let name: string | null = null
  try {
    name = await ensClient.getEnsName({ address: address.trim() as Address })
  } catch {
    name = null
  }
  nameCache.set(key, name)
  return name
}

/**
 * Resolve the forward half of a project handle: `/@handle` → the ENS
 * `juicebox` text record on `handle.eth` → `(chainId, projectId)`.
 */
export async function lookupProjectHandleTarget(
  input: string,
): Promise<ProjectHandleTarget | null> {
  const normalized = normalizeProjectHandle(input)
  if (!normalized || IS_DETERMINISTIC_BROWSER) return null

  let target: ProjectHandleTarget | null = null
  try {
    const { textRecord } = await readDirectEnsProjectRecord(
      ensClient,
      normalized.ensName,
    )
    const parsed = parseProjectHandleRecord(textRecord)
    if (parsed) target = { ...normalized, ...parsed }
  } catch {
    target = null
  }
  return target
}

/**
 * Resolve the reverse half of a project handle from the canonical mainnet
 * registry. Callers choose the trusted effective authority (owner/operator).
 */
export async function lookupVerifiedProjectHandle({
  chainId,
  projectId,
  setter,
}: {
  chainId: number
  projectId: number
  setter: Address
}): Promise<string | null> {
  if (IS_DETERMINISTIC_BROWSER) return null
  try {
    return await readBoundedProjectHandle(ensClient, {
      chainId,
      projectId,
      setter,
    })
  } catch {
    return null
  }
}
