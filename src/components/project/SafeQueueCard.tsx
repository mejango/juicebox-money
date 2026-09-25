"use client";

import { chainName } from '@/lib/urn'
import {
  JBCoreContracts,
  RevnetCoreContracts,
  jbBuybackHookAbi,
  jbBuybackHookRegistryAbi,
  jbContractAddress,
  jbControllerAbi,
  jbPermissionsAbi,
  jbProjectsAbi,
  jbRouterTerminalRegistryAbi,
  revOwnerAbi,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeFunctionData,
  encodeFunctionData,
  getAbiItem,
  isAddressEqual,
  keccak256,
  stringToBytes,
  stringToHex,
  toFunctionSelector,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { ChainIcon } from "@/components/ChainIcon";
import { SafeQueueSkeleton } from "@/components/LoadingSkeletons";
import { TxError } from "@/components/ui/TxError";
import { useWallet } from "@/hooks/useWallet";
import {
  clearRelayrPendingSession,
  loadRelayrPendingSession,
  relayrErrorIsDefiniteNoSubmission,
  relayrDestinationHash,
  relayrPay,
  relayrPaymentLabel,
  relayrPaymentOptions,
  relayrPoll,
  relayrPostBundle,
  relayrProgress,
  relayrRecordChain,
  relayrStateIsFailed,
  relayrStateIsSuccess,
  saveRelayrPendingSession,
  saveRelayrPendingSessionDurably,
  withRelayrScopeLock,
  type RelayrEntry,
  type RelayrPayment,
  type RelayrPendingSession,
  type RelayrQuote,
  type RelayrSafeExecutionProof,
  type RelayrTransactionRecord,
} from "@/lib/relayr";
import { relayrSupportsChains } from "@/lib/relayr-chains";
import { decodeMultiSend, MULTI_SEND_CALL_ONLY } from "@/lib/safe-batch";
import {
  confirmSafeTx,
  canonicalSafeTxHash,
  executeSafeTx,
  fetchSafeInfo,
  getSafeNextNonce,
  hasSafeService,
  listPendingSafeTxs,
  safeExecRelayrEntry,
  safeQueueLink,
  simulateSafeExecution,
  safeUsableConfirmationCount,
  type SafeInfo,
  type SafeExecutionSnapshot,
  type SafeQueuedTx,
  SAFE_EXEC_ABI,
} from "@/lib/safe";
import { truncateAddress } from "@/lib/format";
import { ModalShell } from "@/components/ui/ModalShell";
import { isSafeConnection } from "@/lib/safe-connector";
import { wagmiConfig } from "@/providers/Providers";
import { AddressLabel } from "@/components/ui/AddressLabel";
import { explorerTxUrl } from '@/lib/chainDisplay'
import { clientFor } from '@/lib/authority'
import {
  ENS_REGISTRY_ADDRESS,
  PROJECT_HANDLES_ADDRESS,
  PROJECT_HANDLES_CHAIN_ID,
  PROJECT_HANDLE_RESOLVER_WRITE_GAS,
  PROJECT_HANDLE_TEXT_KEY,
  PROJECT_HANDLE_WRITE_GAS,
  ensRegistryAbi,
  ensTextResolverAbi,
  jbProjectHandlesAbi,
  normalizeProjectHandle,
  parseProjectHandleRecord,
  projectHandleRecord,
  readBoundedProjectHandle,
  readDirectEnsProjectRecord,
  readDirectEnsText,
} from '@/lib/project-handles'
import { readMatchingAuthorityIdentities } from '@/lib/cross-chain-authority'
import { simulateStateChangingTransaction } from '@/lib/transaction-simulation'
import { readBoundedSafeNonce } from '@/lib/safe-reads'
import { rolloutContractName } from '@/lib/protocol-rollout'
import { routerGatewayAbi } from '@/lib/router-gateway-abi'

export type SafeQueueChain = {
  chainId: JBChainId;
  name: string;
  projectId: number;
  isRevnet: boolean;
  /** Exact project deployments visible in this Owner/Operator surface. */
  handleTuples: readonly { chainId: number; projectId: number }[];
  /** Synthetic Ethereum row used only for delayed ENS/Handles Safe calls. */
  handleOnly?: boolean;
};

type ChainQueue = SafeQueueChain & {
  info: SafeInfo | null;
  currentNonce: number | null;
  transactions: SafeQueuedTx[];
  error: string | null;
};

type ReadyTx = {
  chain: ChainQueue;
  tx: SafeQueuedTx;
};

type VerifiedReadyTx = ReadyTx & {
  snapshot: SafeExecutionSnapshot;
};

type BatchReview = {
  quote: RelayrQuote;
  rows: VerifiedReadyTx[];
  entries: RelayrEntry[];
  payments: RelayrPayment[];
};

/** Signers by ENS name when they have one, with the connected wallet marked. */
function SignerList({ owners, you }: { owners: readonly string[]; you?: string }) {
  return (
    <>
      {owners.map((owner, index) => (
        <span key={owner}>
          {index ? ", " : null}
          <AddressLabel address={owner} />
          {you && owner.toLowerCase() === you.toLowerCase() ? " (you)" : null}
        </span>
      ))}
    </>
  );
}

/** One chain's line in the Execute all dialog. */
type BatchDialogRow = {
  chainId: number;
  nonce: number | null;
  label: string;
  calls: string[] | null;
};

function batchDialogRow(row: ReadyTx): BatchDialogRow {
  return {
    chainId: row.chain.chainId,
    nonce: Number(row.tx.nonce),
    label: transactionLabel(row.chain.chainId, row.tx),
    calls: batchCallLabels(row.chain.chainId, row.tx),
  };
}

const ENS_SET_TEXT_SELECTOR = encodeFunctionData({
  abi: ensTextResolverAbi,
  functionName: "setText",
  args: [
    `0x${"00".repeat(32)}`,
    PROJECT_HANDLE_TEXT_KEY,
    "1:1",
  ],
}).slice(0, 10);
const SET_PROJECT_HANDLE_SELECTOR = encodeFunctionData({
  abi: jbProjectHandlesAbi,
  functionName: "setEnsNamePartsFor",
  args: [1n, 1n, ["fixture"]],
}).slice(0, 10);
const SAFE_EXECUTION_SUCCESS_TOPIC = keccak256(
  stringToHex("ExecutionSuccess(bytes32,uint256)"),
);

function hasExactSafeExecutionSuccess(
  logs: readonly {
    address: Address;
    data: Hex;
    topics: readonly Hex[];
  }[],
  safe: Address,
  safeTxHash: Hex,
): boolean {
  const expectedHash = safeTxHash.toLowerCase();
  return logs.some((log) => {
    if (
      !isAddressEqual(log.address, safe) ||
      log.topics[0]?.toLowerCase() !== SAFE_EXECUTION_SUCCESS_TOPIC.toLowerCase()
    ) {
      return false;
    }
    // Safe 1.3 emits txHash in data; Safe 1.4 indexes it. Support both
    // canonical layouts while rejecting any loosely-shaped lookalike log.
    if (log.topics.length === 2 && log.data.length === 66) {
      return (
        log.topics[1]?.toLowerCase() === expectedHash &&
        log.data === `0x${"00".repeat(32)}`
      );
    }
    return (
      log.topics.length === 1 &&
      log.data.length === 130 &&
      `0x${log.data.slice(2, 66)}`.toLowerCase() === expectedHash &&
      log.data.slice(66) === "00".repeat(32)
    );
  });
}

/**
 * Relayr's status API is progress-only. Before a paid Safe batch is forgotten,
 * independently prove that every returned destination hash is the exact outer
 * execTransaction we paid for and that the Safe reported its inner call as a
 * success while consuming the expected nonce.
 */
export async function verifyRelayrSafeBatchLanding(
  safe: Address,
  records: readonly RelayrTransactionRecord[],
  entries: readonly RelayrEntry[],
  proofs: readonly RelayrSafeExecutionProof[],
): Promise<void> {
  if (
    entries.length < 1 ||
    records.length !== entries.length ||
    proofs.length !== entries.length
  ) {
    throw new Error(
      "The paid Relayr bundle lacks its exact Safe execution proof. Keep it pending and verify it manually.",
    );
  }

  // Records are matched by chain and exact request; the ID only has to be one
  // this bundle quoted, since sessions saved before quotes bound IDs by
  // request carry position-paired IDs.
  const quotedIds = new Set(proofs.map((proof) => String(proof.txUuid).toLowerCase()));
  const seenChains = new Set<number>();
  const seenHashes = new Set<string>();
  const seenTxUuids = new Set<string>();
  for (const entry of entries) {
    if (seenChains.has(entry.chain)) {
      throw new Error("The paid Relayr Safe bundle contains duplicate chains.");
    }
    seenChains.add(entry.chain);
    if (!isAddressEqual(entry.target, safe)) {
      throw new Error("The paid Relayr entry targets another Safe.");
    }
    const matchingRecords = records.filter(
      (record) => relayrRecordChain(record) === entry.chain,
    );
    const matchingProofs = proofs.filter((proof) => proof.chainId === entry.chain);
    if (matchingRecords.length !== 1 || matchingProofs.length !== 1) {
      throw new Error("Relayr did not return one exact result for every Safe chain.");
    }
    const record = matchingRecords[0];
    const proof = matchingProofs[0];
    const hash = relayrDestinationHash(record);
    const request = record.request;
    let expectedValue: bigint | null = null;
    let requestValue: bigint | null = null;
    try {
      expectedValue = BigInt(entry.value);
      requestValue = request ? BigInt(request.value) : null;
    } catch {
      requestValue = null;
    }
    const txUuid = String(record.tx_uuid ?? "").toLowerCase();
    if (
      !relayrStateIsSuccess(record.status?.state) ||
      !hash ||
      !/^0x[0-9a-fA-F]{64}$/u.test(hash) ||
      seenHashes.has(hash.toLowerCase()) ||
      !isAddressEqual(proof.safe, safe) ||
      !Number.isSafeInteger(proof.nonce) ||
      proof.nonce < 0 ||
      !/^0x[0-9a-fA-F]{64}$/u.test(proof.safeTxHash) ||
      typeof proof.txUuid !== "string" ||
      !quotedIds.has(txUuid) ||
      seenTxUuids.has(txUuid) ||
      !request ||
      request.chain !== entry.chain ||
      !isAddressEqual(request.target, entry.target) ||
      request.data.toLowerCase() !== entry.data.toLowerCase() ||
      expectedValue === null ||
      requestValue === null ||
      requestValue !== expectedValue ||
      request.virtual_nonce !== (entry.virtual_nonce ?? 0)
    ) {
      throw new Error("Relayr returned an invalid Safe execution result.");
    }
    seenHashes.add(hash.toLowerCase());
    seenTxUuids.add(txUuid);

    const client = clientFor(entry.chain as JBChainId);
    const [transaction, receipt, nonceRaw] = await Promise.all([
      client.getTransaction({ hash }),
      client.getTransactionReceipt({ hash }),
      readBoundedSafeNonce(client, safe),
    ]);
    const transactionInput = (transaction as { input?: Hex; data?: Hex }).input ??
      (transaction as { data?: Hex }).data;
    if (
      receipt.status !== "success" ||
      receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
      transaction.hash?.toLowerCase() !== hash.toLowerCase() ||
      transaction.chainId !== entry.chain ||
      !receipt.blockHash ||
      typeof receipt.blockNumber !== "bigint" ||
      transaction.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      transaction.blockNumber !== receipt.blockNumber ||
      !transaction.to ||
      !isAddressEqual(transaction.to, entry.target) ||
      transaction.value !== expectedValue ||
      transactionInput?.toLowerCase() !== entry.data.toLowerCase() ||
      nonceRaw === null ||
      nonceRaw <= BigInt(proof.nonce) ||
      !hasExactSafeExecutionSuccess(
        receipt.logs as readonly {
          address: Address;
          data: Hex;
          topics: readonly Hex[];
        }[],
        safe,
        proof.safeTxHash,
      )
    ) {
      throw new Error(
        `Could not prove the exact Safe execution landed successfully on chain ${entry.chain}. Keep the paid bundle pending.`,
      );
    }
    const canonicalBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (canonicalBlock.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      throw new Error(
        `The Safe execution receipt on chain ${entry.chain} is no longer canonical. Keep the paid bundle pending.`,
      );
    }
    await assertRelayrProjectHandlePostcondition(
      entry.chain as JBChainId,
      safe,
      entry,
    );
  }
}

function exactPlainSafeCall(tx: SafeQueuedTx): void {
  let value: bigint;
  let safeTxGas: bigint;
  let baseGas: bigint;
  let gasPrice: bigint;
  try {
    value = BigInt(tx.value ?? 0);
    safeTxGas = BigInt(tx.safeTxGas ?? 0);
    baseGas = BigInt(tx.baseGas ?? 0);
    gasPrice = BigInt(tx.gasPrice ?? 0);
  } catch {
    throw new Error("The queued Safe transaction has invalid payment fields.");
  }
  if (
    Number(tx.operation ?? 0) !== 0 ||
    value !== 0n ||
    safeTxGas !== 0n ||
    baseGas !== 0n ||
    gasPrice !== 0n ||
    !isAddressEqual(tx.gasToken, zeroAddress) ||
    !isAddressEqual(tx.refundReceiver, zeroAddress)
  ) {
    throw new Error(
      "Project handle transactions must be zero-value direct Safe calls without gas reimbursement.",
    );
  }
}

async function assertSafeControlsProjectTuple(
  chainId: number,
  projectId: number,
  safe: Address,
): Promise<JBChainId> {
  const projects = (
    jbContractAddress["6"][JBCoreContracts.JBProjects] as Partial<
      Record<JBChainId, Address>
    >
  )[chainId as JBChainId];
  const revOwner = (
    jbContractAddress["6"][RevnetCoreContracts.REVOwner] as Partial<
      Record<JBChainId, Address>
    >
  )[chainId as JBChainId];
  if (
    !projects ||
    !revOwner ||
    !Number.isSafeInteger(chainId) ||
    !Number.isSafeInteger(projectId) ||
    projectId < 1
  ) {
    throw new Error("The queued handle claim targets an unsupported project.");
  }

  const supportedChainId = chainId as JBChainId;
  const client = clientFor(supportedChainId);
  const owner = await client.readContract({
    address: projects,
    abi: jbProjectsAbi,
    functionName: "ownerOf",
    args: [BigInt(projectId)],
  });
  if (isAddressEqual(owner, safe)) return supportedChainId;
  if (!isAddressEqual(owner, revOwner)) {
    throw new Error(
      `This Safe is no longer the owner of project ${chainId}:${projectId}.`,
    );
  }
  const isOperator = await client.readContract({
    address: revOwner,
    abi: revOwnerAbi,
    functionName: "isOperatorOf",
    args: [BigInt(projectId), safe],
  });
  if (!isOperator) {
    throw new Error(
      `This Safe is no longer the revnet operator for ${chainId}:${projectId}.`,
    );
  }
  return supportedChainId;
}

/**
 * Reconstruct the mutable proofs ProjectHandleCard used when it first queued
 * a Safe transaction. Hosted Safe records persist after resolver delegation,
 * ENS text, project authority, or cross-chain Safe policy changes.
 */
export async function assertQueuedProjectHandleContext(
  queueChainId: JBChainId,
  safe: Address,
  tx: SafeQueuedTx,
  allowedTuples: readonly { chainId: number; projectId: number }[],
): Promise<boolean> {
  const data = tx.data ?? "0x";
  const handlesTarget = isAddressEqual(tx.to, PROJECT_HANDLES_ADDRESS);
  if (!/^0x(?:[0-9a-fA-F]{2})*$/u.test(data) || (data.length - 2) / 2 > 4_096) {
    if (handlesTarget || data.slice(0, 10).toLowerCase() === ENS_SET_TEXT_SELECTOR.toLowerCase()) {
      throw new Error("The queued project handle calldata is malformed or too large.");
    }
    return false;
  }
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === ENS_SET_TEXT_SELECTOR.toLowerCase()) {
    let decoded: ReturnType<typeof decodeFunctionData>;
    try {
      decoded = decodeFunctionData({ abi: ensTextResolverAbi, data });
    } catch {
      throw new Error("The queued ENS record update is malformed.");
    }
    if (decoded.functionName !== "setText") return false;
    const [node, key, value] = decoded.args as readonly [Hex, string, string];
    if (key !== PROJECT_HANDLE_TEXT_KEY) return false;
    if (queueChainId !== PROJECT_HANDLES_CHAIN_ID) {
      throw new Error("Queued ENS project records must execute on Ethereum.");
    }
    exactPlainSafeCall(tx);
    const parsedRecord = parseProjectHandleRecord(value);
    if (!parsedRecord) {
      throw new Error("The queued ENS Juicebox record is malformed.");
    }
    if (
      !allowedTuples.some(
        tuple =>
          tuple.chainId === parsedRecord.chainId &&
          tuple.projectId === parsedRecord.projectId,
      )
    ) {
      throw new Error("The queued ENS record belongs to another project.");
    }
    const targetChainId = await assertSafeControlsProjectTuple(
      parsedRecord.chainId,
      parsedRecord.projectId,
      safe,
    );
    const canonicalData = encodeFunctionData({
      abi: ensTextResolverAbi,
      functionName: "setText",
      args: [node, key, value],
    });
    if (canonicalData.toLowerCase() !== data.toLowerCase()) {
      throw new Error("The queued ENS record calldata is not canonical.");
    }
    const client = clientFor(PROJECT_HANDLES_CHAIN_ID);
    if (targetChainId !== PROJECT_HANDLES_CHAIN_ID) {
      const identities = await readMatchingAuthorityIdentities({
        sourceClient: clientFor(targetChainId),
        destinationClient: client,
        authority: safe,
      });
      if (!identities?.matches) {
        throw new Error(
          "The Safe control policy no longer matches between the project chain and Ethereum.",
        );
      }
    }
    const resolver = await client.readContract({
      address: ENS_REGISTRY_ADDRESS,
      abi: ensRegistryAbi,
      functionName: "resolver",
      args: [node],
    });
    if (
      isAddressEqual(resolver, zeroAddress) ||
      !isAddressEqual(resolver, tx.to)
    ) {
      throw new Error(
        "The ENS resolver changed after this Safe transaction was queued.",
      );
    }
    await simulateStateChangingTransaction(client, {
      from: safe,
      to: tx.to,
      data,
      gas: PROJECT_HANDLE_RESOLVER_WRITE_GAS,
    });
    return true;
  }

  if (!handlesTarget) return false;
  if (queueChainId !== PROJECT_HANDLES_CHAIN_ID) {
    throw new Error("Queued JBProjectHandles claims must execute on Ethereum.");
  }
  if (selector !== SET_PROJECT_HANDLE_SELECTOR.toLowerCase()) {
    throw new Error("The queued JBProjectHandles call is not recognized.");
  }
  exactPlainSafeCall(tx);
  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({ abi: jbProjectHandlesAbi, data });
  } catch {
    throw new Error("The queued project handle claim is malformed.");
  }
  if (decoded.functionName !== "setEnsNamePartsFor") {
    throw new Error("The queued JBProjectHandles call is not recognized.");
  }
  const [rawChainId, rawProjectId, parts] = decoded.args as readonly [
    bigint,
    bigint,
    readonly string[],
  ];
  if (
    parts.length < 1 ||
    parts.length > 127 ||
    parts.some(part => stringToBytes(part).length > 255)
  ) {
    throw new Error("The queued project handle labels are too large.");
  }
  if (
    rawChainId > BigInt(Number.MAX_SAFE_INTEGER) ||
    rawProjectId > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("The queued handle claim targets an unsupported project.");
  }
  const chainId = Number(rawChainId);
  const projectId = Number(rawProjectId);
  if (
    !allowedTuples.some(
      tuple => tuple.chainId === chainId && tuple.projectId === projectId,
    )
  ) {
    throw new Error("The queued handle claim belongs to another project.");
  }
  const normalized = normalizeProjectHandle([...parts].reverse().join("."));
  if (
    !normalized ||
    normalized.parts.length !== parts.length ||
    normalized.parts.some((part, index) => part !== parts[index])
  ) {
    throw new Error("The queued project handle labels are not canonical.");
  }
  const canonicalData = encodeFunctionData({
    abi: jbProjectHandlesAbi,
    functionName: "setEnsNamePartsFor",
    args: [rawChainId, rawProjectId, parts],
  });
  if (canonicalData.toLowerCase() !== data.toLowerCase()) {
    throw new Error("The queued project handle calldata is not canonical.");
  }

  const targetChainId = await assertSafeControlsProjectTuple(
    chainId,
    projectId,
    safe,
  );
  const mainnetClient = clientFor(PROJECT_HANDLES_CHAIN_ID);
  if (targetChainId !== PROJECT_HANDLES_CHAIN_ID) {
    const identities = await readMatchingAuthorityIdentities({
      sourceClient: clientFor(targetChainId),
      destinationClient: mainnetClient,
      authority: safe,
    });
    if (!identities?.matches) {
      throw new Error(
        "The Safe control policy no longer matches between the project chain and Ethereum.",
      );
    }
  }
  const record = await readDirectEnsProjectRecord(
    mainnetClient,
    normalized.ensName,
  );
  if (record.textRecord !== projectHandleRecord(chainId, projectId)) {
    throw new Error(
      "The ENS Juicebox record changed after this handle claim was queued.",
    );
  }
  await simulateStateChangingTransaction(mainnetClient, {
    from: safe,
    to: PROJECT_HANDLES_ADDRESS,
    data,
    gas: PROJECT_HANDLE_WRITE_GAS,
  });
  return true;
}

async function assertRelayrProjectHandlePostcondition(
  queueChainId: JBChainId,
  safe: Address,
  entry: RelayrEntry,
): Promise<void> {
  let outer: ReturnType<typeof decodeFunctionData>;
  try {
    outer = decodeFunctionData({ abi: SAFE_EXEC_ABI, data: entry.data });
  } catch {
    throw new Error("The persisted Relayr Safe execution is malformed.");
  }
  if (outer.functionName !== "execTransaction") {
    throw new Error("The persisted Relayr Safe execution is not canonical.");
  }
  const [
    target,
    value,
    innerData,
    operation,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
  ] = outer.args as readonly [
    Address,
    bigint,
    Hex,
    number,
    bigint,
    bigint,
    bigint,
    Address,
    Address,
    Hex,
  ];
  const selector = innerData.slice(0, 10).toLowerCase();
  const handlesTarget = isAddressEqual(target, PROJECT_HANDLES_ADDRESS);
  if (!handlesTarget && selector !== ENS_SET_TEXT_SELECTOR.toLowerCase()) return;
  if (
    queueChainId !== PROJECT_HANDLES_CHAIN_ID ||
    value !== 0n ||
    Number(operation) !== 0 ||
    safeTxGas !== 0n ||
    baseGas !== 0n ||
    gasPrice !== 0n ||
    !isAddressEqual(gasToken, zeroAddress) ||
    !isAddressEqual(refundReceiver, zeroAddress)
  ) {
    throw new Error("The executed project handle call has invalid Safe semantics.");
  }

  const mainnetClient = clientFor(PROJECT_HANDLES_CHAIN_ID);
  if (!handlesTarget) {
    let decoded: ReturnType<typeof decodeFunctionData>;
    try {
      decoded = decodeFunctionData({ abi: ensTextResolverAbi, data: innerData });
    } catch {
      throw new Error("The executed ENS record update is malformed.");
    }
    if (decoded.functionName !== "setText") return;
    const [node, key, recordValue] = decoded.args as readonly [Hex, string, string];
    if (key !== PROJECT_HANDLE_TEXT_KEY) return;
    const parsed = parseProjectHandleRecord(recordValue);
    if (!parsed) throw new Error("The executed ENS Juicebox record is malformed.");
    const targetChainId = await assertSafeControlsProjectTuple(
      parsed.chainId,
      parsed.projectId,
      safe,
    );
    if (targetChainId !== PROJECT_HANDLES_CHAIN_ID) {
      const identities = await readMatchingAuthorityIdentities({
        sourceClient: clientFor(targetChainId),
        destinationClient: mainnetClient,
        authority: safe,
      });
      if (!identities?.matches) {
        throw new Error(
          "The project and Ethereum Safe policies changed after Relayr execution.",
        );
      }
    }
    const resolver = await mainnetClient.readContract({
      address: ENS_REGISTRY_ADDRESS,
      abi: ensRegistryAbi,
      functionName: "resolver",
      args: [node],
    });
    const text = isAddressEqual(resolver, target)
      ? await readDirectEnsText(mainnetClient, resolver, node)
      : null;
    if (text !== recordValue) {
      throw new Error(
        `The executed ENS resolver does not return ${PROJECT_HANDLE_TEXT_KEY}=${recordValue}. Keep the paid bundle pending.`,
      );
    }
    return;
  }

  if (selector !== SET_PROJECT_HANDLE_SELECTOR.toLowerCase()) {
    throw new Error("The executed JBProjectHandles call is not recognized.");
  }
  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({ abi: jbProjectHandlesAbi, data: innerData });
  } catch {
    throw new Error("The executed JBProjectHandles call is malformed.");
  }
  if (decoded.functionName !== "setEnsNamePartsFor") {
    throw new Error("The executed JBProjectHandles call is not recognized.");
  }
  const [rawChainId, rawProjectId, parts] = decoded.args as readonly [
    bigint,
    bigint,
    readonly string[],
  ];
  if (
    rawChainId > BigInt(Number.MAX_SAFE_INTEGER) ||
    rawProjectId > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("The executed handle claim targets an unsupported project.");
  }
  const chainId = Number(rawChainId);
  const projectId = Number(rawProjectId);
  const normalized = normalizeProjectHandle([...parts].reverse().join("."));
  if (
    !normalized ||
    normalized.parts.length !== parts.length ||
    normalized.parts.some((part, index) => part !== parts[index])
  ) {
    throw new Error("The executed project handle labels are not canonical.");
  }
  const targetChainId = await assertSafeControlsProjectTuple(
    chainId,
    projectId,
    safe,
  );
  if (targetChainId !== PROJECT_HANDLES_CHAIN_ID) {
    const identities = await readMatchingAuthorityIdentities({
      sourceClient: clientFor(targetChainId),
      destinationClient: mainnetClient,
      authority: safe,
    });
    if (!identities?.matches) {
      throw new Error(
        "The project and Ethereum Safe policies changed after Relayr execution.",
      );
    }
  }
  const [record, verifiedHandle] = await Promise.all([
    readDirectEnsProjectRecord(mainnetClient, normalized.ensName),
    readBoundedProjectHandle(mainnetClient, {
      chainId,
      projectId,
      setter: safe,
    }),
  ]);
  if (
    record.textRecord !== projectHandleRecord(chainId, projectId) ||
    verifiedHandle !== normalized.handle
  ) {
    throw new Error(
      "The executed JBProjectHandles claim is not verified by the live ENS record. Keep the paid bundle pending.",
    );
  }
}

export async function assertSafeProjectAuthority(
  chain: SafeQueueChain,
  safe: Address,
): Promise<void> {
  const client = clientFor(chain.chainId);
  const projects = jbContractAddress["6"][JBCoreContracts.JBProjects][
    chain.chainId
  ] as Address;
  const owner = await client.readContract({
    address: projects,
    abi: jbProjectsAbi,
    functionName: "ownerOf",
    args: [BigInt(chain.projectId)],
  });
  if (!chain.isRevnet) {
    if (!isAddressEqual(owner, safe)) {
      throw new Error(`This Safe is no longer the project owner on ${chain.name}.`);
    }
    return;
  }
  const revOwner = jbContractAddress["6"][RevnetCoreContracts.REVOwner][
    chain.chainId
  ] as Address;
  if (!isAddressEqual(owner, revOwner)) {
    throw new Error(`This project is no longer controlled as a revnet on ${chain.name}.`);
  }
  const isOperator = await client.readContract({
    address: revOwner,
    abi: revOwnerAbi,
    functionName: "isOperatorOf",
    args: [BigInt(chain.projectId), safe],
  });
  if (!isOperator) {
    throw new Error(`This Safe is no longer the revnet operator on ${chain.name}.`);
  }
}

async function freshCanonicalQueuedTx(
  chain: SafeQueueChain,
  safe: Address,
  tx: SafeQueuedTx,
): Promise<SafeQueuedTx> {
  if (!chain.handleOnly) await assertSafeProjectAuthority(chain, safe);
  const expectedHash = canonicalSafeTxHash(chain.chainId, safe, tx);
  const pending = await listPendingSafeTxs(chain.chainId, safe);
  const fresh = pending.find((candidate) => {
    try {
      return (
        canonicalSafeTxHash(chain.chainId, safe, candidate).toLowerCase() ===
        expectedHash.toLowerCase()
      );
    } catch {
      return false;
    }
  });
  if (!fresh) {
    throw new Error(
      `Safe transaction #${tx.nonce} changed or is no longer pending on ${chain.name}.`,
    );
  }
  const isHandleTransaction = await assertQueuedProjectHandleContext(
    chain.chainId,
    safe,
    fresh,
    chain.handleTuples,
  );
  if (chain.handleOnly && !isHandleTransaction) {
    throw new Error("This Ethereum queue row only permits project handle calls.");
  }
  return fresh;
}

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
  [routerGatewayAbi, "processPendingCallWithGas", "Retry retained router call with gas"],
  [routerGatewayAbi, "finalizePendingCall", "Finalize retained router call"],
  [routerGatewayAbi, "finalizePendingCallWithGas", "Finalize retained router call with gas"],
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
  const rolloutName = rolloutContractName(chainId, address)
  if (rolloutName) return rolloutName
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

function callLabel(chainId: JBChainId, to: Address, data: Hex | null | undefined): string {
  const selector = data?.slice(0, 10) ?? "0x";
  const action = SELECTOR_LABELS.get(selector);
  const target = contractName(chainId, to) ?? truncateAddress(to);
  return action ? `${action} | ${target}` : `${selector} | ${target}`;
}

/** The labelled inner calls of a queued operator batch, or null for any other row. */
export function batchCallLabels(chainId: JBChainId, tx: SafeQueuedTx): string[] | null {
  if (Number(tx.operation ?? 0) !== 1 || !isAddressEqual(tx.to, MULTI_SEND_CALL_ONLY)) return null;
  const calls = decodeMultiSend(tx.data);
  return calls ? calls.map(call => callLabel(chainId, call.to, call.data)) : null;
}

/** The queue row's label: a known action and target, or a decoded operator batch. */
export function transactionLabel(chainId: JBChainId, tx: SafeQueuedTx): string {
  const batch = batchCallLabels(chainId, tx);
  if (batch) return `Batch (${batch.length} call${batch.length === 1 ? "" : "s"}) | MultiSendCallOnly`;
  return callLabel(chainId, tx.to, tx.data);
}

function executionPlan(
  currentNonce: number | null,
  transactions: SafeQueuedTx[],
  /**
   * The Safe's on-chain threshold, for transactions the service returned
   * without a `confirmationsRequired`. Each selected transaction is also
   * rechecked against the live policy immediately before execution.
   */
  threshold: number | undefined,
): {
  direct: Set<SafeQueuedTx>;
  batch: SafeQueuedTx[];
  alternatives: Set<SafeQueuedTx>;
} {
  const direct = new Set<SafeQueuedTx>();
  const alternatives = new Set<SafeQueuedTx>();
  const batch: SafeQueuedTx[] = [];
  if (currentNonce === null) return { direct, batch, alternatives };

  const byNonce = new Map<number, SafeQueuedTx[]>();
  for (const transaction of transactions) {
    const nonce = Number(transaction.nonce);
    byNonce.set(nonce, [...(byNonce.get(nonce) ?? []), transaction]);
  }
  for (const transaction of byNonce.get(currentNonce) ?? [])
    direct.add(transaction);
  for (const rows of byNonce.values()) {
    if (rows.length > 1) rows.forEach((row) => alternatives.add(row));
  }

  let next = currentNonce;
  for (;;) {
    const rows = byNonce.get(next) ?? [];
    if (rows.length !== 1) break;
    const transaction = rows[0];
    const required = transaction.confirmationsRequired ?? threshold ?? 1;
    if (safeUsableConfirmationCount(transaction) < required) break;
    batch.push(transaction);
    next += 1;
  }
  return { direct, batch, alternatives };
}

export function SafeQueueCard({
  safe,
  chains,
  authorityLabel,
}: {
  safe: Address;
  chains: SafeQueueChain[];
  authorityLabel: "Project owner" | "Revnet operator";
}) {
  const { address } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [batchReview, setBatchReview] = useState<BatchReview | null>(null);
  const [paymentIndex, setPaymentIndex] = useState(-1);
  // Execute all runs in one dialog; each chain row carries its own status.
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchRows, setBatchRows] = useState<BatchDialogRow[]>([]);
  const [batchStatus, setBatchStatus] = useState<Record<number, string>>({});
  const [batchDone, setBatchDone] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // The queue loads once the card is on screen, then refreshes on focus and
  // after actions rather than on a timer.
  const sectionRef = useRef<HTMLElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const node = sectionRef.current;
    if (!node || onScreen) return;
    if (typeof IntersectionObserver === "undefined") {
      setOnScreen(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setOnScreen(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [onScreen]);
  const pendingScope = useMemo(
    () => `safe-queue:${safe.toLowerCase()}`,
    [safe],
  );
  const [pendingSession, setPendingSession] =
    useState<RelayrPendingSession | null>(null);
  const resumedScopeRef = useRef<string | null>(null);

  const query = useQuery({
    queryKey: [
      "safeQueues",
      safe,
      chains
        .map(
          (chain) =>
            `${chain.chainId}:${chain.projectId}:${chain.isRevnet ? "revnet" : "owner"}:${chain.handleOnly ? "handles" : "project"}:${chain.handleTuples.map(tuple => `${tuple.chainId}:${tuple.projectId}`).join("|")}`,
        )
        .join(","),
    ],
    // Each refresh re-reads every chain's Safe identity (~15 RPC calls per
    // chain) through one rate-limited JB Center host, so there is no timer:
    // load when on screen, refresh on focus (never mid-action) and after
    // actions. Actions re-verify live state themselves.
    enabled: onScreen,
    staleTime: 60_000,
    refetchOnWindowFocus: !busy,
    queryFn: async (): Promise<ChainQueue[]> =>
      Promise.all(
        chains.map(async (chain) => {
          try {
            if (!chain.handleOnly) await assertSafeProjectAuthority(chain, safe);
            const info = await fetchSafeInfo(chain.chainId, safe);
            if (!info) {
              return {
                ...chain,
                info: null,
                currentNonce: null,
                transactions: [],
                error: "Safe is not deployed on this chain.",
              };
            }
            if (!hasSafeService(chain.chainId)) {
              return {
                ...chain,
                info,
                currentNonce: await getSafeNextNonce(chain.chainId, safe),
                transactions: [],
                error: null,
              };
            }
            const [currentNonce, transactions] = await Promise.all([
              getSafeNextNonce(chain.chainId, safe),
              listPendingSafeTxs(chain.chainId, safe),
            ]);
            const canonicalTransactions = transactions.filter((transaction) => {
              try {
                canonicalSafeTxHash(chain.chainId, safe, transaction);
                return true;
              } catch {
                return false;
              }
            });
            const visibleTransactions: SafeQueuedTx[] = [];
            for (const transaction of canonicalTransactions) {
              if (!chain.handleOnly) {
                visibleTransactions.push(transaction);
                continue;
              }
              try {
                if (
                  await assertQueuedProjectHandleContext(
                    chain.chainId,
                    safe,
                    transaction,
                    chain.handleTuples,
                  )
                ) {
                  visibleTransactions.push(transaction);
                }
              } catch {
                // A stale or malformed handle proposal stays hidden and can
                // only be managed in the Safe app; it is never actionable here.
              }
            }
            return {
              ...chain,
              info,
              currentNonce,
              transactions: visibleTransactions,
              error: null,
            };
          } catch (queueError) {
            return {
              ...chain,
              info: null,
              currentNonce: null,
              transactions: [],
              error:
                queueError instanceof Error
                  ? queueError.message
                  : "Could not load the Safe queue.",
            };
          }
        }),
      ),
  });

  const ready = useMemo<ReadyTx[]>(() => {
    const rows: ReadyTx[] = [];
    for (const chain of query.data ?? []) {
      const plan = executionPlan(
        chain.currentNonce,
        chain.transactions,
        chain.info?.threshold,
      );
      for (const transaction of plan.batch) rows.push({ chain, tx: transaction });
    }
    return rows;
  }, [query.data]);
  // Relayr runs one transaction per chain: each chain's current nonce.
  const relayrRows = useMemo(
    () =>
      ready.filter(
        (row, index, rows) =>
          rows.findIndex(
            (candidate) => candidate.chain.chainId === row.chain.chainId,
          ) === index,
      ),
    [ready],
  );
  const relayrBatch = useMemo(() => {
    const destinations = [...new Set(ready.map((row) => row.chain.chainId))];
    return destinations.length > 1 && relayrSupportsChains(destinations);
  }, [ready]);
  const readyBatchCount = relayrBatch
    ? new Set(ready.map((row) => row.chain.chainId)).size
    : ready.length;
  const refetchQueues = query.refetch;

  const verifyReadyTx = async (row: ReadyTx): Promise<VerifiedReadyTx> => {
    const fresh = await freshCanonicalQueuedTx(row.chain, safe, row.tx);
    // simulateSafeExecution reverifies before and after simulating; the
    // "before" call would repeat the check just above, so it is skipped.
    let checked = true;
    const reverifyAuthority = async () => {
      if (checked) {
        checked = false;
        return;
      }
      await freshCanonicalQueuedTx(row.chain, safe, fresh);
    };
    const snapshot = await simulateSafeExecution(
      row.chain.chainId,
      safe,
      fresh,
      reverifyAuthority,
    );
    return { chain: row.chain, tx: snapshot.tx, snapshot };
  };

  const assertFrozenBatchRow = (
    frozen: VerifiedReadyTx,
    current: VerifiedReadyTx,
    entry: RelayrEntry,
  ) => {
    const nextEntry = safeExecRelayrEntry(
      current.chain.chainId,
      safe,
      current.snapshot.tx,
    );
    if (
      frozen.snapshot.safeTxHash.toLowerCase() !==
        current.snapshot.safeTxHash.toLowerCase() ||
      frozen.snapshot.policyFingerprint !== current.snapshot.policyFingerprint ||
      entry.chain !== nextEntry.chain ||
      entry.target.toLowerCase() !== nextEntry.target.toLowerCase() ||
      entry.value !== nextEntry.value ||
      entry.data.toLowerCase() !== nextEntry.data.toLowerCase()
    ) {
      throw new Error(
        `Safe transaction #${frozen.tx.nonce} or its live policy changed. Review the batch again.`,
      );
    }
  };

  const markBatchExecuted = useCallback((chainIds: readonly number[]) => {
    setBatchStatus(Object.fromEntries(chainIds.map((chainId) => [chainId, "Executed"])));
    setBatchDone(true);
  }, []);

  const recoverPaidBundle = useCallback(
    async (session: RelayrPendingSession) => {
      setBusy("recover-bundle");
      setError(null);
      setNotice(
        "Checking the existing Relayr bundle and its execution outcomes.",
      );
      try {
        const records = await relayrPoll(
          session.bundleUuid,
          session.expectedCount,
          (nextRecords) => {
            const updated = saveRelayrPendingSession(pendingScope, {
              ...session,
              records: nextRecords,
            });
            setPendingSession(updated);
            const progress = relayrProgress(nextRecords, session.expectedCount);
            setNotice(
              `Checking the paid bundle… ${progress.confirmed}/${progress.total} landed`,
            );
          },
          2_500,
          5 * 60_000,
        );
        if (!session.expectedEntries || !session.expectedSafeExecutions) {
          throw new Error(
            "This older paid bundle has no immutable execution proof. Keep it pending and verify each destination transaction manually.",
          );
        }
        await verifyRelayrSafeBatchLanding(
          safe,
          records,
          session.expectedEntries,
          session.expectedSafeExecutions,
        );
        clearRelayrPendingSession(pendingScope);
        setPendingSession(null);
        markBatchExecuted(session.chainIds);
        setNotice(
          `Executed ${session.itemCount} Safe transaction${session.itemCount === 1 ? "" : "s"}.`,
        );
        await refetchQueues();
      } catch (recoveryError) {
        // Keep the paid bundle and its per-chain terminal states visible.
        // A failed/partial destination is not permission to forget the payment
        // or invite a duplicate execution attempt.
        setError(
          recoveryError instanceof Error
            ? recoveryError.message
            : "Could not check the paid Relayr bundle.",
        );
      } finally {
        setBusy(null);
      }
    },
    [markBatchExecuted, pendingScope, refetchQueues, safe],
  );

  useEffect(() => {
    if (resumedScopeRef.current === pendingScope) return;
    resumedScopeRef.current = pendingScope;
    const session = loadRelayrPendingSession(pendingScope);
    setPendingSession(session);
    if (session) void recoverPaidBundle(session);
  }, [pendingScope, recoverPaidBundle]);

  const sign = async (chain: ChainQueue, tx: SafeQueuedTx) => {
    if (!address) return;
    const key = `sign:${chain.chainId}:${tx.nonce}`;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const fresh = await freshCanonicalQueuedTx(chain, safe, tx);
      const reverifyAuthority = async () => {
        await freshCanonicalQueuedTx(chain, safe, fresh);
      };
      await confirmSafeTx(
        chain.chainId,
        safe,
        fresh,
        address,
        undefined,
        reverifyAuthority,
      );
      setNotice(`Signed transaction #${tx.nonce} on ${chain.name}.`);
      await refetchQueues();
    } catch (signError) {
      setError(
        signError instanceof Error ? signError.message : "Could not sign.",
      );
    } finally {
      setBusy(null);
    }
  };

  const execute = async (chain: ChainQueue, tx: SafeQueuedTx) => {
    const key = `execute:${chain.chainId}:${tx.nonce}`;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const fresh = await freshCanonicalQueuedTx(chain, safe, tx);
      const reverifyAuthority = async () => {
        await freshCanonicalQueuedTx(chain, safe, fresh);
      };
      const result = await executeSafeTx(
        chain.chainId,
        safe,
        fresh,
        reverifyAuthority,
      );
      if (result.status === "confirmed") {
        await assertRelayrProjectHandlePostcondition(
          chain.chainId,
          safe,
          safeExecRelayrEntry(chain.chainId, safe, fresh),
        );
      }
      setNotice(
        result.status === "confirmed"
          ? `Executed transaction #${tx.nonce} on ${chain.name}.`
          : `Execution submitted as ${result.hash}. Confirmation is still pending; do not submit it again.`,
      );
      await refetchQueues();
    } catch (executeError) {
      setError(
        executeError instanceof Error
          ? executeError.message
          : "Could not execute.",
      );
    } finally {
      setBusy(null);
    }
  };

  const reviewExecuteAll = async () => {
    if (!address || readyBatchCount < 2) return;
    // The pending session is keyed by Safe address alone, so a second batch's
    // payment would overwrite the stuck bundle's uuid and payment hash — the
    // only record of money already spent. Resolve it first.
    if (pendingSession) {
      setError(
        "A Relayr bundle from this Safe is still unresolved. Check its status above before starting another batch.",
      );
      return;
    }
    setBusy("quote-all");
    setError(null);
    setNotice(null);
    try {
      if (!relayrBatch) {
        const ordered = [...ready].sort(
          (a, b) => a.chain.chainId - b.chain.chainId || Number(a.tx.nonce) - Number(b.tx.nonce),
        );
        setBusy("execute-all-direct");
        for (let index = 0; index < ordered.length; index++) {
          const row = ordered[index];
          setNotice(
            `Executing ${index + 1}/${ordered.length} directly on ${row.chain.name}…`,
          );
          const fresh = await freshCanonicalQueuedTx(row.chain, safe, row.tx);
          const result = await executeSafeTx(
            row.chain.chainId,
            safe,
            fresh,
            async () => {
              await freshCanonicalQueuedTx(row.chain, safe, fresh);
            },
          );
          if (result.status !== "confirmed") {
            setNotice(
              `Execution ${result.hash} was submitted for transaction #${row.tx.nonce}. Confirmation is still pending, so later nonces were not submitted.`,
            );
            await refetchQueues();
            return;
          }
          await assertRelayrProjectHandlePostcondition(
            row.chain.chainId,
            safe,
            safeExecRelayrEntry(row.chain.chainId, safe, fresh),
          );
        }
        setNotice(
          `Executed ${ordered.length} Safe transactions directly.`,
        );
        await refetchQueues();
        return;
      }

      // Check 1 of 2: every chain's current transaction is re-fetched and
      // simulated before quoting. Later nonces need a new review after these
      // land. ponytail: one chain at a time — every RPC read goes through one
      // rate-limited JB Center host, and concurrent chains trip its 429s.
      setBatchRows(relayrRows.map(batchDialogRow));
      setBatchStatus({});
      setBatchDone(false);
      setBatchReview(null);
      setBatchOpen(true);
      const verifiedRows: VerifiedReadyTx[] = [];
      for (const row of relayrRows) {
        setBatchStatus((current) => ({ ...current, [row.chain.chainId]: "Checking…" }));
        try {
          verifiedRows.push(await verifyReadyTx(row));
        } catch (checkError) {
          setBatchStatus((current) => ({ ...current, [row.chain.chainId]: "Check failed" }));
          throw checkError;
        }
        setBatchStatus((current) => ({ ...current, [row.chain.chainId]: "Ready" }));
      }
      setNotice("Getting one Relayr quote for every chain…");
      const entries = verifiedRows.map((row) =>
        safeExecRelayrEntry(row.chain.chainId, safe, row.snapshot.tx),
      );
      const quote = await relayrPostBundle(entries);
      const payments = relayrPaymentOptions(quote, entries.map((entry) => entry.chain));
      setPaymentIndex(-1);
      setBatchReview({ quote, rows: verifiedRows, entries, payments });
      setNotice(null);
    } catch (batchError) {
      setError(
        batchError instanceof Error
          ? batchError.message
          : "Could not review the Safe transactions.",
      );
    } finally {
      setBusy(null);
    }
  };

  const confirmExecuteAll = () => withRelayrScopeLock(pendingScope, async () => {
    if (!address || !batchReview || pendingSession) return;
    const payment = batchReview.payments[paymentIndex];
    if (!payment) return;
    const quote = batchReview.quote;
    let paidSession: RelayrPendingSession | null = null;
    setBusy("execute-all");
    setError(null);
    setNotice(null);
    try {
      // Check 2 of 2, run by relayrPay right before the payment is sent.
      const reverifyBatch = async () => {
        for (let index = 0; index < batchReview.rows.length; index++) {
          const row = batchReview.rows[index];
          const entry = batchReview.entries[index];
          if (!entry) throw new Error("The reviewed Relayr bundle changed.");
          setBatchStatus((current) => ({ ...current, [row.chain.chainId]: "Re-checking…" }));
          try {
            assertFrozenBatchRow(row, await verifyReadyTx(row), entry);
          } catch (checkError) {
            setBatchStatus((current) => ({ ...current, [row.chain.chainId]: "Changed" }));
            throw checkError;
          }
          setBatchStatus((current) => ({ ...current, [row.chain.chainId]: "Ready" }));
        }
      };
      // A quote about to expire would be rejected at payment time anyway —
      // refresh it here so the flow re-reviews a live payment instead of
      // failing after the confirmations above.
      const numericPaymentDeadline = /^\d+$/u.test(String(payment.payment_deadline))
        ? Number(payment.payment_deadline)
        : Math.floor(Date.parse(String(payment.payment_deadline)) / 1_000);
      const deadlineSoon =
        Number.isSafeInteger(numericPaymentDeadline) &&
        numericPaymentDeadline <= Math.floor(Date.now() / 1000) + 60;
      if (deadlineSoon) {
        setNotice("The Relayr quote is about to expire — requesting a fresh one…");
        const refreshedQuote = await relayrPostBundle(batchReview.entries);
        const payments = relayrPaymentOptions(refreshedQuote, batchReview.entries.map((entry) => entry.chain));
        setBatchReview({ ...batchReview, quote: refreshedQuote, payments });
        setPaymentIndex(-1);
        setNotice("The quote was refreshed. Choose a funding chain and review the new payment.");
        return;
      }
      // The dialog lists every chain's exact call; relayrPay's own review
      // covers the payment the wallet signs.
      let submittedSession: RelayrPendingSession | null = null;
      const expectedTransactions = quote.expectedTransactions;
      if (
        !expectedTransactions ||
        expectedTransactions.length !== batchReview.rows.length
      ) {
        throw new Error("Relayr did not bind every reviewed Safe transaction.");
      }
      const expectedEntries = expectedTransactions.map(
        (transaction) => transaction.entry,
      );
      const expectedSafeExecutions: RelayrSafeExecutionProof[] =
        batchReview.rows.map((row, index) => ({
          chainId: row.chain.chainId,
          safe,
          nonce: row.snapshot.tx.nonce,
          safeTxHash: row.snapshot.safeTxHash,
          txUuid: expectedTransactions[index].txUuid,
        }));
      const paymentHash = await relayrPay(
        payment,
        address,
        quote.bundle_uuid,
        batchReview.entries.map((entry) => entry.chain),
        (hash) => {
          submittedSession = saveRelayrPendingSession(pendingScope, {
            bundleUuid: quote.bundle_uuid,
            paymentHash: hash,
            paymentChainId: payment.chain,
            paymentStatus: "submitted",
            chainIds: batchReview.rows.map((row) => row.chain.chainId),
            expectedCount: batchReview.rows.length,
            records: quote.transactions ?? [],
            itemCount: batchReview.rows.length,
            account: address,
            createdAt: Date.now(),
            expectedEntries,
            expectedSafeExecutions,
          });
          paidSession = submittedSession;
          setPendingSession(submittedSession);
          setNotice(
            `Relayr payment submitted (${hash.slice(0, 10)}…). Waiting for confirmation; do not pay again.`,
          );
        },
        reverifyBatch,
        () => {
          const existingSession = loadRelayrPendingSession(pendingScope);
          if (existingSession) {
            setPendingSession(existingSession);
            throw new Error("This Safe already has an unresolved Relayr bundle. Check its status before paying again.");
          }
          submittedSession = saveRelayrPendingSessionDurably(pendingScope, {
            bundleUuid: quote.bundle_uuid,
            paymentHash: null,
            paymentChainId: payment.chain,
            paymentStatus: "sending",
            chainIds: batchReview.rows.map((row) => row.chain.chainId),
            expectedCount: batchReview.rows.length,
            records: quote.transactions ?? [],
            itemCount: batchReview.rows.length,
            account: address,
            createdAt: Date.now(),
            expectedEntries,
            expectedSafeExecutions,
          });
          if (
            submittedSession.expectedEntries?.length !== batchReview.rows.length ||
            submittedSession.expectedSafeExecutions?.length !== batchReview.rows.length
          ) {
            throw new Error("Could not save every exact Safe execution proof. No payment was sent.");
          }
          paidSession = submittedSession;
          setPendingSession(submittedSession);
        },
        true,
      );
      const initialSession = saveRelayrPendingSession(pendingScope, {
        ...(submittedSession ?? {
          bundleUuid: quote.bundle_uuid,
          paymentHash,
          paymentChainId: payment.chain,
          chainIds: batchReview.rows.map((row) => row.chain.chainId),
          expectedCount: batchReview.rows.length,
          records: quote.transactions ?? [],
          itemCount: batchReview.rows.length,
          account: address,
          createdAt: Date.now(),
          expectedEntries,
          expectedSafeExecutions,
        }),
        paymentStatus: "confirmed",
      });
      paidSession = initialSession;
      setPendingSession(initialSession);
      const records = await relayrPoll(
        quote.bundle_uuid,
        batchReview.rows.length,
        (nextRecords) => {
          const updated = saveRelayrPendingSession(pendingScope, {
            ...initialSession,
            records: nextRecords,
          });
          setPendingSession(updated);
          const progress = relayrProgress(nextRecords, batchReview.rows.length);
          setNotice(
            `Executing through Relayr… ${progress.confirmed}/${progress.total} landed`,
          );
        },
        2_500,
        5 * 60_000,
      );
      await verifyRelayrSafeBatchLanding(
        safe,
        records,
        initialSession.expectedEntries ?? [],
        initialSession.expectedSafeExecutions ?? [],
      );
      clearRelayrPendingSession(pendingScope);
      setPendingSession(null);
      markBatchExecuted(batchReview.rows.map((row) => row.chain.chainId));
      setNotice(`Executed ${batchReview.rows.length} Safe transactions.`);
      await refetchQueues();
    } catch (batchError) {
      // Only an explicit wallet rejection before a hash was returned proves
      // the payment was never submitted. Keep ambiguous and partial outcomes.
      if (
        paidSession?.paymentStatus === "sending" &&
        paidSession &&
        relayrErrorIsDefiniteNoSubmission(batchError)
      ) {
        clearRelayrPendingSession(pendingScope);
        setPendingSession(null);
      }
      setError(
        batchError instanceof Error
          ? batchError.message
          : "Could not execute the Safe transactions.",
      );
    } finally {
      setBusy(null);
    }
  }).catch((lockError: unknown) => {
    setError(lockError instanceof Error ? lockError.message : "This Safe has another Relayr payment in progress.");
  });

  const openPaidBundle = () => {
    if (!pendingSession) return;
    if (!batchRows.length) {
      setBatchRows(
        pendingSession.chainIds.map((chainId, index) => {
          const nonce = pendingSession.expectedSafeExecutions?.[index]?.nonce ?? null;
          return {
            chainId,
            nonce,
            label: nonce === null ? "Safe transaction" : `Safe transaction #${nonce}`,
            calls: null,
          };
        }),
      );
    }
    setConfirmClear(false);
    setBatchOpen(true);
  };

  const closeExecuteAll = () => {
    setBatchOpen(false);
    setConfirmClear(false);
    if (pendingSession) return;
    setBatchReview(null);
    setBatchRows([]);
    setBatchStatus({});
    setBatchDone(false);
    setNotice(null);
    setError(null);
  };

  const clearPaidReceipt = () => {
    clearRelayrPendingSession(pendingScope);
    setPendingSession(null);
    setConfirmClear(false);
    closeExecuteAll();
    void refetchQueues();
  };

  // A paid bundle's rows follow Relayr's per-chain records, matched by chain
  // within the IDs this bundle quoted.
  const paidRecord = (chainId: number) => {
    if (!pendingSession) return undefined;
    const quotedIds = new Set(
      (pendingSession.expectedSafeExecutions ?? []).map((proof) =>
        proof.txUuid.toLowerCase(),
      ),
    );
    const matches = pendingSession.records.filter(
      (record) =>
        relayrRecordChain(record) === chainId &&
        quotedIds.has(String(record.tx_uuid ?? "").toLowerCase()),
    );
    return matches.length === 1 ? matches[0] : undefined;
  };

  const rowStatus = (chainId: number): string => {
    if (!pendingSession || batchDone) return batchStatus[chainId] ?? "Waiting";
    const state = paidRecord(chainId)?.status?.state;
    if (relayrStateIsSuccess(state)) return "Landed | verifying";
    if (relayrStateIsFailed(state)) return "Failed";
    return pendingSession.paymentStatus === "confirmed"
      ? "Executing…"
      : "Waiting for payment";
  };

  const payment = batchReview?.payments[paymentIndex];
  const executeAllDialog = (
    <ModalShell
      title={`Execute ${batchRows.length} Safe transactions`}
      subtitle="One Relayr payment runs each chain's next confirmed transaction. Later nonces need a new review after these land."
      busy={busy === "execute-all"}
      onClose={closeExecuteAll}
      footer={
        batchDone ? (
          <div className="flex justify-end">
            <button type="button" onClick={closeExecuteAll} className="btn-primary min-h-[42px] px-5 text-sm">
              Done
            </button>
          </div>
        ) : pendingSession ? (
          confirmClear ? (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-smoke-700">
                Clear only after checking every chain yourself. Clearing forgets
                this receipt; it never refunds, and paying again can pay twice.
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={() => setConfirmClear(false)} className="btn-secondary min-h-[42px] px-4 text-sm">
                  Keep receipt
                </button>
                <button type="button" onClick={clearPaidReceipt} className="btn-primary min-h-[42px] px-4 text-sm">
                  Clear saved receipt
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                disabled={busy !== null}
                className="text-xs font-medium text-smoke-700 hover:text-ink disabled:opacity-50"
              >
                Clear saved receipt
              </button>
              <button
                type="button"
                onClick={() => void recoverPaidBundle(pendingSession)}
                disabled={busy !== null}
                className="btn-primary min-h-[42px] px-5 text-sm"
              >
                {busy === "recover-bundle" || busy === "execute-all"
                  ? "Checking…"
                  : "Check status"}
              </button>
            </div>
          )
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              {payment ? (
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
                  <ChainIcon chainId={payment.chain as JBChainId} size={16} />
                </span>
              ) : null}
              <select
                aria-label="Pay Relayr on"
                value={paymentIndex}
                onChange={(event) => setPaymentIndex(Number(event.target.value))}
                disabled={!!busy || !batchReview}
                className={`select-caret min-h-[42px] w-full truncate rounded-lg border border-smoke-300 bg-white py-2 pr-9 text-sm text-ink disabled:opacity-60 ${
                  payment ? "pl-9" : "pl-3"
                }`}
              >
                <option value={-1} disabled>
                  {batchReview ? "Pay Relayr on…" : "Getting a quote…"}
                </option>
                {batchReview?.payments.map((option, index) => (
                  <option key={`${option.chain}:${option.amount}:${index}`} value={index}>
                    {relayrPaymentLabel(option)}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={confirmExecuteAll}
              disabled={!!busy || !payment}
              className="btn-primary min-h-[42px] shrink-0 px-5 text-sm"
            >
              {busy === "execute-all"
                ? "Executing…"
                : busy === "quote-all"
                  ? "Checking…"
                  : `Pay once and execute ${batchRows.length}`}
            </button>
          </div>
        )
      }
    >
      <ul className="divide-y divide-smoke-200 rounded-lg border border-smoke-200">
        {batchRows.map((row) => {
          const status = rowStatus(row.chainId);
          const record = paidRecord(row.chainId);
          const hash = record ? relayrDestinationHash(record) : null;
          const failed = status === "Failed" || status === "Check failed" || status === "Changed";
          return (
            <li key={row.chainId} className="px-3 py-2.5 text-sm">
              <div className="flex items-center gap-2">
                <ChainIcon chainId={row.chainId as JBChainId} size={16} />
                <span className="font-medium text-ink">{chainName(row.chainId)}</span>
                {row.nonce !== null ? (
                  <span className="font-mono text-xs text-smoke-500">#{row.nonce}</span>
                ) : null}
                <span className="ml-auto shrink-0 text-xs">
                  {hash && explorerTxUrl(row.chainId, hash) ? (
                    <a
                      href={explorerTxUrl(row.chainId, hash)!}
                      target="_blank"
                      rel="noreferrer"
                      className={failed ? "text-error-600 underline" : "text-bluebs-600 underline"}
                    >
                      {status}
                    </a>
                  ) : (
                    <span className={failed ? "text-error-600" : status === "Executed" ? "text-ink" : "text-smoke-600"}>
                      {status}
                    </span>
                  )}
                </span>
              </div>
              <p className="mt-0.5 truncate pl-6 text-xs text-smoke-700">{row.label}</p>
              {row.calls?.length ? (
                <ol className="mt-1 list-decimal pl-10 text-xs text-smoke-700">
                  {row.calls.map((label, index) => (
                    <li key={index}>{label}</li>
                  ))}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ul>
      {pendingSession?.paymentHash &&
      pendingSession.paymentChainId &&
      explorerTxUrl(pendingSession.paymentChainId, pendingSession.paymentHash) ? (
        <a
          href={explorerTxUrl(pendingSession.paymentChainId, pendingSession.paymentHash)!}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex text-xs text-bluebs-600 underline"
        >
          Relayr payment on {chainName(pendingSession.paymentChainId)} ↗
        </a>
      ) : null}
      {notice ? <p className="mt-3 text-sm text-smoke-700">{notice}</p> : null}
      <TxError error={error} />
    </ModalShell>
  );

  // Opened as a Safe App, the connected account is a Safe, not an owner: it
  // cannot sign for itself, and executing or paying Relayr from it would
  // take the very nonce the queued transaction needs. Safe{Wallet}'s own
  // queue is where its owners sign and execute.
  const viaSafeApp = isSafeConnection(wagmiConfig);

  return (
    <section ref={sectionRef} className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="field-label">Pending multisig transactions</span>
          <p className="mt-2 text-sm leading-relaxed text-smoke-700">
            {authorityLabel}-only actions are proposed per chain. Safe signers
            can inspect, co-sign, and execute them here.
          </p>
          {viaSafeApp ? (
            <p className="mt-2 text-sm leading-relaxed text-smoke-700">
              You are connected as a Safe. Its owners sign and execute these
              in Safe&#123;Wallet&#125;: use Open in Safe on each chain.
            </p>
          ) : null}
        </div>
        {pendingSession ? (
          <button
            type="button"
            onClick={openPaidBundle}
            className="btn-secondary min-h-[40px] px-4 text-sm"
          >
            {busy === "recover-bundle" ? "Checking paid bundle…" : "View paid bundle"}
          </button>
        ) : readyBatchCount >= 2 && !viaSafeApp ? (
          <button
            type="button"
            onClick={reviewExecuteAll}
            disabled={!!busy}
            className="btn-primary min-h-[40px] px-4 text-sm"
          >
            {busy === "quote-all"
              ? "Checking…"
              : busy === "execute-all-direct"
                ? "Executing directly…"
                : `Execute ${readyBatchCount} ready`}
          </button>
        ) : null}
      </div>

      {batchOpen ? executeAllDialog : null}

      {query.isPending ? (
        <SafeQueueSkeleton groups={chains.length} />
      ) : (
        <div className="mt-4 space-y-5">
          {(query.data ?? []).map((chain) => {
            const isSigner =
              !!address &&
              !!chain.info?.owners.some(
                (owner) => owner.toLowerCase() === address.toLowerCase(),
              );
            const plan = executionPlan(
              chain.currentNonce,
              chain.transactions,
              chain.info?.threshold,
            );
            const queueUrl = safeQueueLink(chain.chainId, safe);
            return (
              <div
                key={chain.chainId}
                className="rounded-xl border border-smoke-200"
              >
                <div className="flex items-center justify-between gap-3 border-b border-smoke-200 px-4 py-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-ink">
                    <ChainIcon chainId={chain.chainId} size={20} />
                    {chain.name}
                    {chain.currentNonce !== null ? (
                      <span className="font-mono text-xs font-normal text-smoke-500">
                        nonce {chain.currentNonce}
                      </span>
                    ) : null}
                  </div>
                  {queueUrl ? (
                    <a
                      href={queueUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-bluebs-600 hover:underline"
                    >
                      Open in Safe ↗
                    </a>
                  ) : null}
                </div>

                {!chain.info ? (
                  <p className="px-4 py-4 text-sm text-smoke-500">
                    Safe is not deployed on {chain.name}.
                  </p>
                ) : !hasSafeService(chain.chainId) ? (
                  <p className="px-4 py-4 text-sm leading-relaxed text-smoke-700">
                    No hosted Safe queue is available on this chain. Each signer
                    can reopen the same action to approve its exact hash
                    onchain; the app executes it automatically when the Safe’s
                    threshold is met.
                  </p>
                ) : chain.error ? (
                  <p className="px-4 py-4 text-sm text-red-700">
                    {chain.error}
                  </p>
                ) : chain.transactions.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-smoke-500">
                    No pending transactions.
                  </p>
                ) : (
                  <ul className="divide-y divide-smoke-100">
                    {chain.transactions.map((tx) => {
                      const count = safeUsableConfirmationCount(tx);
                      const required =
                        tx.confirmationsRequired ?? chain.info?.threshold ?? 1;
                      const signed = tx.confirmations?.some(
                        (confirmation) =>
                          !!address &&
                          confirmation.owner.toLowerCase() ===
                            address.toLowerCase(),
                      );
                      const readyToExecute = count >= required;
                      const confirmedOwners = new Set(
                        (tx.confirmations ?? []).map((confirmation) =>
                          confirmation.owner.toLowerCase(),
                        ),
                      );
                      const missingOwners = (chain.info?.owners ?? []).filter(
                        (owner) => !confirmedOwners.has(owner.toLowerCase()),
                      );
                      const isCurrent = plan.direct.has(tx);
                      const alternative = plan.alternatives.has(tx);
                      const hash = tx.safeTxHash ?? tx.contractTransactionHash;
                      return (
                        <li
                          key={`${tx.nonce}:${hash ?? tx.data}`}
                          className="px-4 py-3.5"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <details className="min-w-0 flex-1">
                              <summary className="cursor-pointer list-none">
                                <p className="text-sm font-medium text-ink">
                                  #{tx.nonce} |{" "}
                                  {transactionLabel(chain.chainId, tx)}
                                </p>
                                <p className="mt-1 text-xs text-smoke-500">
                                  {count}/{required} signatures
                                  {readyToExecute ? " | ready" : ""}
                                  {alternative
                                    ? " | same-nonce alternative"
                                    : ""}
                                  {Number(tx.operation) === 1
                                    ? " | DELEGATECALL"
                                    : ""}
                                  {BigInt(tx.value ?? 0) > 0n
                                    ? ` | sends ${tx.value} wei`
                                    : ""}
                                </p>
                                {batchCallLabels(chain.chainId, tx)?.length ? (
                                  <ol className="mt-1 list-decimal pl-5 text-xs text-smoke-700">
                                    {batchCallLabels(chain.chainId, tx)!.map((label, index) => (
                                      <li key={index}>{label}</li>
                                    ))}
                                  </ol>
                                ) : null}
                                <p className="mt-1 text-xs text-smoke-500">
                                  Signed:{" "}
                                  {tx.confirmations?.length ? (
                                    <SignerList
                                      owners={tx.confirmations.map((item) => item.owner)}
                                      you={address}
                                    />
                                  ) : (
                                    "none"
                                  )}
                                </p>
                                {!readyToExecute && missingOwners.length ? (
                                  <p className="mt-1 text-xs text-smoke-500">
                                    Still needs {required - count} of:{" "}
                                    <SignerList owners={missingOwners} you={address} />
                                  </p>
                                ) : null}
                              </summary>
                              <div className="mt-3 rounded-lg bg-smoke-50 p-3 font-mono text-[11px] leading-relaxed text-smoke-700">
                                <p className="break-all">To: {tx.to}</p>
                                <p>
                                  Operation:{" "}
                                  {Number(tx.operation) === 1
                                    ? "DELEGATECALL"
                                    : "CALL"}
                                </p>
                                <p>Value: {tx.value ?? 0} wei</p>
                                <p className="mt-1 break-all">
                                  Data: {tx.data ?? "0x"}
                                </p>
                              </div>
                            </details>
                            <div className="flex shrink-0 flex-wrap items-center gap-2">
                              {isSigner && !signed && !readyToExecute ? (
                                <button
                                  type="button"
                                  onClick={() => sign(chain, tx)}
                                  disabled={!!busy}
                                  className="btn-secondary min-h-[36px] px-3 text-xs"
                                >
                                  {busy === `sign:${chain.chainId}:${tx.nonce}`
                                    ? "Signing…"
                                    : "Sign"}
                                </button>
                              ) : signed ? (
                                <span className="text-xs font-medium text-smoke-500">
                                  You signed
                                </span>
                              ) : null}
                              {readyToExecute && !viaSafeApp ? (
                                <button
                                  type="button"
                                  onClick={() => execute(chain, tx)}
                                  disabled={!!busy || !isCurrent}
                                  title={
                                    isCurrent
                                      ? alternative
                                        ? "Executing this replaces other proposals at the same nonce."
                                        : "Execute this Safe transaction."
                                      : `Nonce ${chain.currentNonce} must execute first.`
                                  }
                                  className="btn-primary min-h-[36px] px-3 text-xs"
                                >
                                  {busy ===
                                  `execute:${chain.chainId}:${tx.nonce}`
                                    ? "Executing…"
                                    : "Execute"}
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!batchOpen && notice ? <p className="mt-3 text-sm text-smoke-700">{notice}</p> : null}
      {!batchOpen ? <TxError error={error} /> : null}
    </section>
  );
}
