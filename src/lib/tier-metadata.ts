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

const APP_IPFS_GATEWAY = '/api/ipfs/'

export {
  TIER_UNLIMITED_SUPPLY,
  parseTierMetadataJson,
  pickTierMetadata,
}

export function tierMediaAssetUrl(value: unknown): string | undefined {
  return sdkTierMediaAssetUrl(value, APP_IPFS_GATEWAY)
}

export function tierMediaImageUrl(image: unknown): string | undefined {
  return sdkTierMediaImageUrl(image, APP_IPFS_GATEWAY)
}
