'use client'

import { markParaSession } from './ParaAuthContext'

export class ParaSessionLogoutError extends Error {
  constructor() {
    super('The embedded wallet could not sign out. Your session is still connected; try again.')
    this.name = 'ParaSessionLogoutError'
  }
}

export class ParaLocalDisconnectError extends Error {
  constructor() {
    super('You signed out, but the local wallet state did not reset. Try again or reload.')
    this.name = 'ParaLocalDisconnectError'
  }
}

/** Keep the authoritative session visible until Para confirms it has ended. */
export async function logoutParaSession(disconnect: () => Promise<unknown>) {
  const { getParaClient } = await import('./para-config')
  const client = getParaClient()
  let live: boolean
  try { live = await client.isFullyLoggedIn() }
  catch { throw new ParaSessionLogoutError() }
  if (live) {
    try {
      await client.logout()
    } catch {
      throw new ParaSessionLogoutError()
    }
    markParaSession(false)
  }
  try {
    await disconnect()
  } catch (error) {
    if (live) throw new ParaLocalDisconnectError()
    throw error
  }
}
