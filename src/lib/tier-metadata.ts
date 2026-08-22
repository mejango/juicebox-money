/**
 * App-specific gateway adapter around the SDK's canonical tier metadata
 * parsing and media normalization.
 */
import {
  TIER_UNLIMITED_SUPPLY,
  parseTierMetadataJson,
  pickTierMetadata,
  tierMediaAssetUrl as sdkTierMediaAssetUrl,
  tierMediaImageUrl as sdkTierMediaImageUrl,
} from '@bananapus/nana-sdk-core/v6'
import { JBCENTER_IPFS_GATEWAY } from '@/lib/jbcenter-ipfs'

export {
  TIER_UNLIMITED_SUPPLY,
  parseTierMetadataJson,
  pickTierMetadata,
}

export function tierMediaAssetUrl(value: unknown): string | undefined {
  return sdkTierMediaAssetUrl(value, JBCENTER_IPFS_GATEWAY)
}

export function tierMediaImageUrl(image: unknown): string | undefined {
  return sdkTierMediaImageUrl(image, JBCENTER_IPFS_GATEWAY)
}
