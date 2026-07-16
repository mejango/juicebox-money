import { createPublicClient, http, isAddress, type Address } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'

/**
 * ENS resolution with a synchronous cache. Inputs are validated/encoded
 * synchronously (splitOk, toRecipient), so lookups fill a module cache the
 * sync `resolvedAddress` reads — an ENS name is "valid" only once resolved.
 * ENS lives on mainnet regardless of which chains a project launches to.
 */

const ensClient = createPublicClient({
  chain: mainnet,
  // CORS-friendly public RPC (several big providers block browser origins).
  transport: http('https://ethereum-rpc.publicnode.com'),
})

const addressCache = new Map<string, Address | null>()
const nameCache = new Map<string, string | null>()

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
