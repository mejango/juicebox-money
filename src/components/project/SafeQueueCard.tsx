"use client";

import { getAccount } from "@wagmi/core";
import {
  JB_CHAINS,
  JBCoreContracts,
  RevnetCoreContracts,
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
  relayrErrorIsUncertain,
  relayrDestinationHash,
  relayrPay,
  relayrPaymentLabel,
  relayrPoll,
  relayrPostBundle,
  relayrProgress,
  relayrRecordChain,
  relayrStateIsFailed,
  relayrStateIsSuccess,
  saveRelayrPendingSession,
  type RelayrEntry,
  type RelayrPayment,
  type RelayrPendingSession,
  type RelayrQuote,
  type RelayrSafeExecutionProof,
  type RelayrTransactionRecord,
} from "@/lib/relayr";
import {
  confirmSafeTx,
  canonicalSafeTxHash,
  executeSafeTx,
  fetchSafeInfo,
  getSafeNextNonce,
  hasSafeService,
  listPendingSafeTxs,
  safeExecRelayrEntry,
  safeExecArgs,
  safeExecSignatures,
  safeQueueLink,
  simulateSafeExecution,
  safeTxLink,
  safeUsableConfirmationCount,
  type SafeInfo,
  type SafeExecutionSnapshot,
  type SafeQueuedTx,
  SAFE_EXEC_ABI,
} from "@/lib/safe";
import { truncateAddress } from "@/lib/format";
import { requireTransactionReview } from "@/lib/transaction-review";
import { wagmiConfig } from "@/providers/Providers";
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
      txUuid !== proof.txUuid.toLowerCase() ||
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

function transactionLabel(chainId: JBChainId, tx: SafeQueuedTx): string {
  const selector = tx.data?.slice(0, 10) ?? "0x";
  const action = SELECTOR_LABELS.get(selector);
  const target = contractName(chainId, tx.to) ?? truncateAddress(tx.to);
  return action ? `${action} · ${target}` : `${selector} · ${target}`;
}

function executionPlan(
  currentNonce: number | null,
  transactions: SafeQueuedTx[],
  /**
   * The Safe's on-chain threshold, for transactions the service returned
   * without a `confirmationsRequired`. Only the FRONT transaction of a batch
   * is re-simulated before payment, so a later consecutive-nonce transaction
   * that falls back to 1 here gets no threshold check anywhere and rides
   * under-signed into a paid Relayr bundle.
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
  const [paymentIndex, setPaymentIndex] = useState(0);
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
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
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
  const readyBatchCount = useMemo(() => {
    const chains = new Set(ready.map((row) => row.chain.chainId));
    return chains.size === 1 ? ready.length : chains.size;
  }, [ready]);
  const refetchQueues = query.refetch;

  const verifyReadyTx = async (row: ReadyTx): Promise<VerifiedReadyTx> => {
    const fresh = await freshCanonicalQueuedTx(row.chain, safe, row.tx);
    const reverifyAuthority = async () => {
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

  const recoverPaidBundle = useCallback(
    async (session: RelayrPendingSession) => {
      setBusy("recover-bundle");
      setError(null);
      setNotice(
        "Checking an already-paid Relayr bundle. This will not re-sign, re-pay, or resubmit transactions.",
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
              `Checking paid Relayr bundle… ${progress.confirmed}/${progress.total}`,
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
        setNotice(
          `Executed ${session.itemCount} Safe transaction${session.itemCount === 1 ? "" : "s"}.`,
        );
        setBatchReview(null);
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
    [pendingScope, refetchQueues, safe],
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
      const readyChains = new Set(ready.map((row) => row.chain.chainId));
      if (readyChains.size === 1) {
        const ordered = [...ready].sort(
          (a, b) => Number(a.tx.nonce) - Number(b.tx.nonce),
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
          `Executed ${ordered.length} Safe transactions directly on ${ordered[0].chain.name}.`,
        );
        await refetchQueues();
        return;
      }

      const verifiedRows: VerifiedReadyTx[] = [];
      const relayrRows = ready.filter(
        (row, index, rows) =>
          rows.findIndex(
            (candidate) => candidate.chain.chainId === row.chain.chainId,
          ) === index,
      );
      for (let index = 0; index < relayrRows.length; index++) {
        const row = relayrRows[index];
        // A later consecutive nonce cannot simulate against today's Safe
        // nonce until the earlier transaction executes. Verify the front
        // transaction on each chain; Relayr's virtual nonces preserve the
        // reviewed order for the remainder.
        setNotice(
          `Checking ${index + 1}/${relayrRows.length} on ${row.chain.name}…`,
        );
        verifiedRows.push(await verifyReadyTx(row));
      }
      const entries = verifiedRows.map((row) =>
        safeExecRelayrEntry(row.chain.chainId, safe, row.snapshot.tx),
      );
      const quote = await relayrPostBundle(entries);
      const payments = [...(quote.payment_info ?? [])].sort((a, b) =>
        BigInt(a.amount) < BigInt(b.amount) ? -1 : 1,
      );
      if (!payments.length)
        throw new Error("Relayr returned no payment option.");
      const activeChain = getAccount(wagmiConfig).chainId;
      const preferred = Math.max(
        0,
        payments.findIndex((item) => item.chain === activeChain),
      );
      setPaymentIndex(preferred);
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

  const confirmExecuteAll = async () => {
    if (!address || !batchReview) return;
    let payment = batchReview.payments[paymentIndex];
    if (!payment) return;
    let quote = batchReview.quote;
    let paidSession: RelayrPendingSession | null = null;
    setBusy("execute-all");
    setError(null);
    setNotice(
      "Confirm one Relayr payment to execute every reviewed transaction.",
    );
    try {
      const reverifyBatch = async () => {
        for (let index = 0; index < batchReview.rows.length; index++) {
          const row = batchReview.rows[index];
          const entry = batchReview.entries[index];
          if (!entry) throw new Error("The reviewed Relayr bundle changed.");
          const current = await verifyReadyTx(row);
          assertFrozenBatchRow(row, current, entry);
        }
      };
      // The review may be minutes old, and a queued transaction executed or
      // replaced through the Safe app meanwhile consumes its nonce — which
      // would revert EVERY execTransaction in the bundle after Relayr is
      // paid. Re-verify the front transaction on each chain now, immediately
      // before payment; Relayr's virtual nonces preserve the order for the
      // remainder, exactly as at review time.
      for (let index = 0; index < batchReview.rows.length; index++) {
        const row = batchReview.rows[index];
        const entry = batchReview.entries[index];
        if (!entry) throw new Error("The reviewed Relayr bundle changed.");
        setNotice(`Re-checking transaction #${row.tx.nonce} on ${row.chain.name}…`);
        const current = await verifyReadyTx(row);
        assertFrozenBatchRow(row, current, entry);
      }
      // A quote about to expire would be rejected at payment time anyway —
      // refresh it here so the flow re-reviews a live payment instead of
      // failing after the confirmations above.
      const numericPaymentDeadline = Number(payment.payment_deadline);
      const deadlineSoon =
        Number.isSafeInteger(numericPaymentDeadline) &&
        numericPaymentDeadline <= Math.floor(Date.now() / 1000) + 60;
      if (deadlineSoon) {
        setNotice("The Relayr quote is about to expire — requesting a fresh one…");
        quote = await relayrPostBundle(batchReview.entries);
        const payments = [...(quote.payment_info ?? [])].sort((a, b) =>
          BigInt(a.amount) < BigInt(b.amount) ? -1 : 1,
        );
        if (!payments.length)
          throw new Error("Relayr returned no payment option.");
        payment =
          payments.find((item) => item.chain === payment.chain) ?? payments[0];
        setBatchReview({ ...batchReview, quote, payments });
        setPaymentIndex(payments.indexOf(payment));
      }
      await requireTransactionReview({
        kind: "authorization",
        title: "Review Safe execution bundle",
        description:
          "Paying Relayr will cause these exact Safe execTransaction calls to be submitted onchain. Review every chain and call before reviewing the separate payment transaction.",
        confirmLabel: "Agree & review payment",
        calls: batchReview.rows.map((row, index) => {
          const entry = batchReview.entries[index];
          if (!entry) throw new Error("The reviewed Relayr bundle changed.");
          const args = safeExecArgs(row.tx, safeExecSignatures(row.tx));
          return {
            chainId: entry.chain,
            to: entry.target,
            value: BigInt(entry.value),
            data: entry.data,
            abi: SAFE_EXEC_ABI,
            functionName: "execTransaction",
            args,
            label: `Execute Safe transaction #${row.tx.nonce}`,
            contractName: "Safe",
          };
        }),
      });
      // The review can remain open while project authority, Safe policy,
      // nonce, confirmations, or the hosted queue changes. Re-fetch and
      // re-simulate every exact entry immediately before paying Relayr.
      for (let index = 0; index < batchReview.rows.length; index++) {
        const row = batchReview.rows[index];
        const entry = batchReview.entries[index];
        if (!entry) throw new Error("The reviewed Relayr bundle changed.");
        const current = await verifyReadyTx(row);
        assertFrozenBatchRow(row, current, entry);
      }
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
            `Executing through Relayr… ${progress.confirmed}/${progress.total}`,
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
      setNotice(`Executed ${batchReview.rows.length} Safe transactions.`);
      setBatchReview(null);
      await refetchQueues();
    } catch (batchError) {
      // Clear only a payment which failed before confirmation (for example an
      // explicit onchain revert). Once payment is confirmed, keep every
      // destination result recoverable even when Relayr reports failures.
      if (
        paidSession?.paymentStatus !== "confirmed" &&
        paidSession &&
        !relayrErrorIsUncertain(batchError)
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
  };

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="field-label">Pending multisig transactions</span>
          <p className="mt-2 text-sm leading-relaxed text-smoke-700">
            {authorityLabel}-only actions are proposed per chain. Safe signers
            can inspect, co-sign, and execute them here.
          </p>
        </div>
        {readyBatchCount >= 2 ? (
          <button
            type="button"
            onClick={reviewExecuteAll}
            disabled={!!busy || !!pendingSession}
            className="btn-primary min-h-[40px] px-4 text-sm"
          >
            {pendingSession
              ? "Resolve the pending bundle first"
              : busy === "quote-all"
              ? "Checking…"
              : busy === "execute-all-direct"
                ? "Executing directly…"
              : `Review ${readyBatchCount} ready executions`}
          </button>
        ) : null}
      </div>

      {pendingSession ? (
        <div className="mt-4 rounded-xl border border-smoke-200 bg-white/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">
                Relayr payment {pendingSession.paymentStatus}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-smoke-700">
                Bundle{" "}
                <span className="font-mono">{pendingSession.bundleUuid}</span>{" "}
                has a submitted payment. Checking its status will not re-sign,
                re-pay, or resubmit transactions.
              </p>
              {pendingSession.paymentHash &&
              pendingSession.paymentChainId &&
              explorerTxUrl(
                pendingSession.paymentChainId,
                pendingSession.paymentHash,
              ) ? (
                <a
                  href={
                    explorerTxUrl(
                      pendingSession.paymentChainId,
                      pendingSession.paymentHash,
                    )!
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex font-mono text-xs text-bluebs-600 underline"
                >
                  Payment {pendingSession.paymentHash.slice(0, 10)}…
                </a>
              ) : null}
            </div>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void recoverPaidBundle(pendingSession)}
              className="btn-secondary min-h-[40px] px-4 text-sm"
            >
              {busy === "recover-bundle" ? "Checking…" : "Check bundle status"}
            </button>
          </div>
          <div className="mt-3 space-y-2 border-t border-smoke-200 pt-3">
            {pendingSession.chainIds.map((chainId, index) => {
              // Records carry only {chain, status}, so two consecutive-nonce
              // transactions on ONE chain are told apart by their position
              // among that chain's rows — matching on chain alone showed the
              // first record's state and hash for both.
              const occurrence = pendingSession.chainIds
                .slice(0, index)
                .filter((row) => row === chainId).length;
              const record =
                pendingSession.records.filter(
                  (row) => relayrRecordChain(row) === chainId,
                )[occurrence] ?? pendingSession.records[index];
              const state = record?.status?.state;
              const hash = record ? relayrDestinationHash(record) : null;
              const relayrReported = relayrStateIsSuccess(state);
              const label = relayrReported
                ? "Relayr-reported; onchain proof pending"
                : relayrStateIsFailed(state)
                  ? "Failed"
                  : state || "Pending";
              return (
                <div
                  key={`${chainId}-${index}`}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <span>
                    {JB_CHAINS[chainId as JBChainId]?.name ??
                      `Chain ${chainId}`}
                  </span>
                  {hash && explorerTxUrl(chainId, hash) ? (
                    <a
                      href={explorerTxUrl(chainId, hash)!}
                      target="_blank"
                      rel="noreferrer"
                      className={`font-mono underline ${
                        relayrStateIsFailed(state)
                          ? "text-error-600"
                          : "text-bluebs-600"
                      }`}
                    >
                      {label} · {hash.slice(0, 10)}…
                    </a>
                  ) : (
                    <span
                      className={
                        relayrStateIsFailed(state)
                          ? "text-error-600"
                          : "text-smoke-600"
                      }
                    >
                      {label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {batchReview ? (
        <div className="mt-4 rounded-xl border border-bluebs-200 bg-bluebs-50/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">
                Execute {batchReview.rows.length} confirmed Safe transactions
              </p>
              <p className="mt-1 text-xs leading-relaxed text-smoke-700">
                Each chain’s front transaction simulated successfully. Later
                nonces execute strictly in the reviewed order. Choose where to
                make one Relayr payment for the whole bundle.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setBatchReview(null);
                setNotice(null);
              }}
              disabled={!!busy}
              className="text-xs font-medium text-smoke-700 hover:text-ink"
            >
              Cancel
            </button>
          </div>

          <ul className="mt-3 divide-y divide-bluebs-100 rounded-lg border border-bluebs-100 bg-white">
            {batchReview.rows.map((row) => (
              <li
                key={`${row.chain.chainId}:${row.tx.nonce}`}
                className="flex items-center gap-2 px-3 py-2 text-xs text-smoke-700"
              >
                <ChainIcon chainId={row.chain.chainId} size={16} />
                <span className="font-medium text-ink">{row.chain.name}</span>
                <span className="font-mono">nonce {row.tx.nonce}</span>
                <span className="min-w-0 truncate">
                  {transactionLabel(row.chain.chainId, row.tx)}
                </span>
              </li>
            ))}
          </ul>

          <fieldset className="mt-4">
            <legend className="field-label">Pay Relayr on</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {batchReview.payments.map((payment, index) => (
                <label
                  key={`${payment.chain}:${payment.amount}:${index}`}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                    paymentIndex === index
                      ? "border-bluebs-500 bg-white text-ink"
                      : "border-smoke-200 bg-white/60 text-smoke-700"
                  }`}
                >
                  <input
                    type="radio"
                    name="safe-relayr-payment"
                    checked={paymentIndex === index}
                    onChange={() => setPaymentIndex(index)}
                    disabled={!!busy}
                    className="accent-bluebs-600"
                  />
                  <ChainIcon chainId={payment.chain as JBChainId} size={16} />
                  {relayrPaymentLabel(payment)}
                </label>
              ))}
            </div>
          </fieldset>

          <button
            type="button"
            onClick={confirmExecuteAll}
            disabled={!!busy || !batchReview.payments[paymentIndex]}
            className="btn-primary mt-4 min-h-[42px] w-full text-sm"
          >
            {busy === "execute-all"
              ? "Executing…"
              : `Pay once and execute ${batchReview.rows.length}`}
          </button>
        </div>
      ) : null}

      {query.isLoading ? (
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
                      const href = hash
                        ? safeTxLink(chain.chainId, safe, hash)
                        : queueUrl;
                      return (
                        <li
                          key={`${tx.nonce}:${hash ?? tx.data}`}
                          className="px-4 py-3.5"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <details className="min-w-0 flex-1">
                              <summary className="cursor-pointer list-none">
                                <p className="text-sm font-medium text-ink">
                                  #{tx.nonce} ·{" "}
                                  {transactionLabel(chain.chainId, tx)}
                                </p>
                                <p className="mt-1 text-xs text-smoke-500">
                                  {count}/{required} signatures
                                  {readyToExecute ? " · ready" : ""}
                                  {alternative
                                    ? " · same-nonce alternative"
                                    : ""}
                                  {Number(tx.operation) === 1
                                    ? " · DELEGATECALL"
                                    : ""}
                                  {BigInt(tx.value ?? 0) > 0n
                                    ? ` · sends ${tx.value} wei`
                                    : ""}
                                </p>
                                <p className="mt-1 text-xs text-smoke-500">
                                  Signed:{" "}
                                  {tx.confirmations?.length
                                    ? tx.confirmations
                                        .map((item) =>
                                          truncateAddress(item.owner),
                                        )
                                        .join(", ")
                                    : "none"}
                                </p>
                                {!readyToExecute && missingOwners.length ? (
                                  <p className="mt-1 text-xs text-smoke-500">
                                    Still needs {required - count} of:{" "}
                                    {missingOwners
                                      .map((owner) => truncateAddress(owner))
                                      .join(", ")}
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
                              {readyToExecute ? (
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
                              {href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs font-medium text-bluebs-600 hover:underline"
                                >
                                  Safe ↗
                                </a>
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

      {notice ? <p className="mt-3 text-sm text-smoke-700">{notice}</p> : null}
      <TxError error={error} />
    </section>
  );
}
