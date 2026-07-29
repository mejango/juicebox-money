"use client";

import { getAccount } from "@wagmi/core";
import {
  JB_CHAINS,
  jbContractAddress,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toFunctionSelector, type Address } from "viem";
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
  relayrStateIsFailed,
  relayrStateIsSuccess,
  saveRelayrPendingSession,
  type RelayrEntry,
  type RelayrPayment,
  type RelayrPendingSession,
  type RelayrQuote,
} from "@/lib/relayr";
import {
  confirmSafeTx,
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
  type SafeQueuedTx,
  SAFE_EXEC_ABI,
} from "@/lib/safe";
import { truncateAddress } from "@/lib/format";
import { requireTransactionReview } from "@/lib/transaction-review";
import { wagmiConfig } from "@/providers/Providers";

export type SafeQueueChain = {
  chainId: JBChainId;
  name: string;
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

type BatchReview = {
  quote: RelayrQuote;
  rows: ReadyTx[];
  entries: RelayrEntry[];
  payments: RelayrPayment[];
};

const SELECTOR_LABELS = new Map<string, string>(
  [
    ["setPermissionsFor(address,(address,uint64,uint8[]))", "Set permissions"],
    ["setOperatorOf(uint256,address)", "Transfer operator"],
    ["transferFrom(address,address,uint256)", "Transfer ownership"],
    ["setUriOf(uint256,string)", "Set project metadata"],
    ["deployERC20For(uint256,string,string,bytes32)", "Deploy ERC-20"],
    ["setTokenMetadataOf(uint256,string,string)", "Set token metadata"],
    ["setHookFor(uint256,address)", "Set buyback hook"],
    ["setTerminalFor(uint256,address)", "Set router terminal"],
    [
      "initializePoolFor(uint256,uint24,int24,uint32,address,uint160)",
      "Initialize buyback pool",
    ],
  ].map(([signature, label]) => [toFunctionSelector(signature), label]),
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
    const required = transaction.confirmationsRequired ?? 1;
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
      chains.map((chain) => chain.chainId).join(","),
    ],
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<ChainQueue[]> =>
      Promise.all(
        chains.map(async (chain) => {
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
          try {
            const [currentNonce, transactions] = await Promise.all([
              getSafeNextNonce(chain.chainId, safe),
              listPendingSafeTxs(chain.chainId, safe),
            ]);
            return {
              ...chain,
              info,
              currentNonce,
              transactions,
              error: null,
            };
          } catch (queueError) {
            return {
              ...chain,
              info,
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
      const plan = executionPlan(chain.currentNonce, chain.transactions);
      for (const transaction of plan.batch)
        rows.push({ chain, tx: transaction });
    }
    return rows;
  }, [query.data]);
  const refetchQueues = query.refetch;

  const recoverPaidBundle = useCallback(
    async (session: RelayrPendingSession) => {
      setBusy("recover-bundle");
      setError(null);
      setNotice(
        "Checking an already-paid Relayr bundle. This will not re-sign, re-pay, or resubmit transactions.",
      );
      try {
        await relayrPoll(session.bundleUuid, (records) => {
          const updated = saveRelayrPendingSession(pendingScope, {
            ...session,
            records,
          });
          setPendingSession(updated);
          const progress = relayrProgress(records, session.expectedCount);
          setNotice(
            `Checking paid Relayr bundle… ${progress.confirmed}/${progress.total}`,
          );
        });
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
    [pendingScope, refetchQueues],
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
      await confirmSafeTx(chain.chainId, safe, tx, address);
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
      const result = await executeSafeTx(chain.chainId, safe, tx);
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
    if (!address || ready.length < 2) return;
    setBusy("quote-all");
    setError(null);
    setNotice(null);
    try {
      const simulatedChains = new Set<number>();
      for (let index = 0; index < ready.length; index++) {
        const row = ready[index];
        // A later consecutive nonce cannot simulate against today's Safe
        // nonce until the earlier transaction executes. Verify the front
        // transaction on each chain; Relayr's virtual nonces preserve the
        // reviewed order for the remainder.
        if (simulatedChains.has(row.chain.chainId)) continue;
        simulatedChains.add(row.chain.chainId);
        setNotice(
          `Checking ${index + 1}/${ready.length} on ${row.chain.name}…`,
        );
        await simulateSafeExecution(row.chain.chainId, safe, row.tx, address);
      }
      if (simulatedChains.size === 1) {
        const ordered = [...ready].sort(
          (a, b) => Number(a.tx.nonce) - Number(b.tx.nonce),
        );
        setBusy("execute-all-direct");
        for (let index = 0; index < ordered.length; index++) {
          const row = ordered[index];
          setNotice(
            `Executing ${index + 1}/${ordered.length} directly on ${row.chain.name}…`,
          );
          await executeSafeTx(row.chain.chainId, safe, row.tx);
        }
        setNotice(
          `Executed ${ordered.length} Safe transactions directly on ${ordered[0].chain.name}.`,
        );
        await refetchQueues();
        return;
      }
      const entries = ready.map((row) =>
        safeExecRelayrEntry(row.chain.chainId, safe, row.tx),
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
      setBatchReview({ quote, rows: [...ready], entries, payments });
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
    const payment = batchReview.payments[paymentIndex];
    if (!payment) return;
    let paidSession: RelayrPendingSession | null = null;
    setBusy("execute-all");
    setError(null);
    setNotice(
      "Confirm one Relayr payment to execute every reviewed transaction.",
    );
    try {
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
      let submittedSession: RelayrPendingSession | null = null;
      const paymentHash = await relayrPay(payment, address, (hash) => {
        submittedSession = saveRelayrPendingSession(pendingScope, {
          bundleUuid: batchReview.quote.bundle_uuid,
          paymentHash: hash,
          paymentChainId: payment.chain,
          paymentStatus: "submitted",
          chainIds: batchReview.rows.map((row) => row.chain.chainId),
          expectedCount: batchReview.rows.length,
          records: batchReview.quote.transactions ?? [],
          itemCount: batchReview.rows.length,
          account: address,
          createdAt: Date.now(),
        });
        paidSession = submittedSession;
        setPendingSession(submittedSession);
        setNotice(
          `Relayr payment submitted (${hash.slice(0, 10)}…). Waiting for confirmation; do not pay again.`,
        );
      });
      const initialSession = saveRelayrPendingSession(pendingScope, {
        ...(submittedSession ?? {
          bundleUuid: batchReview.quote.bundle_uuid,
          paymentHash,
          paymentChainId: payment.chain,
          chainIds: batchReview.rows.map((row) => row.chain.chainId),
          expectedCount: batchReview.rows.length,
          records: batchReview.quote.transactions ?? [],
          itemCount: batchReview.rows.length,
          account: address,
          createdAt: Date.now(),
        }),
        paymentStatus: "confirmed",
      });
      paidSession = initialSession;
      setPendingSession(initialSession);
      await relayrPoll(batchReview.quote.bundle_uuid, (records) => {
        const updated = saveRelayrPendingSession(pendingScope, {
          ...initialSession,
          records,
        });
        setPendingSession(updated);
        const progress = relayrProgress(records, batchReview.rows.length);
        setNotice(
          `Executing through Relayr… ${progress.confirmed}/${progress.total}`,
        );
      });
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
        {ready.length >= 2 ? (
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
              : `Review ${ready.length} ready executions`}
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
              {pendingSession.paymentHash && pendingSession.paymentChainId ? (
                <a
                  href={`https://${JB_CHAINS[pendingSession.paymentChainId as JBChainId]?.etherscanHostname}/tx/${pendingSession.paymentHash}`}
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
              const record =
                pendingSession.records.find((row) => row.chain === chainId) ??
                pendingSession.records[index];
              const state = record?.status?.state;
              const hash = record ? relayrDestinationHash(record) : null;
              const label = relayrStateIsSuccess(state)
                ? "Confirmed"
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
                  {hash ? (
                    <a
                      href={`https://${JB_CHAINS[chainId as JBChainId]?.etherscanHostname}/tx/${hash}`}
                      target="_blank"
                      rel="noreferrer"
                      className={`font-mono underline ${
                        relayrStateIsFailed(state)
                          ? "text-error-600"
                          : relayrStateIsSuccess(state)
                            ? "text-mint-700"
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
                          : relayrStateIsSuccess(state)
                            ? "text-mint-700"
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
            const plan = executionPlan(chain.currentNonce, chain.transactions);
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
