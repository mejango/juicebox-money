import { pathToFileURL } from 'node:url'

const BUILD_PHASES = new Set(['build', 'all'])
const RUNTIME_PHASES = new Set(['runtime', 'all'])
const PARA_ENVIRONMENTS = new Set(['DEV', 'SANDBOX', 'BETA', 'PROD'])

function required(errors, env, name, minLength = 1) {
  if ((env[name] ?? '').trim().length < minLength) {
    errors.push(`${name} is required`)
  }
}

function httpsUrl(errors, env, name, optional = false) {
  const value = env[name]?.trim()
  if (!value && optional) return
  try {
    if (!value || new URL(value).protocol !== 'https:') throw new Error()
  } catch {
    errors.push(`${name} must be an absolute HTTPS URL`)
  }
}

export function deploymentEnvErrors(env, phase = 'all') {
  if (!BUILD_PHASES.has(phase) && !RUNTIME_PHASES.has(phase)) {
    return [`unknown validation phase: ${phase}`]
  }

  const errors = []
  if (BUILD_PHASES.has(phase)) {
    httpsUrl(errors, env, 'NEXT_PUBLIC_SITE_URL')
    httpsUrl(errors, env, 'NEXT_PUBLIC_BENDYSTRAW_URL')
    httpsUrl(errors, env, 'NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL')
    required(errors, env, 'NEXT_PUBLIC_PARA_API_KEY', 8)
    const dwellirKey = env.NEXT_PUBLIC_DWELLIR_API_KEY?.trim() ?? ''
    if (!/^[A-Za-z\d_-]{8,128}$/u.test(dwellirKey)) {
      errors.push(
        'NEXT_PUBLIC_DWELLIR_API_KEY must be an 8-128 character URL-safe API key',
      )
    }
    required(errors, env, 'NEXT_PUBLIC_VERSION', 7)
    if (env.NEXT_PUBLIC_VERSION === 'unknown') {
      errors.push('NEXT_PUBLIC_VERSION must identify the built revision')
    }

    if (!PARA_ENVIRONMENTS.has(env.NEXT_PUBLIC_PARA_ENV ?? '')) {
      errors.push('NEXT_PUBLIC_PARA_ENV is invalid')
    }
    if (env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true') {
      errors.push('deterministic browser mode cannot be deployed')
    }
    if (env.NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN) {
      errors.push('browser fixture origin cannot be deployed')
    }
  }

  if (RUNTIME_PHASES.has(phase)) {
    if (!['true', 'false'].includes(env.IPFS_PINNING_ENABLED ?? '')) {
      errors.push('IPFS_PINNING_ENABLED must be explicitly true or false')
    }
    if (env.IPFS_PINNING_ENABLED === 'true') {
      // Two supported deployments, and the difference has to be declared: an edge
      // enforces the quota policy and injects the shared token, or the app is
      // reached directly and budgets callers itself. A token in the second mode is
      // a belief about protection the app does not have.
      if (!['true', 'false'].includes(env.IPFS_PINNING_EDGE_PROTECTED ?? '')) {
        errors.push(
          'IPFS_PINNING_EDGE_PROTECTED must be explicitly true or false',
        )
      }
      if (
        env.IPFS_PINNING_EDGE_PROTECTED === 'true' &&
        (env.IPFS_PINNING_INGRESS_TOKEN ?? '').trim().length < 32
      ) {
        errors.push('IPFS_PINNING_INGRESS_TOKEN must be at least 32 characters')
      }
      if (
        env.IPFS_PINNING_EDGE_PROTECTED === 'false' &&
        env.IPFS_PINNING_INGRESS_TOKEN
      ) {
        errors.push(
          'IPFS_PINNING_INGRESS_TOKEN is set while IPFS_PINNING_EDGE_PROTECTED is false: the app would ignore the token and budget callers itself',
        )
      }
      required(errors, env, 'FILEBASE_IPFS_RPC_TOKEN', 8)
      required(errors, env, 'PINATA_JWT', 8)
    }
  }

  return errors
}

export function assertDeploymentEnv(env, phase = 'all') {
  const errors = deploymentEnvErrors(env, phase)
  if (errors.length) {
    throw new Error(
      `Invalid ${phase} deployment configuration:\n${errors
        .map(error => `- ${error}`)
        .join('\n')}`,
    )
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const phase = process.argv[2] ?? 'all'
  try {
    assertDeploymentEnv(process.env, phase)
    process.stdout.write(`Deployment ${phase} configuration is valid.\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  }
}
