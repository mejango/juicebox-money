import {
  jbPermissionsAbi,
  revOwnerAbi,
  jbProjectsAbi,
  jbControllerAbi,
  jbBuybackHookRegistryAbi,
  jbRouterTerminalRegistryAbi,
  jbBuybackHookAbi,
  jbContractAddress,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import {
  decodeFunctionData,
  encodeFunctionData,
  getAbiItem,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  multiSendCallsOf,
  MULTI_SEND_ABI,
} from "@bananapus/nana-sdk-core/safe";
import { truncateAddress } from "@/lib/format";
import { rolloutContractName } from "@/lib/protocol-rollout";
import { routerGatewayAbi } from "@/lib/router-gateway-abi";
import type { SafeQueuedTransaction } from "@bananapus/nana-sdk-core/safe-service";

/**
 * Selectors are derived from the SAME SDK ABIs the send path encodes with,
 * never from a hand-written signature string: a restated signature drifts
 * silently (`initializePoolFor`'s twapWindow is uint256, not uint32 — the
 * hand-written form produced a selector that matched nothing, so every queued
 * buyback-pool init rendered to co-signers as a bare selector).
 */
const LABELLED_CALLS: [Abi, string, string][] = [
  [jbPermissionsAbi, "setPermissionsFor", "Set permissions"],
  [revOwnerAbi, "setOperatorOf", "Transfer operator"],
  [jbProjectsAbi, "transferFrom", "Transfer ownership"],
  [jbControllerAbi, "setUriOf", "Set project metadata"],
  [jbControllerAbi, "deployERC20For", "Deploy ERC-20"],
  [jbControllerAbi, "setTokenMetadataOf", "Set token metadata"],
  [jbBuybackHookRegistryAbi, "setHookFor", "Set buyback hook"],
  [jbRouterTerminalRegistryAbi, "setTerminalFor", "Set router terminal"],
  [jbBuybackHookRegistryAbi, "initializePoolFor", "Initialize buyback pool"],
  [jbBuybackHookRegistryAbi, "setPoolFor", "Set buyback pool"],
  [jbBuybackHookAbi, "setTwapWindowOf", "Set buyback TWAP window"],
  [routerGatewayAbi, "processPendingCall", "Retry retained router call"],
  [
    routerGatewayAbi,
    "processPendingCallWithGas",
    "Retry retained router call with gas",
  ],
  [routerGatewayAbi, "finalizePendingCall", "Finalize retained router call"],
  [
    routerGatewayAbi,
    "finalizePendingCallWithGas",
    "Finalize retained router call with gas",
  ],
];

export const SELECTOR_LABELS = new Map<string, string>(
  LABELLED_CALLS.flatMap(([abi, name, label]) => {
    const item = getAbiItem({ abi, name });
    return item && item.type === "function"
      ? [[toFunctionSelector(item), label] as [string, string]]
      : [];
  }),
);

function contractName(chainId: JBChainId, address: Address): string | null {
  const rolloutName = rolloutContractName(chainId, address);
  if (rolloutName) return rolloutName;
  const contracts = jbContractAddress["6"] as unknown as Record<
    string,
    Partial<Record<JBChainId, Address>>
  >;
  for (const [name, deployments] of Object.entries(contracts)) {
    if (deployments?.[chainId]?.toLowerCase() === address.toLowerCase())
      return name;
  }
  return null;
}

function callLabel(
  chainId: JBChainId,
  to: Address,
  data: Hex | null | undefined,
): string {
  const selector = data?.slice(0, 10) ?? "0x";
  const action = SELECTOR_LABELS.get(selector);
  const target = contractName(chainId, to) ?? truncateAddress(to);
  return action ? `${action} | ${target}` : `${selector} | ${target}`;
}

/** The labelled inner calls of a queued operator batch, or null for any other row. */
export function batchCallLabels(
  chainId: JBChainId,
  tx: SafeQueuedTransaction,
): string[] | null {
  const calls = multiSendCallsOf(tx);
  return calls
    ? calls.map((call) => callLabel(chainId, call.to, call.data))
    : null;
}

/** The queue row's label: a known action and target, or a decoded operator batch. */
export function transactionLabel(chainId: JBChainId, tx: SafeQueuedTransaction): string {
  const batch = batchCallLabels(chainId, tx);
  if (batch)
    return `Batch (${batch.length} call${batch.length === 1 ? "" : "s"}) | MultiSendCallOnly`;
  return callLabel(chainId, tx.to, tx.data);
}

/** Exact queued bytes drive both the queue labels and confirmation details. */
export function queuedSafeReviewCall(
  chainId: JBChainId,
  tx: Pick<SafeQueuedTransaction, "to" | "data" | "value" | "operation">,
): import("@/lib/transaction-review").TransactionReviewCall {
  const call: import("@/lib/transaction-review").TransactionReviewCall = {
    chainId,
    to: tx.to,
    data: tx.data ?? "0x",
    value: BigInt(tx.value),
    contractName: contractName(chainId, tx.to) ?? undefined,
  };
  // The SDK validates recognized deployments, CALL-only entries and canonical bytes.
  const batch = multiSendCallsOf(tx);
  if (batch) {
      return {
        ...call,
        abi: MULTI_SEND_ABI,
        functionName: "multiSend",
        args: decodeFunctionData({ abi: MULTI_SEND_ABI, data: call.data }).args,
        label: `Batch (${batch.length} calls)`,
        contractName: "MultiSendCallOnly",
        calls: batch.map((inner) =>
          queuedSafeReviewCall(chainId, {
            ...inner,
            value: String(inner.value),
            operation: 0,
          }),
        ),
      };
  }
  // Unknown delegatecalls must stay explicit, without a reassuring action label.
  if (Number(tx.operation) !== 0)
    return {
      ...call,
      label: "DELEGATECALL — executes using the Safe storage and funds",
    };
  for (const [abi, name, label] of LABELLED_CALLS) {
    try {
      const decoded = decodeFunctionData({ abi, data: call.data });
      if (
        decoded.functionName !== name ||
        encodeFunctionData({
          abi,
          functionName: name,
          args: decoded.args,
        }).toLowerCase() !== call.data.toLowerCase()
      )
        continue;
      return { ...call, abi, functionName: name, args: decoded.args, label };
    } catch {
      /* Preserve raw calldata when the known ABI cannot decode it. */
    }
  }
  return call;
}
