import { NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildAccountingContext,
  buildLaunchProjectTx,
  buildRulesetConfiguration,
  buildRulesetMetadata,
  buildTerminalConfigurations,
} from '@bananapus/nana-sdk-core/v6'
import type { Address, TransactionReceipt } from 'viem'

/** 1,000,000 tokens per ETH paid (18-decimal fixed point). */
export const LAUNCH_WEIGHT = 10n ** 24n

/**
 * Assemble the `launchProjectFor` request for one chain. Pure — no wallet, no
 * network — so it's directly testable via `simulateContract`.
 *
 * Defaults (mainstream launch): open-ended ruleset (duration 0, changeable
 * any time), 1,000,000 tokens per ETH, 0% reserved, 0% cash-out tax,
 * baseCurrency ETH, native-token treasury.
 *
 * Multi-chain launches are independent per-chain transactions — no suckers
 * are configured, so byte-identical rulesets (a shared mustStartAtOrAfter)
 * aren't required. Cross-chain token bridging setup comes later.
 */
export function buildLaunchRequest(args: {
  chainId: JBChainId
  owner: Address
  projectUri: string
  creationFee: bigint
}) {
  return buildLaunchProjectTx({
    chainId: args.chainId,
    owner: args.owner,
    projectUri: args.projectUri,
    rulesetConfigurations: [
      buildRulesetConfiguration({
        metadata: buildRulesetMetadata({}),
        weight: LAUNCH_WEIGHT,
      }),
    ],
    terminalConfigurations: buildTerminalConfigurations({
      chainId: args.chainId,
      accountingContexts: [buildAccountingContext(NATIVE_TOKEN)],
    }),
    memo: '',
    creationFee: args.creationFee,
  })
}

const ERC721_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * Pull the new project id out of a launch receipt: the JBProjects ERC-721
 * mint is the Transfer log with 4 topics whose `from` is the zero address —
 * its tokenId topic IS the project id.
 */
export function projectIdFromReceipt(
  receipt: TransactionReceipt,
): number | null {
  for (const log of receipt.logs) {
    if (
      log.topics[0] === ERC721_TRANSFER_TOPIC &&
      log.topics.length === 4 &&
      BigInt(log.topics[1] ?? '0x0') === 0n
    ) {
      return parseInt(log.topics[3] as string, 16)
    }
  }
  return null
}
