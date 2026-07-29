'use client'

import { paraConnector } from '@getpara/wagmi-v2-connector'
import ParaWeb, { type Environment } from '@getpara/web-sdk'
import type { Transport } from 'viem'
import type { CreateConnectorFn } from 'wagmi'

export const PARA_APP = {
  appName: 'Juicebox',
  appDescription: 'Fund your thing. Programmable money for projects.',
  appUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://juicebox.money',
}

let client: ParaWeb | undefined

/** Constructing Para starts its worker/session machinery. Keep the singleton
 * behind a user action so an anonymous page view performs no wallet traffic. */
export function getParaClient(): ParaWeb {
  client ??= new ParaWeb(
    (process.env.NEXT_PUBLIC_PARA_ENV as Environment) || 'BETA',
    process.env.NEXT_PUBLIC_PARA_API_KEY ?? '',
  )
  return client
}

export function createParaWagmiConnector(
  transports: Record<number, Transport>,
): CreateConnectorFn {
  // Para 3.8's declaration excludes wagmi's nullable storage branch, although
  // its runtime connector implements the same interface.
  return paraConnector({
    para: getParaClient(),
    appName: PARA_APP.appName,
    options: {},
    disableModal: true,
    transports,
  }) as unknown as CreateConnectorFn
}
