import {
  JBPermissionCatalogV6,
  JBPermissionIdsV6,
  decodePermissionBitmap as decodeSdkPermissionBitmap,
} from '@bananapus/nana-sdk-core/v6'

export type PermissionDefinition = {
  id: number
  key: keyof typeof JBPermissionIdsV6
  label: string
  description: string
}

/**
 * The complete V6 permission surface. Permission ids are bit positions in
 * JBPermissions.permissionsOf; keeping the labels here makes the read and edit
 * views agree and prevents newly indexed permissions from being reduced to a
 * bare number.
 */
const PERMISSION_COPY = [
  ['ROOT', 'Full control (root)', 'Grants every permission below — full control of the project.'],
  ['QUEUE_RULESETS', 'Queue rulesets', 'Queue future rulesets, including issuance, payouts, and project rules.'],
  ['LAUNCH_RULESETS', 'Launch rulesets', 'Launch the project’s first rulesets.'],
  ['CASH_OUT_TOKENS', 'Cash out tokens', 'Cash out project tokens for a holder’s share of project funds.'],
  ['SEND_PAYOUTS', 'Send payouts', 'Send the project’s scheduled payouts to its configured splits.'],
  ['MIGRATE_TERMINAL', 'Migrate terminal', 'Move project funds to a new terminal version.'],
  ['SET_PROJECT_URI', 'Set project metadata', 'Update the project name, logo, description, and other metadata.'],
  ['DEPLOY_ERC20', 'Deploy ERC-20', 'Deploy the project’s transferable ERC-20 token.'],
  ['SET_TOKEN', 'Set custom token', 'Replace the project token with a custom ERC-20.'],
  ['MINT_TOKENS', 'Mint tokens', 'Mint project tokens to any account without a payment.'],
  ['BURN_TOKENS', 'Burn tokens', 'Burn project tokens from a holder’s balance.'],
  ['CLAIM_TOKENS', 'Claim tokens', 'Claim a holder’s credits into the project ERC-20.'],
  ['TRANSFER_CREDITS', 'Transfer credits', 'Transfer a holder’s unclaimed project-token credits.'],
  ['SET_CONTROLLER', 'Set controller', 'Replace the contract that manages rulesets and project tokens.'],
  ['SET_TERMINALS', 'Set terminals', 'Replace the complete list of payment terminals.'],
  ['ADD_TERMINALS', 'Add terminals', 'Add payment terminals without replacing the current list.'],
  ['SET_PRIMARY_TERMINAL', 'Set primary terminal', 'Choose the primary terminal for a token.'],
  ['USE_ALLOWANCE', 'Use surplus allowance', 'Spend from the project’s configured surplus allowance.'],
  ['SET_SPLIT_GROUPS', 'Set splits', 'Edit payout and reserved-token split groups.'],
  ['ADD_PRICE_FEED', 'Add price feed', 'Add a feed used to convert between project currencies.'],
  ['ADD_ACCOUNTING_CONTEXTS', 'Add accounting tokens', 'Register tokens the terminal accepts directly, such as USDC.'],
  ['SET_TOKEN_METADATA', 'Set token metadata', 'Change the project token’s name and symbol.'],
  ['SIGN_FOR_ERC20', 'Sign for ERC-20 (permit)', 'Sign ERC-20 permit approvals on the project’s behalf.'],
  ['ADJUST_721_TIERS', 'Adjust shop items', 'Add, remove, or change the project’s shop items (NFT tiers).'],
  ['SET_721_METADATA', 'Set shop metadata', 'Update the shop collection’s metadata.'],
  ['MINT_721', 'Mint shop items', 'Mint the project’s shop items (NFTs) without a payment.'],
  ['SET_721_DISCOUNT_PERCENT', 'Set shop discount', 'Set the discount applied to shop item prices.'],
  ['SET_BUYBACK_TWAP', 'Set buyback TWAP', 'Set the buyback hook’s TWAP window.'],
  ['SET_BUYBACK_POOL', 'Set buyback pool', 'Set or initialize the buyback hook’s AMM pool.'],
  ['SET_BUYBACK_HOOK', 'Set buyback hook', 'Set the hook that chooses issuance versus AMM buys.'],
  ['SET_ROUTER_TERMINAL', 'Set router terminal', 'Set the terminal used by the project’s swap router.'],
  ['MAP_SUCKER_TOKEN', 'Map sucker token', 'Map a token for cross-chain bridging through suckers.'],
  ['DEPLOY_SUCKERS', 'Deploy suckers', 'Deploy the project’s cross-chain sucker contracts.'],
  ['SET_SUCKER_PEER', 'Set sucker peer', 'Set a sucker’s peer on another chain.'],
  ['SUCKER_SAFETY', 'Sucker safety controls', 'Manage sucker caps, emergency hatches, and other safety limits.'],
  ['SET_SUCKER_DEPRECATION', 'Set sucker deprecation', 'Deprecate and wind down a sucker bridge.'],
  ['OPEN_LOAN', 'Open loans', 'Open loans against the project’s tokens.'],
  ['REALLOCATE_LOAN', 'Reallocate loans', 'Move collateral between the project’s loans.'],
  ['REPAY_LOAN', 'Repay loans', 'Repay the project’s loans.'],
] as const

const COPY_BY_KEY = new Map(
  PERMISSION_COPY.map(([key, label, description]) => [
    key,
    { label, description },
  ]),
)

export const V6_PERMISSIONS: PermissionDefinition[] =
  JBPermissionCatalogV6.map(({ key, id }) => {
    const copy = COPY_BY_KEY.get(key)
    return {
      key,
      id,
      label: copy?.label ?? key,
      description:
        copy?.description ??
        'This permission is recognized by the SDK but has no app-specific description yet.',
    }
  })

const BY_ID = new Map(V6_PERMISSIONS.map(permission => [permission.id, permission]))

export function permissionDefinition(id: number): PermissionDefinition {
  return (
    BY_ID.get(id) ?? {
      id,
      key: `UNKNOWN_${id}` as keyof typeof JBPermissionIdsV6,
      label: `Permission #${id}`,
      description: 'This permission is not recognized by this version of the interface.',
    }
  )
}

/**
 * Whether the SDK catalog knows this id. Callers that must preserve bits this
 * build cannot render — the permission editor rewrites the whole set — key off
 * the catalog rather than a hard-coded ceiling, so a future id stays preserved
 * instead of becoming an irrevocable checkbox the moment the catalog grows.
 */
export function isKnownPermissionId(id: number): boolean {
  return BY_ID.has(id)
}

export function decodePermissionBitmap(bitmap: bigint): number[] {
  return decodeSdkPermissionBitmap(bitmap, { includeUnknown: true })
}
