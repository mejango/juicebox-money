import { JBCoreContracts, jbV6ContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { decodeEventLog, type TransactionReceipt } from 'viem'

const initializedAbi = [{ type: 'event', name: 'RulesetInitialized', inputs: [
  { name: 'rulesetId', type: 'uint256', indexed: true },
  { name: 'projectId', type: 'uint256', indexed: true },
  { name: 'basedOnId', type: 'uint256', indexed: true },
  { name: 'caller', type: 'address', indexed: false },
] }] as const

/** A successful transaction is not proof that each reviewed stage inherited from its predecessor. */
export function assertRulesetReceiptOrder(
  chainId: number,
  projectId: number | bigint,
  count: number,
  receipt: Pick<TransactionReceipt, 'logs'>,
  expectedFirstParentId?: bigint,
): void {
  if (count < 2) return
  const address = jbV6ContractAddress[JBCoreContracts.JBRulesets][chainId as JBChainId]?.toLowerCase()
  const stages: { rulesetId: bigint; basedOnId: bigint }[] = []
  for (const log of receipt.logs) {
    if (!address || log.address.toLowerCase() !== address) continue
    try {
      const { args } = decodeEventLog({ abi: initializedAbi, data: log.data, topics: log.topics })
      if (args.projectId === BigInt(projectId)) stages.push(args)
    } catch {
      // Other ruleset events are irrelevant to the initialized ancestry.
    }
  }
  if (stages.length !== count ||
    (expectedFirstParentId !== undefined && stages[0]?.basedOnId !== expectedFirstParentId) ||
    stages.some((stage, index) => index > 0 && stage.basedOnId !== stages[index - 1].rulesetId)) {
    throw new Error('The transaction confirmed, but its ruleset order could not be verified. Do not submit it again.')
  }
}
