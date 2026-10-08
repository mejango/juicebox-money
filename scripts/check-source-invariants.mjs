import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

const failures = [];
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function sourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(new URL(`../${root}`, import.meta.url), {
    withFileTypes: true,
  })) {
    const relative = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(relative));
    else if ([".ts", ".tsx", ".js", ".jsx"].includes(extname(entry.name))) {
      files.push(relative);
    }
  }
  return files;
}

for (const path of sourceFiles("src")) {
  const source = read(path);

  if (/from\s+["']viem\/chains["']/.test(source)) {
    failures.push(
      `${path}: production code must use the SDK's supported chain definitions, not the all-chain viem barrel`,
    );
  }
  if (/\bas\s+any\s*[\),;\]}]|:\s*any\s*[,)=;]/.test(source)) {
    failures.push(
      `${path}: production code must narrow unknown values or use a precise boundary type instead of any`,
    );
  }
}

if (read("src/app/globals.css").includes("tailwind.config.ts")) {
  failures.push("src/app/globals.css: Tailwind must load the warning-free ESM config");
}

const safeQueue = read("src/components/project/SafeQueueCard.tsx");
const safeRelayr = read("src/lib/safe-relayr.ts");
for (const method of ["prepare", "fund", "check"]) {
  if (!safeQueue.includes(`.${method}({`)) {
    failures.push(`SafeQueueCard must delegate ${method} to the shared Safe Relayr controller`);
  }
}
if (!safeRelayr.includes("createSafeRelayrController({") ||
    !safeRelayr.includes("@bananapus/nana-sdk-core/review/safe-relayr")) {
  failures.push("Safe Relayr lifecycle decisions must use nana-sdk-core's shared controller");
}
for (const forbidden of ["relayrPostBundle", "relayrPay(", "relayrPoll(", "deadlineSoon", "assertFrozenBatchRow"]) {
  if (safeQueue.includes(forbidden)) {
    failures.push(`SafeQueueCard must not own ${forbidden}; use the shared Safe Relayr lifecycle`);
  }
}

// Cross-client rules have one SDK owner; these files are compatibility adapters.
const rpcTransport = read("src/lib/jbcenter-rpc.ts");
if (!rpcTransport.includes("createPacedJBCenterLimiter()") ||
    !/limiter: typeof window === ["']undefined["'] \? undefined : browserLimiter/.test(rpcTransport) ||
    rpcTransport.includes("createPacedRpcFetch")) {
  failures.push("Browser RPC pacing must use the shared SDK provider limiter before timeout creation");
}

const safeConnector = read("src/lib/safe-connector.ts");
for (const name of ["readSafeAppExecution", "requireSafeProposalSuccess", "SAFE_PROPOSAL_UNCONFIRMED", "SAFE_PROPOSAL_AWAITING", "heldCall", "findPendingSafeAppProposal", "lookAtSafeProposal", "watchSafeProposal", "atOnceExecution", "chainAnswer", "reportedSafeExecution"]) {
  if (!new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\} from ['"]@bananapus/nana-sdk-core/safe-service['"]`, "s").test(safeConnector)) {
    failures.push(`Safe connector must re-export SDK ${name}`);
  }
}

const transactionMessage = read("src/lib/transaction-message.ts");
if (!/^export \{ transactionMessage \} from ["']@bananapus\/nana-sdk-core\/review["'];?\s*$/.test(transactionMessage)) {
  failures.push("Transaction presentation must re-export the shared SDK owner");
}

const safeTx = read("src/hooks/useSafeTx.ts");
const reviewedWrite = read("src/lib/contract-write.ts");
if (!reviewedWrite.includes("beforeSend: () => {") || !reviewedWrite.includes("captureWalletContext") || !safeTx.includes("chainId: reviewed.chainId")) {
  failures.push("Safe transaction writes must use the SDK final guard and send the reviewed chain explicitly");
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log("Source build invariants verified.");
