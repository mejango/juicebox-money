import { assertDeploymentEnv } from './check-deployment-env.mjs'

assertDeploymentEnv(process.env, 'all')
await import('../server.js')
