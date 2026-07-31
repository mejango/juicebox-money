import { CID } from 'multiformats'

// Reject unbounded or obviously non-CID input before invoking a decoder. The
// parser then validates multibase, version, codec, multihash code, digest
// length, and complete input consumption.
const CID_ENVELOPE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,160})$/

function parseIpfsCid(value: string): CID | null {
  if (!CID_ENVELOPE.test(value)) return null

  try {
    const cid = CID.parse(value)
    // Keep stored and proxied identifiers canonical. In particular this
    // rejects alternate multibase spellings which would fragment caches.
    return cid.toString() === value ? cid : null
  } catch {
    return null
  }
}

export function isIpfsCid(value: string): boolean {
  return parseIpfsCid(value) !== null
}

export function isIpfsCidV0(value: string): boolean {
  return parseIpfsCid(value)?.version === 0
}

export function isIpfsUri(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('ipfs://') &&
    isIpfsCid(value.slice('ipfs://'.length))
  )
}
