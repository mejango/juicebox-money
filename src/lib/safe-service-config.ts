import { configureSafeServiceProxy } from '@bananapus/nana-sdk-core/safe-service'
import { jbCenterAppOrigin, jbCenterBaseUrl } from '@/lib/jbcenter-config'

// Configure before queue/creation reads the API key stays in Center.
configureSafeServiceProxy(`${jbCenterBaseUrl()}/v1/safe`, {
  ...(typeof window === 'undefined' ? { origin: jbCenterAppOrigin() } : {}),
})

export * from '@bananapus/nana-sdk-core/safe-service'
