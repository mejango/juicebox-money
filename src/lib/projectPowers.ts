import {
  JBCoreContracts,
  NATIVE_TOKEN,
  jbContractAddress,
} from '@bananapus/nana-sdk-core'
import { buildAccountingContext } from '@bananapus/nana-sdk-core/v6'
import type { Address } from 'viem'
import { resolvedAddress } from '@/lib/ens'

export type PowerFlag =
  | 'allowOwnerMinting'
  | 'allowAddPriceFeed'
  | 'allowSetTerminals'
  | 'allowSetController'
  | 'allowTerminalMigration'
  | 'allowSetCustomToken'
  | 'allowAddAccountingContext'

type FieldKind =
  | 'address'
  /** A per-chain LIST of addresses, entered one per line. */
  | 'addressList'
  | 'amount'
  | 'uint'
  | 'decimals'
  | 'bool'

export type FlowField = {
  name: string
  label: string
  kind: FieldKind
  placeholder?: string
  help?: string
  initial?:
    | string
    | 'ADDR_CONNECTED'
    | 'ADDR_CONTROLLER'
    | 'ADDR_TERMINAL'
    /** The project's CURRENT terminal list, read on chain. */
    | 'ADDR_TERMINALS'
}

export type ResolvedValues = Record<
  string,
  Address | readonly Address[] | bigint | number | boolean
>

export type PowerDescriptor = {
  flag: PowerFlag
  label: string
  desc: string
  actionLabel: string
  danger: string
  extreme?: boolean
  target: 'controller' | 'directory' | 'terminal'
  functionName: string
  fields: FlowField[]
  needsController: boolean
  buildArgs: (projectId: bigint, values: ResolvedValues) => readonly unknown[]
}

/** The complete set of ruleset-gated owner powers in V6. */
export const POWERS: PowerDescriptor[] = [
  {
    flag: 'allowOwnerMinting',
    label: 'Mint tokens',
    desc: 'Mint new project tokens to any address without a payment.',
    actionLabel: 'Mint tokens',
    danger:
      'Irreversible: minting dilutes every existing token holder and cannot be undone.',
    target: 'controller',
    functionName: 'mintTokensOf',
    needsController: true,
    fields: [
      {
        name: 'tokenCount',
        label: 'Amount (tokens)',
        kind: 'amount',
        placeholder: '0.0',
      },
      {
        name: 'beneficiary',
        label: 'Recipient',
        kind: 'address',
        placeholder: '0x… recipient',
        initial: 'ADDR_CONNECTED',
      },
      {
        name: 'useReservedPercent',
        label: 'Also send the reserved share',
        kind: 'bool',
        help: 'On: split this mint with the reserved recipients too. Off: the recipient gets the full amount.',
      },
    ],
    buildArgs: (projectId, values) => [
      projectId,
      values.tokenCount as bigint,
      values.beneficiary as Address,
      '',
      values.useReservedPercent as boolean,
    ],
  },
  {
    flag: 'allowAddPriceFeed',
    label: 'Add price feed',
    desc: 'Register a price feed the project uses to convert between currencies (e.g. ETH to USD).',
    actionLabel: 'Add price feed',
    danger:
      'Irreversible: a price feed cannot be removed once added, and a wrong feed misprices the whole project.',
    target: 'controller',
    functionName: 'addPriceFeedFor',
    needsController: true,
    fields: [
      {
        name: 'pricingCurrency',
        label: 'Pricing currency (id)',
        kind: 'uint',
        placeholder: 'e.g. 2 (USD)',
      },
      {
        name: 'unitCurrency',
        label: 'Unit currency (id)',
        kind: 'uint',
        placeholder: 'e.g. 1 (ETH)',
      },
      {
        name: 'feed',
        label: 'Feed',
        kind: 'address',
        placeholder: '0x… price feed',
      },
    ],
    buildArgs: (projectId, values) => [
      projectId,
      values.pricingCurrency as bigint,
      values.unitCurrency as bigint,
      values.feed as Address,
    ],
  },
  {
    flag: 'allowSetTerminals',
    label: 'Set payment terminals',
    desc: 'Set the complete list of terminals funds can be paid in through.',
    actionLabel: 'Set terminals',
    danger:
      'Dangerous: this REPLACES the entire terminal list — every terminal left out stops accepting payments and stops routing fees. Most projects launch with two (the standard terminal and the any-token router), so keep the ones you still want.',
    target: 'directory',
    functionName: 'setTerminalsOf',
    needsController: false,
    fields: [
      {
        name: 'terminals',
        label: 'Terminals',
        kind: 'addressList',
        placeholder: '0x… (one per line)',
        initial: 'ADDR_TERMINALS',
        help: 'The full list, one address per line. Prefilled with what is set on chain right now.',
      },
    ],
    buildArgs: (projectId, values) => [
      projectId,
      values.terminals as readonly Address[],
    ],
  },
  {
    flag: 'allowSetController',
    label: 'Set controller',
    desc: 'Swap the controller contract that manages the rulesets and tokens. Defaults to the standard controller.',
    actionLabel: 'Set controller',
    danger:
      'Dangerous: this hands control of the rules and tokens to a new contract. A wrong address can permanently brick or compromise the project.',
    extreme: true,
    target: 'directory',
    functionName: 'setControllerOf',
    needsController: false,
    fields: [
      {
        name: 'controller',
        label: 'Controller',
        kind: 'address',
        placeholder: '0x… controller',
        initial: 'ADDR_CONTROLLER',
      },
    ],
    buildArgs: (projectId, values) => [
      projectId,
      values.controller as Address,
    ],
  },
  {
    flag: 'allowTerminalMigration',
    label: 'Migrate terminal balance',
    desc: 'Move the project’s balance for a token from the current terminal to another terminal.',
    actionLabel: 'Migrate balance',
    danger:
      'Dangerous: this moves the project’s funds to another terminal. A wrong destination can lose the funds.',
    target: 'terminal',
    functionName: 'migrateBalanceOf',
    needsController: false,
    fields: [
      {
        name: 'token',
        label: 'Token',
        kind: 'address',
        placeholder: '0x… token',
        initial: NATIVE_TOKEN,
        help: 'Use the native-token sentinel for ETH.',
      },
      {
        name: 'to',
        label: 'New terminal',
        kind: 'address',
        placeholder: '0x… destination terminal',
      },
    ],
    buildArgs: (projectId, values) => [
      projectId,
      values.token as Address,
      values.to as Address,
    ],
  },
  {
    flag: 'allowSetCustomToken',
    label: 'Set custom token',
    desc: 'Replace the project token with a custom ERC-20 (it must conform to IJBToken).',
    actionLabel: 'Set token',
    danger:
      'Irreversible: replacing the project token is permanent and affects every holder.',
    target: 'controller',
    functionName: 'setTokenFor',
    needsController: true,
    fields: [
      {
        name: 'token',
        label: 'Token',
        kind: 'address',
        placeholder: '0x… ERC-20 (IJBToken)',
      },
    ],
    buildArgs: (projectId, values) => [
      projectId,
      values.token as Address,
    ],
  },
  {
    flag: 'allowAddAccountingContext',
    label: 'Add accounting token',
    desc: 'Register a new token the project’s terminal accepts directly (e.g. an ERC-20 or USDC), with its decimals.',
    actionLabel: 'Add accounting token',
    danger:
      'Irreversible: once added, the terminal accepts this token forever — accounting tokens cannot be removed. Verify the token and its decimals carefully.',
    target: 'terminal',
    functionName: 'addAccountingContextsFor',
    needsController: false,
    fields: [
      {
        name: 'token',
        label: 'Token',
        kind: 'address',
        placeholder: '0x… ERC-20',
      },
      {
        name: 'decimals',
        label: 'Decimals',
        kind: 'decimals',
        placeholder: 'e.g. 6 (USDC), 18 (most ERC-20)',
      },
    ],
    buildArgs: (projectId, values) => [
      projectId,
      [
        buildAccountingContext(
          values.token as Address,
          Number(values.decimals),
        ),
      ],
    ],
  },
]

/** The live per-chain state a field's prefill can read. */
export type PowerFieldContext = {
  chainId: number
  controller: Address | null
  /** The project's CURRENT terminal list, or null when it could not be read. */
  terminals: readonly Address[] | null
}

/** A field's starting value on one chain, resolving the ADDR_* prefill sentinels. */
export function initialFieldValue(
  field: FlowField,
  row: PowerFieldContext,
  connected: Address | undefined,
): string {
  if (field.initial === 'ADDR_CONNECTED') return connected ?? ''
  if (field.initial === 'ADDR_CONTROLLER') return row.controller ?? ''
  if (field.initial === 'ADDR_TERMINAL') {
    return (
      ((
        jbContractAddress['6'][JBCoreContracts.JBMultiTerminal] as Record<
          number,
          Address | undefined
        >
      )[row.chainId] ?? '')
    )
  }
  // An unread list stays EMPTY rather than falling back to the standard terminal alone:
  // a silent one-entry prefill is exactly how the router terminal got dropped.
  if (field.initial === 'ADDR_TERMINALS') return (row.terminals ?? []).join('\n')
  return field.initial ?? ''
}

/**
 * One-per-line (or comma-separated) address list → resolved addresses, deduped in order.
 * Null when the text is empty or any entry does not resolve — a partially-parsed list
 * would silently drop a terminal, which is the failure this field exists to prevent.
 */
export function parseAddressList(raw: string): Address[] | null {
  const entries = raw
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(Boolean)
  if (!entries.length) return null
  const out: Address[] = []
  for (const entry of entries) {
    const resolved = resolvedAddress(entry)
    if (!resolved) return null
    if (!out.some(existing => existing.toLowerCase() === resolved.toLowerCase())) {
      out.push(resolved)
    }
  }
  return out
}
