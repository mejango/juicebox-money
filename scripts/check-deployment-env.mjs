import { pathToFileURL } from 'node:url'

const BUILD_PHASES = new Set(['build', 'all'])
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
  if (!BUILD_PHASES.has(phase) && phase !== 'runtime') {
    return [`unknown validation phase: ${phase}`]
  }

  const errors = []
  if (BUILD_PHASES.has(phase)) {
    httpsUrl(errors, env, 'NEXT_PUBLIC_SITE_URL')
    httpsUrl(errors, env, 'NEXT_PUBLIC_BENDYSTRAW_URL')
    httpsUrl(errors, env, 'NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL')
    required(errors, env, 'NEXT_PUBLIC_PARA_API_KEY', 8)
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
