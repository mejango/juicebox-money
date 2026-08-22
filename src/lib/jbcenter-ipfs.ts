import {
  JBCENTER_DEFAULT_URL,
  JBCenterRequestError,
  JBCenterTimeoutError,
  createJBCenterClient,
  type JBCenterClientOptions,
  type JBCenterJsonObject,
  type JBCenterPin,
} from '@bananapus/nana-sdk-core/jbcenter'

export const JBCENTER_IPFS_GATEWAY = `${JBCENTER_DEFAULT_URL}/ipfs/`
export const JBCENTER_MAX_IMAGE_BYTES = 25 * 1024 * 1024
export const JBCENTER_MAX_MEDIA_BYTES = 500 * 1024 * 1024

type BrowserClientOptions = Pick<JBCenterClientOptions, 'baseUrl' | 'fetch'>

export type JBCenterIpfsClient = {
  pinJson(value: Record<string, unknown>): Promise<JBCenterPin>
  pinImage(file: File): Promise<JBCenterPin>
  pinMedia(file: File): Promise<JBCenterPin>
}

/**
 * Browser-only Juicebox Center IPFS adapter.
 *
 * Approved web clients call Center directly and let the browser send its
 * `Origin`. Never add a Center API key here: a NEXT_PUBLIC key is public, and
 * server keys are for non-browser integrations only.
 */
export function createJBCenterIpfsClient(
  options: BrowserClientOptions = {},
): JBCenterIpfsClient {
  const center = createJBCenterClient(options)

  const friendly = async <T>(label: string, request: Promise<T>): Promise<T> => {
    try {
      return await request
    } catch (error) {
      if (
        error instanceof JBCenterRequestError ||
        error instanceof JBCenterTimeoutError
      ) {
        throw new Error(`${label}: ${error.message}`, { cause: error })
      }
      throw new Error(`${label} — try again.`, { cause: error })
    }
  }

  return {
    pinJson(value) {
      // Values assembled from optional form fields contain `undefined`, which
      // JSON intentionally omits. Normalize once so the SDK receives exactly
      // the JSON object the user reviewed and custom fields round-trip safely.
      let json: unknown
      try {
        json = JSON.parse(JSON.stringify(value))
      } catch (error) {
        throw new Error('This metadata cannot be represented as JSON.', {
          cause: error,
        })
      }
      if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        throw new Error('Metadata must be a JSON object.')
      }
      return friendly(
        'Saving metadata failed',
        center.pinJson(json as JBCenterJsonObject),
      )
    },
    pinImage(file) {
      return friendly(
        'Image upload failed',
        center.pinImage(file, { filename: file.name || 'image' }),
      )
    },
    pinMedia(file) {
      return friendly(
        'Media upload failed',
        center.pinMedia(file, { filename: file.name || 'media' }),
      )
    },
  }
}

export const jbCenterIpfs = createJBCenterIpfsClient()
