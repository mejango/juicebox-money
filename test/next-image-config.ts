import { createRequire } from 'node:module'
import { PHASE_PRODUCTION_BUILD } from 'next/constants'
import { imageConfigDefault } from 'next/dist/shared/lib/image-config'

// Next injects this configuration at compilation. Vitest calls its real image
// functions directly, so provide the same config to their documented fallback.
const nextConfig = createRequire(import.meta.url)('../next.config.js')
Object.assign(imageConfigDefault, nextConfig(PHASE_PRODUCTION_BUILD).images)
