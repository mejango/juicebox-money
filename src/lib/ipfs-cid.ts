/**
 * CIDv0 → bytes32 for JB721 tiers. The hook stores only the 32-byte sha2-256
 * digest onchain and reconstructs the `Qm…` CIDv0 when serving tokenURIs, so
 * tier metadata MUST be pinned as CIDv0 (Infura's /api/v0/add default) and
 * encoded here as the raw digest.
 */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0]
  for (const ch of s) {
    const value = B58.indexOf(ch)
    if (value < 0) throw new Error(`Invalid base58 character: ${ch}`)
    let carry = value
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const ch of s) {
    if (ch !== '1') break
    bytes.push(0)
  }
  return Uint8Array.from(bytes.reverse())
}

/** Extract the bytes32 sha2-256 digest from a CIDv0 (`Qm…`). */
export function cidV0ToBytes32(cid: string): `0x${string}` {
  if (!cid.startsWith('Qm') || cid.length !== 46) {
    throw new Error(`Expected a CIDv0 (Qm…), got: ${cid}`)
  }
  const decoded = base58Decode(cid)
  // CIDv0 = multihash: 0x12 (sha2-256) 0x20 (32 bytes) + digest.
  if (decoded.length !== 34 || decoded[0] !== 0x12 || decoded[1] !== 0x20) {
    throw new Error('Not a sha2-256 CIDv0')
  }
  let hex = '0x'
  for (let i = 2; i < 34; i++) hex += decoded[i].toString(16).padStart(2, '0')
  return hex as `0x${string}`
}
