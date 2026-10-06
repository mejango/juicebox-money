import {
  buildSafeInitializer,
  predictSafeAddress,
  SAFE_FACTORY,
  SAFE_FALLBACK,
  SAFE_PROXY_CREATION_CODE,
  SAFE_SINGLETON,
} from '@bananapus/nana-sdk-core/safe'
import { toHex, type Address, type Hex } from 'viem'
import safe141 from '../fixtures/safe-1.4.1.json'
import { safeChain, type SafeChainOptions } from './safe-chain'

// A real Safe 1.4.1, made with createProxyWithNonce from the canonical
// factory: its creation record proves its address, so the SDK can trust it
// on another chain.

export const OWNERS = [
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
] as Address[]
const SALT = 7n

export const PROVEN_SAFE = predictSafeAddress({
  owners: OWNERS,
  threshold: 2,
  saltNonce: toHex(SALT, { size: 32 }),
  proxyCreationCode: SAFE_PROXY_CREATION_CODE,
})

/** The record Safe's transaction service returns for PROVEN_SAFE. */
export function creationRecord(saltNonce = SALT) {
  return {
    factoryAddress: SAFE_FACTORY,
    masterCopy: SAFE_SINGLETON,
    setupData: buildSafeInitializer({ owners: OWNERS, threshold: 2 }),
    saltNonce: saltNonce.toString(),
  }
}

/** One chain's view of PROVEN_SAFE, with its real proxy, singleton and fallback code. */
export function provenSafeChain(options: Partial<SafeChainOptions> = {}) {
  return safeChain({
    authority: PROVEN_SAFE,
    owners: OWNERS,
    threshold: 2n,
    singleton: SAFE_SINGLETON,
    version: '1.4.1',
    proxyCode: safe141.contracts.proxy.runtime as Hex,
    singletonCode: safe141.contracts.singleton.runtime as Hex,
    fallbackHandler: SAFE_FALLBACK,
    fallbackHandlerCode: safe141.contracts.fallback.runtime as Hex,
    ...options,
  })
}

/** The creation URL of PROVEN_SAFE on a chain's Safe service. */
export function creationUrl(prefix: string): string {
  return `https://api.safe.global/tx-service/${prefix}/api/v1/safes/${PROVEN_SAFE}/creation/`
}
