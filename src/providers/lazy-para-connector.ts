'use client'

import {
  createConnector,
  type CreateConnectorFn,
} from 'wagmi'
import { hasParaSessionMarker } from './ParaAuthContext'

type ParaConnectorModule = typeof import('./para-config')
type ParaConnectorLoader = () => Promise<ParaConnectorModule>
type ParaConnectorFn = CreateConnectorFn<
  unknown,
  Record<never, never>,
  Record<never, never>
>
type ConnectorImplementation = ReturnType<ParaConnectorFn>

const loadParaConnector: ParaConnectorLoader = () => import('./para-config')

type LazyParaConnectorOptions = {
  load?: ParaConnectorLoader
  shouldRestore?: () => boolean
}

/**
 * A stable wagmi connector whose Para implementation is loaded on demand.
 *
 * Wagmi does not expose a public API for mutating a config's connector list.
 * Keeping this public connector factory in the initial topology lets wagmi
 * persist and reconnect Para like every other connector, while the delegate
 * preserves the anonymous path: Para's SDK, worker, and session machinery are
 * not imported until a marked session is restored or the auth modal settles.
 */
export function lazyParaConnector({
  load = loadParaConnector,
  shouldRestore = hasParaSessionMarker,
}: LazyParaConnectorOptions = {}): CreateConnectorFn {
  return createConnector(config => {
    let implementation: ConnectorImplementation | undefined
    let pending: Promise<ConnectorImplementation> | undefined

    const getImplementation = () => {
      if (implementation) return Promise.resolve(implementation)
      pending ??= load()
        .then(({ createParaWagmiConnector }) => {
          const connector = (createParaWagmiConnector(
            config.transports ?? {},
          ) as ParaConnectorFn)(config)
          return Promise.resolve(connector.setup?.()).then(() => {
            implementation = connector
            return connector
          })
        })
        .catch(error => {
          pending = undefined
          throw error
        })
      return pending
    }

    return {
      id: 'para',
      name: 'Para',
      type: 'para',
      async connect(parameters) {
        return (await getImplementation()).connect(parameters)
      },
      async disconnect() {
        return (await getImplementation()).disconnect()
      },
      async getAccounts() {
        return (await getImplementation()).getAccounts()
      },
      async getChainId() {
        return (await getImplementation()).getChainId()
      },
      async getProvider(parameters) {
        // Wagmi probes every configured connector during its hydrated reconnect.
        // An unmarked browser must take this fast path so the Para runtime stays
        // out of anonymous sessions. Explicit `connect` calls bypass this probe
        // and still initialize Para after the auth modal settles.
        if (!implementation && !shouldRestore()) return undefined
        return (await getImplementation()).getProvider(parameters)
      },
      async isAuthorized() {
        if (!implementation && !shouldRestore()) return false
        return (await getImplementation()).isAuthorized()
      },
      async switchChain(parameters) {
        const connector = await getImplementation()
        if (!connector.switchChain) {
          throw new Error('Para does not support chain switching')
        }
        return connector.switchChain(parameters)
      },
      onAccountsChanged(accounts) {
        implementation?.onAccountsChanged(accounts)
      },
      onChainChanged(chainId) {
        implementation?.onChainChanged(chainId)
      },
      onConnect(connectInfo) {
        implementation?.onConnect?.(connectInfo)
      },
      onDisconnect(error) {
        implementation?.onDisconnect(error)
      },
      onMessage(message) {
        implementation?.onMessage?.(message)
      },
    }
  }) as CreateConnectorFn
}
