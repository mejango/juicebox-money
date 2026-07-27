"use client";

import {
  JB_CHAINS,
  JBCoreContracts,
  jbContractAddress,
  jbPermissionsAbi,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { zeroAddress, type Address } from "viem";
import { AddressField } from "@/components/create/AddressField";
import { CheckRow } from "@/components/create/ui";
import { ChainIcon } from "@/components/ChainIcon";
import {
  AccountGroupsSkeleton,
  ActionRowsSkeleton,
} from "@/components/LoadingSkeletons";
import { SafeQueueCard } from "@/components/project/SafeQueueCard";
import { AddressLink } from "@/components/ui/AddressLink";
import { ChainPicker } from "@/components/ui/ChainPicker";
import { ErrorNote } from "@/components/ui/TxError";
import {
  clientFor,
  readAuthorityOf,
  runAuthorityCalls,
  toggleInSet,
  type AuthorityCall,
} from "@/lib/authority";
import {
  getPermissionHoldersAcrossDeployments,
  type BsPermissionHolder,
} from "@/lib/bendystraw";
import { resolvedAddress } from "@/lib/ens";
import {
  decodePermissionBitmap,
  permissionDefinition,
  V6_PERMISSIONS,
} from "@/lib/permissions";
import {
  deploySafeSameAddress,
  fetchSafeCreation,
  fetchSafeInfo,
  type SafeInfo,
} from "@/lib/safe";
import {
  buildPermissionsAuthorityCall,
  buildProjectOwnershipAuthorityCall,
  buildRevnetOperatorAuthorityCall,
} from "@/lib/transaction-builders";
import { chainName } from "@/lib/urn";

export type AuthorityDeployment = {
  chainId: JBChainId;
  projectId: number;
  indexedAuthority: Address | null;
};

type AuthorityRow = AuthorityDeployment & {
  name: string;
  authority: Address | null;
  safe: SafeInfo | null;
  accountType: "Safe Multisig" | "EOA" | "Contract" | "Unknown";
};

type AuthorityGroup = {
  key: string;
  authority: Address | null;
  safe: SafeInfo | null;
  accountType: AuthorityRow["accountType"];
  rows: AuthorityRow[];
};

async function readAuthorityRows(
  deployments: AuthorityDeployment[],
  isRevnet: boolean,
): Promise<AuthorityRow[]> {
  return Promise.all(
    deployments.map(async (deployment) => {
      const client = clientFor(deployment.chainId);
      const authority = await readAuthorityOf(client, deployment, {
        indexedOnly: isRevnet,
      });

      let safe: SafeInfo | null = null;
      let accountType: AuthorityRow["accountType"] = "Unknown";
      if (authority) {
        safe = await fetchSafeInfo(deployment.chainId, authority);
        if (safe) accountType = "Safe Multisig";
        else {
          const code = await client
            .getBytecode({ address: authority })
            .catch(() => null);
          accountType = !code || code === "0x" ? "EOA" : "Contract";
        }
      }
      return {
        ...deployment,
        name: chainName(deployment.chainId),
        authority,
        safe,
        accountType,
      };
    }),
  );
}

function groupAuthorityRows(rows: AuthorityRow[]): AuthorityGroup[] {
  const groups = new Map<string, AuthorityGroup>();
  for (const row of rows) {
    const safeKey = row.safe
      ? `${row.safe.threshold}/${[...row.safe.owners]
          .map((owner) => owner.toLowerCase())
          .sort()
          .join(",")}`
      : "";
    const key = `${row.authority?.toLowerCase() ?? "unknown"}:${row.accountType}:${safeKey}`;
    const group = groups.get(key) ?? {
      key,
      authority: row.authority,
      safe: row.safe,
      accountType: row.accountType,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function samePermissionSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const aa = [...a].sort((x, y) => x - y);
  const bb = [...b].sort((x, y) => x - y);
  return aa.every((value, index) => value === bb[index]);
}

type OperatorGrant = {
  operator: Address;
  account: Address;
  isRevnetOperator: boolean;
  rows: BsPermissionHolder[];
  union: number[];
  differs: boolean;
};

function aggregateGrants(
  holders: BsPermissionHolder[],
  deployments: AuthorityDeployment[],
): OperatorGrant[] {
  const groups = new Map<string, OperatorGrant>();
  for (const holder of holders) {
    const key = holder.operator.toLowerCase();
    const current = groups.get(key) ?? {
      operator: holder.operator as Address,
      account: holder.account as Address,
      isRevnetOperator: false,
      rows: [],
      union: [],
      differs: false,
    };
    current.rows.push(holder);
    current.isRevnetOperator ||= !!holder.isRevnetOperator;
    current.union = [
      ...new Set([...current.union, ...holder.permissions]),
    ].sort((a, b) => a - b);
    groups.set(key, current);
  }
  for (const group of groups.values()) {
    const first = group.rows[0]?.permissions ?? [];
    const coveredChains = new Set(group.rows.map((row) => row.chainId));
    group.differs =
      deployments.some((row) => !coveredChains.has(row.chainId)) ||
      group.rows.some((row) => !samePermissionSet(first, row.permissions));
  }
  return [...groups.values()];
}

export function AuthorityOverview({
  deployments,
  isRevnet,
  beforePermissions,
}: {
  deployments: AuthorityDeployment[];
  isRevnet: boolean;
  /** Website-order cards rendered after the Safe queue and before permissions. */
  beforePermissions?: React.ReactNode;
}) {
  const authorityLabel = isRevnet ? "Project operator" : "Project owner";
  const authorityQuery = useQuery({
    queryKey: [
      "authorityRows",
      isRevnet,
      deployments
        .map(
          (row) =>
            `${row.chainId}:${row.projectId}:${row.indexedAuthority ?? ""}`,
        )
        .join(","),
    ],
    staleTime: 30_000,
    queryFn: () => readAuthorityRows(deployments, isRevnet),
  });
  // `rows` intentionally falls back to a fresh empty array only while the
  // query has no data; no derived group can be observed in that state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = authorityQuery.data ?? [];
  const groups = useMemo(() => groupAuthorityRows(rows), [rows]);
  const known = rows.filter((row) => !!row.authority);
  const differs =
    known.length > 1 &&
    known.some(
      (row) =>
        row.authority!.toLowerCase() !== known[0].authority!.toLowerCase(),
    );
  const safeGroups = useMemo(() => {
    const byAddress = new Map<
      string,
      { safe: Address; rows: AuthorityRow[] }
    >();
    for (const row of rows) {
      if (!row.authority || !row.safe) continue;
      const key = row.authority.toLowerCase();
      const group = byAddress.get(key) ?? { safe: row.authority, rows: [] };
      group.rows.push(row);
      byAddress.set(key, group);
    }
    return [...byAddress.values()];
  }, [rows]);

  return (
    <>
      <section className="card p-5">
        <div>
          <span className="field-label">Account</span>
          <p className="mt-2 text-sm leading-relaxed text-smoke-700">
            {isRevnet
              ? "Revnets have no project owner. The project operator holds only the permissions granted at launch, and can pass that role on."
              : "The project NFT is ownership. Its project owner controls owner-only actions, either directly or through a Safe."}
          </p>
        </div>
        {authorityQuery.isLoading ? (
          <AccountGroupsSkeleton />
        ) : authorityQuery.isError ? (
          <p className="mt-4 text-sm text-red-700">
            Could not read project control.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {differs ? (
              <div className="callout callout-warning text-sm">
                {authorityLabel} differs by chain. Actions below are scoped to
                each matching account group so a change cannot silently target
                the wrong controller.
              </div>
            ) : null}
            {groups.map((group) => {
              const safeElsewhere =
                !group.safe &&
                !!group.authority &&
                rows.some(
                  (row) =>
                    !!row.safe &&
                    row.authority?.toLowerCase() ===
                      group.authority!.toLowerCase(),
                );
              return (
                <div
                  key={group.key}
                  className="rounded-xl border border-smoke-200 p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {group.rows.map((row) => (
                      <span
                        key={row.chainId}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-smoke-700"
                      >
                        <ChainIcon chainId={row.chainId} size={20} />
                        {row.name}
                      </span>
                    ))}
                  </div>
                  <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[7rem_1fr]">
                    <dt className="text-smoke-500">{authorityLabel}</dt>
                    <dd>
                      {group.authority ? (
                        <AddressLink
                          address={group.authority}
                          chainId={group.rows[0].chainId}
                          className="font-mono text-sm text-ink"
                          title={group.authority}
                        />
                      ) : (
                        <span className="text-smoke-500">Unknown</span>
                      )}
                    </dd>
                    <dt className="text-smoke-500">Type</dt>
                    <dd className="font-medium text-ink">
                      {safeElsewhere
                        ? "Safe Multisig (not deployed here yet)"
                        : group.accountType}
                    </dd>
                    {group.safe ? (
                      <>
                        <dt className="text-smoke-500">Policy</dt>
                        <dd className="font-medium text-ink">
                          Requires {group.safe.threshold} of{" "}
                          {group.safe.owners.length} signatures
                        </dd>
                        <dt className="text-smoke-500">Signers</dt>
                        <dd className="flex flex-wrap gap-x-2 gap-y-1">
                          {group.safe.owners.map((owner) => (
                            <AddressLink
                              key={owner}
                              address={owner}
                              chainId={group.rows[0].chainId}
                              className="font-mono text-sm text-ink"
                              title={owner}
                            />
                          ))}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                  {safeElsewhere && group.authority ? (
                    <DeploySafeButtons
                      safe={group.authority}
                      rows={group.rows}
                      onDone={() => authorityQuery.refetch()}
                    />
                  ) : null}
                  {group.authority &&
                  !safeElsewhere &&
                  (group.safe || group.accountType === "EOA") ? (
                    <TransferAuthorityFlow
                      rows={group.rows}
                      authority={group.authority}
                      isRevnet={isRevnet}
                      onDone={() => authorityQuery.refetch()}
                    />
                  ) : null}
                  {group.authority &&
                  !group.safe &&
                  !safeElsewhere &&
                  group.accountType === "Contract" ? (
                    <p className="mt-3 text-xs leading-relaxed text-smoke-500">
                      This authority is a non-Safe contract. Submit owner
                      actions through that contract’s governance or wallet
                      interface.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {safeGroups.map((group) => (
        <SafeQueueCard
          key={group.safe}
          safe={group.safe}
          chains={group.rows.map((row) => ({
            chainId: row.chainId,
            name: row.name,
          }))}
          authorityLabel={authorityLabel}
        />
      ))}

      {beforePermissions}

      <PermissionsAcrossChains
        deployments={deployments}
        authorityRows={rows}
        isRevnet={isRevnet}
      />
    </>
  );
}

function DeploySafeButtons({
  safe,
  rows,
  onDone,
}: {
  safe: Address;
  rows: AuthorityRow[];
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const deploy = async (row: AuthorityRow) => {
    setBusy(row.chainId);
    setMessage("Reading the Safe’s original deployment…");
    try {
      const creation = await fetchSafeCreation(safe);
      if (!creation)
        throw new Error("Could not read the Safe’s creation config.");
      setMessage(`Deploying the same Safe address on ${row.name}…`);
      await deploySafeSameAddress(row.chainId, creation, safe);
      setMessage(`Safe deployed on ${row.name}.`);
      onDone();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not deploy the Safe.",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3">
      <p className="text-xs leading-relaxed text-smoke-700">
        This is the same Safe address used on another chain, but its proxy is
        not deployed here yet. Replay its canonical creation to activate it.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {rows.map((row) => (
          <button
            key={row.chainId}
            type="button"
            onClick={() => deploy(row)}
            disabled={busy !== null}
            className="btn-secondary min-h-[36px] px-3 text-xs"
          >
            {busy === row.chainId ? "Deploying…" : `Deploy Safe on ${row.name}`}
          </button>
        ))}
      </div>
      {message ? (
        <p className="mt-2 text-xs text-smoke-700">{message}</p>
      ) : null}
    </div>
  );
}

function TransferAuthorityFlow({
  rows,
  authority,
  isRevnet,
  onDone,
}: {
  rows: AuthorityRow[];
  authority: Address;
  isRevnet: boolean;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const to = resolvedAddress(destination);
    if (!to) {
      setError("Enter a valid destination address or ENS name.");
      return;
    }
    if (!ack) return;
    setBusy(true);
    setError(null);
    try {
      const calls: AuthorityCall[] = rows.map((row) => {
        if (isRevnet) {
          return buildRevnetOperatorAuthorityCall({
            chainId: row.chainId,
            authority,
            revnetId: BigInt(row.projectId),
            operator: to,
          });
        }
        return buildProjectOwnershipAuthorityCall({
          chainId: row.chainId,
          authority,
          projectId: BigInt(row.projectId),
          destination: to,
        });
      });
      const result = await runAuthorityCalls({
        calls,
        onProgress: (progress) => setStatus(progress.message),
      });
      const queued = result.safeResults.filter(
        (item) => item.status === "queued",
      ).length;
      const waiting = result.safeResults.filter(
        (item) => item.status === "waiting",
      ).length;
      setStatus(
        queued || waiting
          ? `Your Safe action is recorded${queued ? `; ${queued} queued` : ""}${waiting ? `; ${waiting} awaiting more onchain approvals` : ""}.`
          : `${isRevnet ? "Project operator" : "Project ownership"} transferred on ${rows.length} chain${rows.length === 1 ? "" : "s"}.`,
      );
      onDone();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Could not transfer.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-secondary mt-4 min-h-[38px] px-4 text-sm"
      >
        {isRevnet ? "Transfer project operator" : "Transfer project ownership"}
      </button>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-smoke-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">
          {isRevnet ? "Transfer project operator" : "Transfer project ownership"}
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="text-xs text-smoke-700 hover:text-ink"
        >
          Cancel
        </button>
      </div>
      <div className="mt-3">
        <AddressField
          value={destination}
          onChange={(value) => {
            setDestination(value);
            setError(null);
          }}
          disabled={busy}
          placeholder={
            isRevnet
              ? "0x… new project operator (zero address relinquishes)"
              : "0x… new project owner"
          }
          ariaLabel={isRevnet ? "New project operator" : "New project owner"}
        />
      </div>
      <p className="mt-2 text-xs text-smoke-500">
        Applies on {rows.map((row) => row.name).join(", ")}.
      </p>
      <label className="mt-3 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3">
        <input
          type="checkbox"
          checked={ack}
          onChange={(event) => setAck(event.target.checked)}
          disabled={busy}
          className="mt-0.5 accent-red-600"
        />
        <span className="text-xs leading-relaxed text-red-700">
          {isRevnet
            ? destination.trim().toLowerCase() === zeroAddress
              ? "I understand that relinquishing the project operator role is permanent."
              : "I verified the new project operator. They receive every power attached to this role."
            : "I verified the new project owner. Transferring the project NFT hands over every owner-only power."}
        </span>
      </label>
      <button
        type="button"
        onClick={submit}
        disabled={busy || !ack || !destination.trim()}
        className="btn-primary mt-3 min-h-[42px] w-full text-sm"
      >
        {busy
          ? (status ?? "Preparing…")
          : isRevnet
            ? "Transfer project operator"
            : "Transfer project ownership"}
      </button>
      {status ? <p className="mt-2 text-xs text-smoke-700">{status}</p> : null}
      {error ? <ErrorNote message={error} /> : null}
    </div>
  );
}

function PermissionsAcrossChains({
  deployments,
  authorityRows,
  isRevnet,
}: {
  deployments: AuthorityDeployment[];
  authorityRows: AuthorityRow[];
  isRevnet: boolean;
}) {
  const chainIds = deployments.map((row) => row.chainId);
  const deploymentKey = deployments
    .map((row) => `${row.chainId}:${row.projectId}`)
    .join(",");
  const query = useQuery({
    queryKey: ["permissionHoldersAcrossDeployments", deploymentKey],
    enabled: deployments.some((row) => row.projectId > 0),
    staleTime: 30_000,
    queryFn: () => getPermissionHoldersAcrossDeployments(deployments),
  });
  const grants = useMemo(
    () => aggregateGrants(query.data ?? [], deployments),
    [deployments, query.data],
  );
  const [editing, setEditing] = useState<OperatorGrant | "new" | null>(null);

  return (
    <section className="card p-5">
      <span className="field-label">Permissions</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        {isRevnet
          ? "Every power the revnet’s project operator role currently holds, including any NFT powers granted at launch."
          : "Project operators authorized to act for the project owner. Each row shows exactly what is granted and on which chains."}
      </p>

      {query.isLoading ? (
        <ActionRowsSkeleton rows={4} label="Loading permissions" />
      ) : grants.length === 0 ? (
        <p className="mt-4 text-sm text-smoke-500">
          {isRevnet
            ? "No project operator permissions found."
            : "No project operators authorized yet."}
        </p>
      ) : (
        <div className="mt-4 divide-y divide-smoke-100">
          {grants.map((grant) => (
            <div key={grant.operator} className="py-4 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <AddressLink
                  address={grant.operator}
                  chainId={chainIds[0]}
                  className="font-mono text-sm text-ink"
                  title={grant.operator}
                />
                {grant.isRevnetOperator ? (
                  <span className="rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
                    Project operator
                  </span>
                ) : null}
                {grant.differs ? (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    Differs by chain
                  </span>
                ) : null}
              </div>
              <div className="mt-3 space-y-2">
                {grant.union.map((id) => {
                  const permission = permissionDefinition(id);
                  const onChains = grant.rows
                    .filter((row) => row.permissions.includes(id))
                    .map((row) => row.chainId as JBChainId);
                  return (
                    <div
                      key={id}
                      className="grid gap-1 sm:grid-cols-[13rem_1fr_auto] sm:gap-3"
                    >
                      <span className="text-sm font-medium text-ink">
                        {permission.label}
                        <span className="ml-1 font-mono text-[10px] text-smoke-500">
                          #{id}
                        </span>
                      </span>
                      <span className="text-xs leading-relaxed text-smoke-700">
                        {permission.description}
                      </span>
                      <span
                        className="flex items-center gap-1"
                        title="Granted on"
                      >
                        {onChains.map((chainId) => (
                          <ChainIcon
                            key={chainId}
                            chainId={chainId}
                            size={16}
                          />
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
              {!isRevnet ? (
                <button
                  type="button"
                  onClick={() => setEditing(grant)}
                  className="btn-secondary mt-4 min-h-[36px] px-3 text-xs"
                >
                  Edit permissions
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {!isRevnet ? (
        editing ? (
          <PermissionEditor
            grant={editing === "new" ? null : editing}
            deployments={deployments}
            authorityRows={authorityRows}
            onCancel={() => setEditing(null)}
            onDone={() => {
              setEditing(null);
              query.refetch();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="btn-secondary mt-4 min-h-[40px] px-4 text-sm"
          >
            + Add project operator
          </button>
        )
      ) : null}
    </section>
  );
}

function PermissionEditor({
  grant,
  deployments,
  authorityRows,
  onCancel,
  onDone,
}: {
  grant: OperatorGrant | null;
  deployments: AuthorityDeployment[];
  authorityRows: AuthorityRow[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const [operatorInput, setOperatorInput] = useState(grant?.operator ?? "");
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(grant?.union ?? []),
  );
  const [selectedChains, setSelectedChains] = useState<Set<number>>(
    () =>
      new Set(
        grant?.rows.map((row) => row.chainId) ??
          deployments.map((row) => row.chainId),
      ),
  );
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const operator = resolvedAddress(operatorInput);
    if (!operator || operator === zeroAddress) {
      setError("Enter a valid non-zero project operator address or ENS name.");
      return;
    }
    const chosen = deployments.filter((row) => selectedChains.has(row.chainId));
    if (!chosen.length) {
      setError("Choose at least one chain.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const calls: AuthorityCall[] = [];
      for (const deployment of chosen) {
        const authority = authorityRows.find(
          (row) => row.chainId === deployment.chainId,
        )?.authority;
        if (!authority)
          throw new Error(`Project owner is unknown on chain ${deployment.chainId}.`);
        const bitmap = (await clientFor(deployment.chainId).readContract({
          address:
            jbContractAddress["6"][JBCoreContracts.JBPermissions][
              deployment.chainId
            ],
          abi: jbPermissionsAbi,
          functionName: "permissionsOf",
          args: [operator, authority, BigInt(deployment.projectId)],
        })) as bigint;
        const unknownIds = decodePermissionBitmap(bitmap).filter(
          (id) => id > 39,
        );
        const finalIds = [...new Set([...selected, ...unknownIds])].sort(
          (a, b) => a - b,
        );
        calls.push(
          buildPermissionsAuthorityCall({
            chainId: deployment.chainId,
            authority,
            account: authority,
            operator,
            projectId: BigInt(deployment.projectId),
            permissionIds: finalIds,
            label: grant ? "Edit permissions" : "Add project operator",
          }),
        );
      }
      const result = await runAuthorityCalls({
        calls,
        onProgress: (progress) => setStatus(progress.message),
      });
      const queued = result.safeResults.filter(
        (item) => item.status === "queued",
      ).length;
      setStatus(
        queued
          ? `Queued on ${queued} Safe chain${queued === 1 ? "" : "s"}; co-sign and execute above.`
          : `Permissions updated on ${chosen.length} chain${chosen.length === 1 ? "" : "s"}.`,
      );
      onDone();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Could not update permissions.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 rounded-xl border border-smoke-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">
          {grant ? "Edit permissions" : "Add project operator"}
        </p>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs text-smoke-700 hover:text-ink"
        >
          Cancel
        </button>
      </div>

      <label className="mt-4 block">
        <span className="field-label">Project operator</span>
        <div className="mt-1.5">
          <AddressField
            value={operatorInput}
            onChange={(value) => {
              setOperatorInput(value);
              setError(null);
            }}
            disabled={busy || !!grant}
            ariaLabel="Project operator address"
          />
        </div>
      </label>

      <ChainPicker
        className="mt-4"
        label="Set on"
        rows={deployments.map((deployment) => ({
          chainId: deployment.chainId,
          name: JB_CHAINS[deployment.chainId]?.name ?? deployment.chainId,
        }))}
        selected={selectedChains}
        onChange={setSelectedChains}
        disabled={busy}
        rowClassName={() =>
          "flex cursor-pointer items-center gap-2 rounded-lg border border-smoke-200 px-3 py-2 text-sm"
        }
      />

      <div className="mt-4">
        <span className="field-label">All V6 permissions</span>
        <p className="mt-1 text-xs leading-relaxed text-smoke-500">
          Saving replaces this operator’s known permission set on every selected
          chain. Unrecognized future permission bits are preserved.
        </p>
        <div className="mt-3 max-h-[34rem] space-y-2 overflow-y-auto pr-1">
          {V6_PERMISSIONS.map((permission) => (
            <CheckRow
              key={permission.id}
              checked={selected.has(permission.id)}
              onToggle={() =>
                setSelected((current) => toggleInSet(current, permission.id))
              }
              disabled={busy}
              title={`${permission.label} #${permission.id}`}
              blurb={permission.description}
            />
          ))}
        </div>
      </div>

      <label className="mt-4 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3">
        <input
          type="checkbox"
          checked={ack}
          onChange={(event) => setAck(event.target.checked)}
          disabled={busy}
          className="mt-0.5 accent-red-600"
        />
        <span className="text-xs leading-relaxed text-red-700">
          I verified the operator address and every checked power. A malicious
          project operator can use these permissions against the project.
        </span>
      </label>

      <button
        type="button"
        onClick={submit}
        disabled={busy || !ack || !operatorInput.trim() || !selectedChains.size}
        className="btn-primary mt-3 min-h-[44px] w-full text-sm"
      >
        {busy
          ? (status ?? "Preparing…")
          : grant
            ? "Update permissions"
            : "Add project operator"}
      </button>
      {status ? <p className="mt-2 text-xs text-smoke-700">{status}</p> : null}
      {error ? <ErrorNote message={error} /> : null}
    </div>
  );
}
