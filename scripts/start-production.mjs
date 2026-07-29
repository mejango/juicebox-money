import { assertDeploymentEnv } from './check-deployment-env.mjs'

process.env.NEXT_PUBLIC_VERSION ||=
  process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || undefined
assertDeploymentEnv(process.env, 'all')
await import('../server.js')
