"use client";

import { transactionMessage } from '@/lib/transaction-message'
import { queuedSafeReviewCall, batchCallLabels, transactionLabel } from '@/lib/safe-queue-review'
export { SELECTOR_LABELS, batchCallLabels, transactionLabel } from '@/lib/safe-queue-review'

import { createProjectSafeRelayr, legacySafeRelayrBindings, safeRelayrSession } from '@/lib/safe-relayr'
import { canReplaceSafeRelayrQuote, SafeRelayrRecoveryError, requireSafeRelayrExecution, verifySafeRelayrLanding, type SafeRelayrExecution, type SafeRelayrResult, type SafeRelayrSession, type SafeRelayrPhase, type SafeRelayrProgress } from '@bananapus/nana-sdk-core/review/safe-relayr'
import { chainName } from '@/lib/urn'
import {
  JBCoreContracts,
  RevnetCoreContracts,
  jbContractAddress,
  jbProjectsAbi,
  revOwnerAbi,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { getAccount } from "@wagmi/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  stringToBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { ChainIcon } from "@/components/ChainIcon";
import { SafeQueueSkeleton } from "@/components/LoadingSkeletons";
import { TxError } from "@/components/ui/TxError";
import { useUnmountSignal } from "@/hooks/useUnmountSignal";
import { useWallet } from "@/hooks/useWallet";
import {
  loadRelayrPendingSession,
  relayrPaymentLabel,
  type RelayrPendingSession,
  type RelayrSafeExecutionProof,
} from "@/lib/relayr";
import {
  RELAYR_UUID_RE,
  RelayrProofUnavailableError,
  relayrDestinationHash,
  relayrRecordChain,
  relayrStateIsFailed,
  relayrStateIsSuccess,
  relayrSupportsChains,
  type RelayrEntry,
  type RelayrPayment,
  type RelayrTransactionRecord,
} from "@bananapus/nana-sdk-core/review/relayr";
import {
  confirmSafeTx,
  executeSafeTx,
  getSafeNextNonce,
  readSafeQueue,
  safeExecRelayrEntry,
  simulateFrozenSafeExecution,
  SAFE_REFUND_REFUSAL,
  SAFE_SERVICE,
  type SafeInfo,
} from "@/lib/safe";
import {
  canonicalSafeTxHash,
  hasSafeService,
  SAFE_EXEC_ABI,
  safeQueueUrl,
  safeTransactionHasRefund,
  safeTransactionMatchesCall,
  usableSafeConfirmations,
  type SafeQueuedTransaction,
} from "@bananapus/nana-sdk-core/safe-service";
import { ModalShell } from "@/components/ui/ModalShell";
import { useSafeConnection } from "@/lib/safe-connector";
import { wagmiConfig } from "@/providers/Providers";
import { AddressLabel } from "@/components/ui/AddressLabel";
import { explorerTxUrl } from '@/lib/chainDisplay'
import { clientFor } from '@/lib/authority'
import { safeAccountQueryOptions } from '@/lib/safe-account-query'
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
import { readMatchingAuthorityIdentities, UnprovenSafeError } from '@/lib/cross-chain-authority'
import { simulateStateChangingTransaction } from '@bananapus/nana-sdk-core/review'
import { readBoundedSafeNonce } from '@bananapus/nana-sdk-core/safe'

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
  transactions: SafeQueuedTransaction[];
  /** Why a shown row can't be signed or executed here, by safeTxHash. */
  blocked: Record<string, string>;
  error: string | null;
};

type ReadyTx = {
  chain: ChainQueue;
  tx: SafeQueuedTransaction;
};

type BatchReview = {
  session: SafeRelayrSession;
  payments: RelayrPayment[];
};

type SafeReviewContext = {
  chain: SafeQueueChain;
  tx: SafeQueuedTransaction;
  policyFingerprint?: string;
};

const CHECK_STATUS_LABELS: Record<string, string> = {
  checking: "Checking…", rechecking: "Re-checking…", ready: "Ready", failed: "Check failed",
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

function savedBatchDialogRow(execution: SafeRelayrExecution): BatchDialogRow {
  const message = requireSafeRelayrExecution(execution);
  const tx = { ...message, nonce: execution.nonce };
  return {
    chainId: execution.entry.chain,
    nonce: execution.nonce,
    label: transactionLabel(execution.entry.chain as JBChainId, tx),
    calls: batchCallLabels(execution.entry.chain as JBChainId, tx),
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
/** Legacy receipts paired UUIDs by position; normalize them before the shared proof. */
export async function verifyRelayrSafeBatchLanding(
  safe: Address,
  records: readonly RelayrTransactionRecord[],
  entries: readonly RelayrEntry[],
  proofs: readonly RelayrSafeExecutionProof[],
): Promise<void> {
  if (!entries.length || entries.length !== proofs.length || records.length !== entries.length) {
    throw new Error("The paid Relayr bundle lacks its exact Safe execution proof. Keep it pending and verify it manually.");
  }
  const executions = entries.map(entry => {
    const proof = proofs.find(item => item.chainId === entry.chain);
    if (!proof || !isAddressEqual(proof.safe, safe)) throw new Error("The paid Relayr bundle lacks its exact Safe execution proof.");
    return { entry, safe, nonce: proof.nonce, safeTxHash: proof.safeTxHash };
  });
  const bindings = legacySafeRelayrBindings(entries, proofs, records);
  await verifySafeRelayrLanding(chainId => clientFor(chainId as JBChainId), { executions, bindings, records });
  await Promise.all(executions.map(assertProjectSafePostconditions));
}

async function assertProjectSafePostconditions(execution: SafeRelayrExecution): Promise<void> {
  const nonce = await readBoundedSafeNonce(clientFor(execution.entry.chain as JBChainId), execution.safe);
  if (nonce === null) {
    throw new RelayrProofUnavailableError("Waiting for the Safe nonce to become available.");
  }
  if (nonce <= BigInt(execution.nonce)) {
    throw new Error("Could not prove the exact Safe execution consumed its nonce. Keep the paid bundle pending.");
  }
  await assertRelayrProjectHandlePostcondition(execution.entry.chain as JBChainId, execution.safe, execution.entry);
}

function exactPlainSafeCall(tx: SafeQueuedTransaction): void {
  if (!safeTransactionMatchesCall(tx, { to: tx.to, data: tx.data ?? "0x" })) {
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
  tx: SafeQueuedTransaction,
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
        sourceChainId: targetChainId,
        sourceClient: clientFor(targetChainId),
        destinationClient: client,
        authority: safe,
        service: SAFE_SERVICE,
      });
      if (identities?.creationUnproven) {
        throw new UnprovenSafeError(PROJECT_HANDLES_CHAIN_ID);
      }
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
      sourceChainId: targetChainId,
      sourceClient: clientFor(targetChainId),
      destinationClient: mainnetClient,
      authority: safe,
      service: SAFE_SERVICE,
    });
    if (identities?.creationUnproven) {
      throw new UnprovenSafeError(PROJECT_HANDLES_CHAIN_ID);
    }
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
        sourceChainId: targetChainId,
        sourceClient: clientFor(targetChainId),
        destinationClient: mainnetClient,
        authority: safe,
        service: SAFE_SERVICE,
      });
      if (identities?.creationUnproven) {
        throw new UnprovenSafeError(PROJECT_HANDLES_CHAIN_ID);
      }
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
      sourceChainId: targetChainId,
      sourceClient: clientFor(targetChainId),
      destinationClient: mainnetClient,
      authority: safe,
      service: SAFE_SERVICE,
    });
    if (identities?.creationUnproven) {
      throw new UnprovenSafeError(PROJECT_HANDLES_CHAIN_ID);
    }
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
  tx: SafeQueuedTransaction,
): Promise<SafeQueuedTransaction> {
  if (!chain.handleOnly) await assertSafeProjectAuthority(chain, safe);
  const expectedHash = canonicalSafeTxHash(chain.chainId, safe, tx);
  const { pending } = await readSafeQueue(chain.chainId, safe);
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


function executionPlan(
  currentNonce: number | null,
  transactions: SafeQueuedTransaction[],
  /**
   * The Safe's live owners and threshold: only current owners' confirmations
   * count. Each selected transaction is also rechecked against the live
   * policy immediately before execution.
   */
  info: SafeInfo | null,
  /** Rows that can't be executed here, by safeTxHash. */
  blocked: Record<string, string>,
): {
  direct: Set<SafeQueuedTransaction>;
  batch: SafeQueuedTransaction[];
  alternatives: Set<SafeQueuedTransaction>;
} {
  const direct = new Set<SafeQueuedTransaction>();
  const alternatives = new Set<SafeQueuedTransaction>();
  const batch: SafeQueuedTransaction[] = [];
  if (currentNonce === null || !info) return { direct, batch, alternatives };

  const byNonce = new Map<number, SafeQueuedTransaction[]>();
  for (const transaction of transactions) {
    byNonce.set(transaction.nonce, [...(byNonce.get(transaction.nonce) ?? []), transaction]);
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
    // A refund or a blocked row is never executed here, so it ends the run of executable nonces.
    if (
      safeTransactionHasRefund(transaction) ||
      blocked[transaction.safeTxHash?.toLowerCase() ?? ""] ||
      usableSafeConfirmations(transaction, info.owners).length < info.threshold
    ) {
      break;
    }
    batch.push(transaction);
    next += 1;
  }
  return { direct, batch, alternatives };
}

/** The connected chain when it is quoted, else a lone quote, else no choice yet. */
function initialPaymentIndex(payments: readonly RelayrPayment[]): number {
  const { chainId } = getAccount(wagmiConfig);
  const connected = payments.findIndex((payment) => payment.chain === chainId);
  return connected >= 0 ? connected : payments.length === 1 ? 0 : -1;
}

const PHASE_LABELS: Record<SafeRelayrPhase, string> = {
  reviewing: 'Review the Safe executions…',
  quoting: 'Getting payment options…',
  'payment-review': 'Review the network fee…',
  'payment-submitting': 'Confirm the payment in your wallet…',
  'payment-confirming': 'Confirming payment…',
  executing: 'Waiting for the Safe executions to confirm…',
  complete: 'All Safe executions confirmed.',
};
type ExecutionProgress = Pick<Extract<SafeRelayrProgress, { type: 'execution' }>, 'status' | 'hash' | 'message'>;

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
  // Leaving ends a Safe app's wait for the execution it proposed.
  const flowSignal = useUnmountSignal();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [batchReview, setBatchReview] = useState<BatchReview | null>(null);
  const [paymentIndex, setPaymentIndex] = useState(-1);
  // Execute all runs in one dialog; each chain row carries its own status.
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchRows, setBatchRows] = useState<BatchDialogRow[]>([]);
  const [batchStatus, setBatchStatus] = useState<Record<number, string>>({});
  const [executionProgress, setExecutionProgress] = useState<Record<number, ExecutionProgress>>({});
  const [phase, setPhase] = useState<SafeRelayrPhase | null>(null);
  const [watchingBundle, setWatchingBundle] = useState(false);
  const [batchDone, setBatchDone] = useState(false);
  const batchRun = useRef<AbortController | null>(null);
  const activeAccount = useRef(address);
  activeAccount.current = address;
  const [recovery, setRecovery] = useState<SafeRelayrSession | null>(null);
  const [recoveryResult, setRecoveryResult] = useState<SafeRelayrResult | null>(null);
  useEffect(() => {
    batchRun.current?.abort();
    setBusy(null);
    setBatchReview(null);
    setBatchOpen(false);
    setBatchRows([]);
    setBatchStatus({});
    setExecutionProgress({});
    setPhase(null);
    setWatchingBundle(false);
    setBatchDone(false);
    setNotice(null);
    setError(null);
    setRecovery(null);
    setRecoveryResult(null);
    return () => batchRun.current?.abort();
  }, [address, safe]);
  const queryClient = useQueryClient();
  const pendingScope = useMemo(
    () => `safe-queue:${safe.toLowerCase()}`,
    [safe],
  );
  const [pendingSession, setPendingSession] =
    useState<RelayrPendingSession | null>(null);
  const requiresBundleRecovery = useMemo(() => {
    if (!pendingSession) return false;
    try {
      const saved = safeRelayrSession(pendingScope);
      return !saved || !canReplaceSafeRelayrQuote(saved);
    } catch {
      return true;
    }
  }, [pendingSession, pendingScope]);
  const resumedScopeRef = useRef<string | null>(null);

  const queries = useQueries({ queries: chains.map(chain => ({
    queryKey: [
      "safeQueues",
      safe.toLowerCase(),
      chain.chainId,
      chain.projectId,
      chain.isRevnet,
      !!chain.handleOnly,
      chain.handleOnly ? chain.handleTuples.map(tuple => `${tuple.chainId}:${tuple.projectId}`).sort().join("|") : "",
    ],
    // Load with the operator tab, sharing Account's display proof. Each chain
    // renders independently; signing and execution still verify fresh state.
    staleTime: 60_000,
    refetchOnWindowFocus: !busy,
    queryFn: async (): Promise<ChainQueue> => {
      try {
        // Read-only inventory can load alongside the proofs, but no row
        // becomes actionable until all three reads have succeeded.
        const [, { safe: info }, queue] = await Promise.all([
          chain.handleOnly ? undefined : assertSafeProjectAuthority(chain, safe),
          queryClient.fetchQuery(safeAccountQueryOptions(chain.chainId, safe)),
          hasSafeService(chain.chainId)
            ? readSafeQueue(chain.chainId, safe)
            : getSafeNextNonce(chain.chainId, safe).then(nonce => ({ nonce, pending: [] })),
        ]);
        if (!info) {
          return {
            ...chain,
            info: null,
            currentNonce: null,
            transactions: [],
            blocked: {},
            error: null,
          };
        }
        if (!hasSafeService(chain.chainId)) {
          return {
            ...chain,
            info,
            currentNonce: queue.nonce,
            transactions: [],
            blocked: {},
            error: null,
          };
        }
        const { nonce: currentNonce, pending } = queue;
        const visibleTransactions: SafeQueuedTransaction[] = [];
        const blocked: Record<string, string> = {};
        for (const transaction of pending) {
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
          } catch (handleError) {
            // A claim whose Safe can't be proven the same on Ethereum is
            // shown with that line, and is never actionable here.
            if (handleError instanceof UnprovenSafeError && transaction.safeTxHash) {
              visibleTransactions.push(transaction);
              blocked[transaction.safeTxHash.toLowerCase()] = handleError.message;
            }
            // A stale or malformed handle proposal stays hidden and can
            // only be managed in the Safe app.
          }
        }
        return {
          ...chain,
          info,
          currentNonce,
          transactions: visibleTransactions,
          blocked,
          error: null,
        };
      } catch (queueError) {
        return {
          ...chain,
          info: null,
          currentNonce: null,
          transactions: [],
          blocked: {},
          error:
            queueError instanceof Error
              ? queueError.message
              : "Could not load the Safe queue.",
        };
      }
    },
  })) });

  const ready = useMemo<ReadyTx[]>(() => {
    const rows: ReadyTx[] = [];
    for (const query of queries) {
      const chain = query.data;
      if (!chain) continue;
      const plan = executionPlan(
        chain.currentNonce,
        chain.transactions,
        chain.info,
        chain.blocked,
      );
      for (const transaction of plan.batch) rows.push({ chain, tx: transaction });
    }
    return rows;
  }, [queries]);
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
  const refetchQueues = async () => {
    await Promise.all(chains.map(chain => queryClient.invalidateQueries({
      queryKey: safeAccountQueryOptions(chain.chainId, safe).queryKey,
      refetchType: 'none',
    })));
    await Promise.all(queries.map(query => query.refetch()));
  };

  const makeController = (signal?: AbortSignal) => createProjectSafeRelayr({
    scope: pendingScope,
    onSaved: session => {
      if (!signal?.aborted && activeAccount.current === address) {
        setPendingSession(session);
        if (session?.safeLifecycle && !canReplaceSafeRelayrQuote(session.safeLifecycle)) {
          setRecovery(session.safeLifecycle);
        } else if (session?.safeLifecycle) {
          // A definite wallet rejection can restore the same unpaid quote.
          setRecovery(current => current?.id === session.safeLifecycle!.id ? null : current);
        }
      }
    },
    onProgress: progress => {
      if (signal?.aborted || activeAccount.current !== address) return;
      if (progress.type === 'phase') {
        setPhase(progress.phase);
        setNotice(PHASE_LABELS[progress.phase]);
      } else {
        setExecutionProgress(current => ({
          ...current,
          [progress.execution.entry.chain]: { status: progress.status, hash: progress.hash, message: progress.message },
        }));
      }
    },
    revalidate: async execution => {
      let context = execution.context as SafeReviewContext | undefined;
      if (!context?.chain || !context.tx) {
        const chain = chains.find(item => item.chainId === execution.entry.chain);
        if (!chain) throw new Error("This saved Safe execution is outside this project's chains.");
        const { pending } = await readSafeQueue(chain.chainId, execution.safe);
        const tx = pending.find(item => canonicalSafeTxHash(chain.chainId, execution.safe, item).toLowerCase() === execution.safeTxHash.toLowerCase());
        if (!tx) throw new Error("The saved Safe transaction is no longer in the queue.");
        context = { chain, tx };
        execution.context = context;
      }
      if (canonicalSafeTxHash(execution.entry.chain, execution.safe, context.tx).toLowerCase() !== execution.safeTxHash.toLowerCase()) {
        throw new Error("The saved Safe review no longer matches its exact execution.");
      }
      await freshCanonicalQueuedTx(context.chain, execution.safe, context.tx);
      context.policyFingerprint = await simulateFrozenSafeExecution(
        execution.entry.chain as JBChainId, execution.safe, execution.nonce,
        execution.entry.data, context.policyFingerprint,
      );
      await freshCanonicalQueuedTx(context.chain, execution.safe, context.tx);
    },
    afterVerified: assertProjectSafePostconditions,
  });

  const markBatchExecuted = (chainIds: readonly number[]) => {
    setBatchStatus(Object.fromEntries(chainIds.map(chainId => [chainId, "Executed"])));
    setBatchDone(true);
  };

  const savedAccountNotice = (session: SafeRelayrSession) => {
    if (session.account.toLowerCase() === zeroAddress) {
      return "This older bundle has no saved funding account. Its status can still be checked, but its payment cannot be resumed.";
    }
    return session.account.toLowerCase() === address?.toLowerCase() ? null
      : `This bundle was saved by ${session.account}. Connect that wallet to resume its payment.`;
  };

  const applyResult = async (result: SafeRelayrResult) => {
    setRecoveryResult(result);
    if (result.state === "complete") {
      setPendingSession(null);
      setRecovery(null);
      markBatchExecuted(result.session.executions.map(item => item.entry.chain));
      setNotice(`Executed ${result.session.executions.length} Safe transactions.`);
      await refetchQueues();
    } else if (result.state === "ready") {
      setPhase(null);
      setRecovery(null);
      setBatchReview({ session: result.session, payments: result.payments });
      setPaymentIndex(initialPaymentIndex(result.payments));
      setNotice(null);
    } else if (result.state === "released") {
      setPendingSession(null);
      setRecovery(null);
      setBatchReview(null);
      if (result.session.releaseReason === "safe-nonces-consumed") {
        setBatchOpen(false);
        setNotice(result.recovery?.message ?? "The saved Safe nonces have already been used. The current queue has been refreshed.");
        await refetchQueues();
      } else if (result.session.releaseReason === "quote-expired" || result.session.paymentStatus === "expired") {
        setNotice("The previous quote expired without funding. Review the current Safe transactions again.");
      } else {
        setNotice("Review the current Safe transactions again.");
      }
    } else {
      setRecovery(result.session);
      setBatchReview(null);
      if (result.session.executions.length) setBatchRows(result.session.executions.map(savedBatchDialogRow));
      setNotice(current => result.recovery?.message ?? current ?? "Checking the existing bundle's execution status…");
    }
  };

  const watchExistingBundle = (
    session: SafeRelayrSession,
    run: AbortController,
    controller: ReturnType<typeof createProjectSafeRelayr>,
  ) => {
    setWatchingBundle(true);
    void controller.watch({
      account: session.account, sessionId: session.id, signal: run.signal,
      onUpdate: async result => {
        if (run.signal.aborted || batchRun.current !== run || activeAccount.current !== address) return;
        if (result.state === "ready") {
          // A background status check does not replace explicit review of the
          // saved calls. The recovery action opens that review when requested.
          setRecovery(result.session);
          setRecoveryResult(result);
          setNotice(savedAccountNotice(result.session) ?? "The existing quote can be resumed. Review its saved calls to continue.");
        } else {
          await applyResult(result);
        }
      },
    }).catch((watchError: unknown) => {
      if (!run.signal.aborted && batchRun.current === run) {
        setPhase(null);
        setNotice(null);
        setError(watchError instanceof Error ? watchError.message : "Could not check the existing bundle.");
      }
    }).finally(() => {
      if (!run.signal.aborted && batchRun.current === run) setWatchingBundle(false);
    });
  };

  const recoverPaidBundle = async (reviewSavedCalls = true) => {
    const run = new AbortController();
    batchRun.current?.abort();
    batchRun.current = run;
    setBusy("recover-bundle");
    setError(null);
    setRecoveryResult(null);
    try {
      // A Safe-scoped record can be created by another wallet or tab. Read the
      // current journal and check its saved identity without authorizing payment.
      const session = safeRelayrSession(pendingScope);
      if (!session) throw new Error("The saved Safe bundle is no longer available on this device. Reopen the Safe queue to review its current status.");
      const controller = makeController(run.signal);
      let result = await controller.check({ account: session.account, sessionId: session.id, signal: run.signal });
      if (run.signal.aborted || batchRun.current !== run || activeAccount.current !== address) return;
      if (result.state === "ready" && !run.signal.aborted) {
        setBatchRows(result.session.executions.map(savedBatchDialogRow));
        const accountNotice = savedAccountNotice(result.session);
        if (!reviewSavedCalls || accountNotice || !address) {
          setRecovery(result.session);
          setRecoveryResult(result);
          setBatchReview(null);
          setNotice(accountNotice ?? "The existing quote can be resumed. Review its saved calls to continue.");
          return;
        }
        result = await controller.prepare({ account: address, executions: result.session.executions, signal: run.signal });
      }
      if (!run.signal.aborted && activeAccount.current === address) {
        await applyResult(result);
        if (result.state === "pending" && !result.recovery) watchExistingBundle(result.session, run, controller);
      }
    } catch (checkError) {
      if (!run.signal.aborted) setError(checkError instanceof Error ? checkError.message : "Could not check the existing bundle.");
    } finally {
      if (!run.signal.aborted) setBusy(null);
    }
  };

  useEffect(() => {
    if (resumedScopeRef.current === pendingScope) return;
    resumedScopeRef.current = pendingScope;
    const saved = loadRelayrPendingSession(pendingScope);
    if (saved?.safeLifecycle?.state === "complete" || saved?.safeLifecycle?.state === "released") {
      setPendingSession(null);
      return;
    }
    setPendingSession(saved);
  }, [pendingScope]);

  const sign = async (chain: ChainQueue, tx: SafeQueuedTransaction) => {
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
        queuedSafeReviewCall(chain.chainId, fresh),
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

  const execute = async (chain: ChainQueue, tx: SafeQueuedTransaction) => {
    const key = `execute:${chain.chainId}:${tx.nonce}`;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const fresh = await freshCanonicalQueuedTx(chain, safe, tx);
      const reverifyAuthority = async () => {
        await freshCanonicalQueuedTx(chain, safe, fresh);
      };
      const result = await executeSafeTx(chain.chainId, safe, fresh, {
        reverifyAuthority,
        signal: flowSignal(),
      });
      if (result.status === "confirmed") {
        await assertRelayrProjectHandlePostcondition(
          chain.chainId,
          safe,
          safeExecRelayrEntry(chain.chainId, safe, fresh, chain.info?.owners ?? []),
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
    const run = new AbortController();
    batchRun.current?.abort();
    batchRun.current = run;
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
          const result = await executeSafeTx(row.chain.chainId, safe, fresh, {
            reverifyAuthority: async () => {
              await freshCanonicalQueuedTx(row.chain, safe, fresh);
            },
            signal: flowSignal(),
          });
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
            safeExecRelayrEntry(row.chain.chainId, safe, fresh, row.chain.info?.owners ?? []),
          );
        }
        setNotice(
          `Executed ${ordered.length} Safe transactions directly.`,
        );
        await refetchQueues();
        return;
      }

      setBatchRows(relayrRows.map(batchDialogRow));
      setBatchStatus({});
      setExecutionProgress({});
      setPhase(null);
      setBatchDone(false);
      setBatchReview(null);
      setRecovery(null);
      setRecoveryResult(null);
      setBatchOpen(true);
      const executions: SafeRelayrExecution[] = relayrRows.map(row => ({
        entry: safeExecRelayrEntry(row.chain.chainId, safe, row.tx, row.chain.info?.owners ?? []),
        safe, safeTxHash: canonicalSafeTxHash(row.chain.chainId, safe, row.tx), nonce: row.tx.nonce,
        context: { chain: row.chain, tx: row.tx } satisfies SafeReviewContext,
      }));
      const result = await makeController(run.signal).prepare({
        account: address, executions, signal: run.signal,
        onStatus: (index, status) => {
          if (!run.signal.aborted) setBatchStatus(current => ({ ...current, [executions[index].entry.chain]: CHECK_STATUS_LABELS[status] }));
        },
      });
      if (!run.signal.aborted && activeAccount.current === address) await applyResult(result);
    } catch (batchError) {
      if (run.signal.aborted || batchRun.current !== run) return;
      setPhase(null);
      setNotice(null);
      if (batchError instanceof SafeRelayrRecoveryError) {
        setRecovery(batchError.session);
        if (batchError.session.executions.length) setBatchRows(batchError.session.executions.map(savedBatchDialogRow));
        if (batchError.recovery) {
          await applyResult({ state: batchError.session.state === "released" ? "released" : "pending", session: batchError.session, payments: [], recovery: batchError.recovery });
          return;
        }
        const accountNotice = savedAccountNotice(batchError.session);
        if (accountNotice) {
          setNotice(accountNotice);
          return;
        }
      }
      setError(batchError instanceof Error ? batchError.message : "Could not review the Safe transactions.");
    } finally {
      if (!run.signal.aborted && batchRun.current === run) setBusy(null);
    }
  };

  const confirmExecuteAll = async () => {
    if (!address || !batchReview) return;
    const payment = batchReview.payments[paymentIndex];
    if (!payment) return;
    const run = new AbortController();
    batchRun.current = run;
    setBusy("execute-all");
    setError(null);
    setRecoveryResult(null);
    setNotice(null);
    try {
      const controller = makeController(run.signal);
      const result = await controller.fund({
        account: address, sessionId: batchReview.session.id, paymentChainId: payment.chain, signal: run.signal,
        onStatus: (index, status) => {
          if (!run.signal.aborted) setBatchStatus(current => ({ ...current, [batchReview.session.executions[index].entry.chain]: CHECK_STATUS_LABELS[status] }));
        },
      });
      if (!run.signal.aborted && activeAccount.current === address) {
        await applyResult(result);
        if (result.state === "pending" && !result.recovery) watchExistingBundle(result.session, run, controller);
      }
    } catch (batchError) {
      if (run.signal.aborted) return;
      setPhase(null);
      setNotice(null);
      if (batchError instanceof SafeRelayrRecoveryError) {
        setRecovery(batchError.session);
        setBatchReview(null);
        if (batchError.session.executions.length) setBatchRows(batchError.session.executions.map(savedBatchDialogRow));
        if (batchError.recovery) {
          await applyResult({ state: batchError.session.state === "released" ? "released" : "pending", session: batchError.session, payments: [], recovery: batchError.recovery });
          return;
        }
      }
      else {
        let saved: SafeRelayrSession | null;
        try {
          saved = safeRelayrSession(pendingScope);
        } catch {
          // Retain the reviewed recovery identity when the current durable
          // journal cannot be read. A failed read cannot authorize a new quote.
          saved = null;
        }
        if (!saved || saved.id !== batchReview.session.id ||
            saved.account.toLowerCase() !== address.toLowerCase() || !canReplaceSafeRelayrQuote(saved)) {
          setRecovery(saved ?? batchReview.session);
          if (saved?.executions.length) setBatchRows(saved.executions.map(savedBatchDialogRow));
          setBatchReview(null);
        }
      }
      setError(batchError instanceof Error ? batchError.message : "Could not execute the Safe transactions.");
    } finally {
      if (!run.signal.aborted) setBusy(null);
    }
  };

  const openPaidBundle = async () => {
    if (!pendingSession) return;
    setError(null);
    setNotice(null);
    setRecoveryResult(null);
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
    try {
      const session = safeRelayrSession(pendingScope);
      setRecovery(session);
      if (session?.executions.length) setBatchRows(session.executions.map(savedBatchDialogRow));
    } catch (savedError) {
      setError(savedError instanceof Error ? savedError.message : "Could not read the saved bundle.");
    }
    setBatchOpen(true);
    await recoverPaidBundle(false);
  };

  const closeExecuteAll = () => {
    batchRun.current?.abort();
    setBusy(null);
    setBatchOpen(false);
    setBatchReview(null);
    setBatchRows([]);
    setBatchStatus({});
    setExecutionProgress({});
    setPhase(null);
    setWatchingBundle(false);
    setBatchDone(false);
    setNotice(null);
    setError(null);
    setRecoveryResult(null);
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

  const rowStatus = ({ chainId, nonce }: BatchDialogRow): string => {
    const progress = executionProgress[chainId];
    if (progress) return progress.status === 'executed' ? 'Executed'
      : progress.status === 'failed' ? 'Failed'
      : progress.status === 'confirming' ? 'Confirming…' : 'Waiting for execution';
    if (batchDone) return 'Executed';
    if (busy === "recover-bundle") return "Checking…";
    const nonceCheck = recoveryResult?.recovery?.checks?.find(check => check.chainId === chainId && check.nonce === nonce);
    if (nonceCheck) return nonceCheck.state === "consumed" ? "Nonce already used"
      : nonceCheck.state === "live" ? "Still queued" : "Could not check nonce";
    if (recoveryResult?.recovery) return "Status unavailable";
    if (!pendingSession || batchDone || (pendingSession.safeLifecycle?.paymentStatus === "unfunded" && !recovery)) return batchStatus[chainId] ?? "Waiting";
    const state = paidRecord(chainId)?.status?.state;
    if (relayrStateIsFailed(state)) return "Failed";
    if (relayrStateIsSuccess(state) || (paidRecord(chainId) && relayrDestinationHash(paidRecord(chainId)!))) return "Confirming…";
    return pendingSession.paymentStatus === "confirmed"
      ? "Executing…"
      : "Waiting for payment";
  };

  const payment = batchReview?.payments[paymentIndex];
  const preparingBatch = !batchDone && !recovery && !batchReview && !(error && !busy);
  const executeAllDialog = (
    <ModalShell
      title={`Execute ${batchRows.length} Safe transactions`}
      subtitle="One payment executes each chain's next fully signed transaction. Later nonces need a new review after these land."
      busy={busy === "execute-all"}
      onClose={closeExecuteAll}
      footer={
        batchDone ? (
          <div className="flex justify-end">
            <button type="button" onClick={closeExecuteAll} className="btn-primary min-h-[42px] px-5 text-sm">
              Done
            </button>
          </div>
        ) : recovery ? (
          <div className="flex justify-end">
            <button type="button" onClick={() => void recoverPaidBundle()} disabled={busy !== null || watchingBundle} className="btn-primary min-h-[42px] px-5 text-sm">
              {busy || watchingBundle ? phase ? PHASE_LABELS[phase] : "Checking…" : recoveryResult?.state === "ready" && !savedAccountNotice(recoveryResult.session) ? "Review saved quote" : RELAYR_UUID_RE.test(recovery.bundleUuid ?? "") ? "Check execution status" : "Check Safe nonces"}
            </button>
          </div>
        ) : error && !batchReview && !busy ? (
          <div className="flex justify-end">
            <button type="button" onClick={reviewExecuteAll} className="btn-primary min-h-[42px] px-5 text-sm">
              Retry checks
            </button>
          </div>
        ) : preparingBatch ? (
          <p role="status" className="flex items-center gap-2 text-sm text-smoke-600">
            <span aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-smoke-300 border-t-smoke-700 motion-reduce:animate-none" />
            {phase ? PHASE_LABELS[phase] : "Checking…"}
          </p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              {payment ? (
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
                  <ChainIcon chainId={payment.chain as JBChainId} size={16} />
                </span>
              ) : null}
              <select
                aria-label="Pay on"
                value={paymentIndex}
                onChange={(event) => setPaymentIndex(Number(event.target.value))}
                disabled={!!busy}
                className={`select-caret min-h-[42px] w-full truncate rounded-lg border border-smoke-300 bg-white py-2 pr-9 text-sm text-ink disabled:opacity-60 ${
                  payment ? "pl-9" : "pl-3"
                }`}
              >
                <option value={-1} disabled>
                  Choose a chain
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
              {busy && phase ? PHASE_LABELS[phase] : busy === "execute-all"
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
          const status = rowStatus(row);
          const record = paidRecord(row.chainId);
          const hash = executionProgress[row.chainId]?.hash ?? (record ? relayrDestinationHash(record) : null);
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
          Payment on {chainName(pendingSession.paymentChainId)} ↗
        </a>
      ) : null}
      {notice && !preparingBatch ? <p className="mt-3 text-sm text-smoke-700">{transactionMessage(notice)}</p> : null}
      {recoveryResult?.recovery ? (
        <ul className="mt-3 space-y-1 text-sm">
          {batchRows.map(row => {
            const queueUrl = safeQueueUrl(row.chainId, safe);
            return queueUrl ? (
              <li key={row.chainId}>
                <a href={queueUrl} target="_blank" rel="noreferrer" className="text-bluebs-600 underline">
                  Open {chainName(row.chainId)} queue in Safe ↗
                </a>
              </li>
            ) : null;
          })}
        </ul>
      ) : null}
      <TxError error={error} />
    </ModalShell>
  );

  // Opened as a Safe App (or connected through Safe{Wallet} over
  // WalletConnect), the connected account is a Safe, not an owner: it
  // cannot sign for itself, and executing or paying Relayr from it would
  // take the very nonce the queued transaction needs. Safe{Wallet}'s own
  // queue is where its owners sign and execute.
  const viaSafeApp = useSafeConnection(wagmiConfig);

  return (
    <section className="card p-5">
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
        {requiresBundleRecovery ? (
          <button
            type="button"
            onClick={openPaidBundle}
            className="btn-secondary min-h-[40px] px-4 text-sm"
          >
            {busy === "recover-bundle" ? "Checking existing bundle…" : "View existing bundle"}
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

        <div className="mt-4 space-y-5">
          {queries.map((query, index) => {
            const chain = query.data;
            if (!chain) return (
              <div key={chains[index].chainId} aria-label={`Loading ${chains[index].name} multisig transactions`}>
                <p className="text-sm text-smoke-500">{chains[index].name}</p>
                <SafeQueueSkeleton groups={1} />
              </div>
            );
            const isSigner =
              !!address &&
              !!chain.info?.owners.some(
                (owner) => owner.toLowerCase() === address.toLowerCase(),
              );
            const plan = executionPlan(
              chain.currentNonce,
              chain.transactions,
              chain.info,
              chain.blocked,
            );
            const owners = chain.info?.owners ?? [];
            const required = chain.info?.threshold ?? 1;
            const queueUrl = safeQueueUrl(chain.chainId, safe);
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

                {chain.error ? (
                  <div className="px-4 py-4 text-sm">
                    <p className="text-red-700">{transactionMessage(chain.error)}</p>
                    <button type="button" className="btn-secondary mt-3 px-3 py-2" disabled={query.isFetching || !!busy}
                      onClick={() => void query.refetch()}>
                      {query.isFetching ? "Retrying…" : `Retry ${chain.name}`}
                    </button>
                  </div>
                ) : !chain.info ? (
                  <p className="px-4 py-4 text-sm text-smoke-500">
                    Safe is not deployed on {chain.name}.
                  </p>
                ) : !hasSafeService(chain.chainId) ? (
                  <p className="px-4 py-4 text-sm text-smoke-700">
                    {`Safe queue isn't available on ${chain.name}.`}
                  </p>
                ) : chain.transactions.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-smoke-500">
                    No pending transactions.
                  </p>
                ) : (
                  <ul className="divide-y divide-smoke-100">
                    {chain.transactions.map((tx) => {
                      // Only the Safe's current owners' well-formed
                      // confirmations count toward its live threshold.
                      const usable = usableSafeConfirmations(tx, owners);
                      const count = usable.length;
                      const refund = safeTransactionHasRefund(tx);
                      const blockedLine = chain.blocked[tx.safeTxHash?.toLowerCase() ?? ""];
                      const signed =
                        !!address &&
                        usable.some(
                          (confirmation) =>
                            confirmation.owner.toLowerCase() ===
                            address.toLowerCase(),
                        );
                      const thresholdMet = count >= required;
                      const readyToExecute = thresholdMet && !refund && !blockedLine;
                      const confirmedOwners = new Set(
                        usable.map((confirmation) =>
                          confirmation.owner.toLowerCase(),
                        ),
                      );
                      const missingOwners = owners.filter(
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
                                  {usable.length ? (
                                    <SignerList
                                      owners={usable.map((item) => item.owner)}
                                      you={address}
                                    />
                                  ) : (
                                    "none"
                                  )}
                                </p>
                                {!thresholdMet && missingOwners.length ? (
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
                              {refund ? (
                                <p className="text-xs text-smoke-700">
                                  {SAFE_REFUND_REFUSAL}
                                </p>
                              ) : blockedLine ? (
                                <p className="text-xs text-smoke-700">
                                  {blockedLine}
                                </p>
                              ) : isSigner && !signed && !readyToExecute ? (
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

      {!batchOpen && notice ? <p className="mt-3 text-sm text-smoke-700">{transactionMessage(notice)}</p> : null}
      {!batchOpen ? <TxError error={error} /> : null}
    </section>
  );
}
