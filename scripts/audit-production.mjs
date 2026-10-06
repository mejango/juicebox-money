import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const PARA_PACKAGES = [
  "@getpara/react-component-library",
  "@getpara/react-sdk-lite",
  "@getpara/wagmi-v2-connector",
  "@getpara/web-sdk",
];

// Advisories with no patched release that reach production only through Para.
// Each is allowed by its advisory id at the severity it was audited at, and
// only while the Para source checks below still match that audit.
const PARA_ADVISORIES = new Map([
  ["https://github.com/advisories/GHSA-848j-6mx2-7j84", {
    severity: "low",
    note: "elliptic GHSA-848j-6mx2-7j84, which Para uses only to compress public keys, never to sign",
  }],
  // jango ruled on 2026-10-05 that Para's audit findings do not block merges
  // until Signa replaces Para. This entry goes when Para does.
  ["https://github.com/advisories/GHSA-86w9-cpqp-85rv", {
    severity: "high",
    note: "node-forge GHSA-86w9-cpqp-85rv, which Para never uses to verify a signature",
  }],
]);

// GHSA-86w9-cpqp-85rv is in node-forge's RSA PKCS#1 v1.5 signature
// verification, which node-forge runs only from an RSA key's verify method:
// called directly, or to check an X.509 certificate, a certification request
// or a TLS server. Para does none of these. It generates and restores an RSA
// key pair, unwraps key shares with RSA-OAEP, converts keys to and from PEM,
// encrypts with AES-CBC, hashes with SHA-256 and draws random bytes. These are
// the Para files that import node-forge and the forge APIs each one calls, as
// audited on Para 3.15.0.
const PARA_CORE_FORGE_APIS = ["jsbn.BigInteger", "pki.setRsaPrivateKey", "pki.setRsaPublicKey"];
const PARA_CRYPTOGRAPHY_FORGE_APIS = [
  "cipher.createCipher",
  "cipher.createDecipher",
  "md.sha256.create",
  "pki.privateKeyFromPem",
  "pki.privateKeyToPem",
  "pki.publicKeyFromPem",
  "pki.publicKeyToRSAPublicKeyPem",
  "pki.rsa.generateKeyPair",
  "random.createInstance",
  "random.getBytesSync",
  "util.bytesToHex",
  "util.createBuffer",
  "util.hexToBytes",
];
const PARA_NODE_FORGE_USAGE = new Map([
  ["core-sdk/dist/cjs/ParaCore.js", PARA_CORE_FORGE_APIS],
  ["core-sdk/dist/esm/ParaCore.js", PARA_CORE_FORGE_APIS],
  ["core-sdk/dist/cjs/cryptography/utils.js", PARA_CRYPTOGRAPHY_FORGE_APIS],
  ["core-sdk/dist/esm/cryptography/utils.js", PARA_CRYPTOGRAPHY_FORGE_APIS],
  ["core-sdk/dist/cjs/shares/KeyContainer.js", ["random.getBytesSync"]],
  ["core-sdk/dist/esm/shares/KeyContainer.js", ["random.getBytesSync"]],
  ["web-sdk/dist/cryptography/webAuth.js", [
    "jsbn.BigInteger",
    "pki.publicKeyToPem",
    "pki.setRsaPublicKey",
    "util.createBuffer",
  ]],
]);
// The only production packages that may depend on node-forge: the two whose
// files are listed above.
const NODE_FORGE_DEPENDENTS = ["node_modules/@getpara/core-sdk", "node_modules/@getpara/web-sdk"];
const FORGE_IMPORTS = [
  'import forge from "node-forge";',
  'import * as forge from "node-forge";',
  'var forge = __toESM(require("node-forge"));',
];
// Para's names for parts of the forge module, and the paths they stand for.
const FORGE_ALIASES = new Map([
  ["const { pki, jsbn } = forge;", { pki: "forge.pki", jsbn: "forge.jsbn" }],
  ["const rsa = forge.pki.rsa;", { rsa: "forge.pki.rsa" }],
]);

// The forge APIs a file calls, or null when it reaches node-forge any other
// way: a second import, an unknown alias, or the module passed on whole.
const forgeApisOf = (source) => {
  // The CommonJS build names the module import_node_forge and reads its default export.
  let code = source.replace(/\bimport_node_forge(?:\.default)?\b/g, "forge");
  const forgeImport = FORGE_IMPORTS.find((statement) => code.includes(statement));
  if (!forgeImport || code.split("node-forge").length !== 2) return null;
  code = code.replace(forgeImport, "");
  for (const [declaration, aliases] of FORGE_ALIASES) {
    if (!code.includes(declaration)) continue;
    code = code.replace(declaration, "");
    for (const [alias, path] of Object.entries(aliases)) {
      code = code.replace(new RegExp(`(?<![\\w$.])${alias}\\.`, "g"), `${path}.`);
    }
  }
  const apis = [...code.matchAll(/(?<![\w$.])forge\b((?:\.[A-Za-z_$][\w$]*)*)/g)]
    .map(([, members]) => members.slice(1));
  return apis.includes("") ? null : new Set(apis);
};

// Para is not pinned to a version; it is pinned to a shape. Every Para package
// must move together, and Para's elliptic and node-forge usage below must stay
// exactly what was audited under each advisory. A bump that keeps all of it
// passes; one that changes any of it fails closed.
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const paraVersions = new Set(PARA_PACKAGES.map((dependency) => packageJson.dependencies?.[dependency]));
if (paraVersions.size !== 1 || paraVersions.has(undefined)) {
  throw new Error(`Para packages must share one exact version; found ${[...paraVersions].join(", ")}.`);
}
const [paraVersion] = paraVersions;
if (!/^\d+\.\d+\.\d+$/.test(paraVersion)) {
  throw new Error(`Para packages must be pinned to an exact version, not ${paraVersion}.`);
}

const paraCoreRoot = resolve(dirname(require.resolve("@getpara/core-sdk")), "../..");
const paraCore = JSON.parse(readFileSync(resolve(paraCoreRoot, "package.json"), "utf8"));
if (paraCore.version !== paraVersion) {
  throw new Error(`@getpara/core-sdk must resolve to ${paraVersion}; found ${paraCore.version}.`);
}

const formattingPath = resolve(paraCoreRoot, "dist/esm/utils/formatting.js");
const formattingSource = readFileSync(formattingPath, "utf8");
if (
  !formattingSource.includes('import elliptic from "elliptic"') ||
  !formattingSource.includes('new elliptic.ec("secp256k1")') ||
  !formattingSource.includes(
    'secp256k1.keyFromPublic(pubkey).getPublic(true, "array")',
  ) ||
  (formattingSource.match(/\bsecp256k1\./g)?.length ?? 0) !== 1 ||
  formattingSource.includes(".sign(") ||
  formattingSource.includes("keyFromPrivate")
) {
  throw new Error(
    "Para's elliptic usage changed. Reassess GHSA-848j-6mx2-7j84 before releasing.",
  );
}

// Every Para file is read: one that imports node-forge must be an audited file
// calling exactly its audited APIs, and none may read a member named verify,
// the way node-forge's signature verification is reached.
const paraRoot = dirname(paraCoreRoot);
const forgeImporters = new Set();
const changedForgeFiles = new Set();
for (const entry of readdirSync(paraRoot, { recursive: true, withFileTypes: true })) {
  if (entry.isDirectory() || !/\.[cm]?js$/.test(entry.name)) continue;
  const path = join(entry.parentPath, entry.name);
  const file = relative(paraRoot, path);
  const source = readFileSync(path, "utf8");
  if (/\.verify\b|\[\s*["'`]verify["'`]\s*\]/.test(source)) changedForgeFiles.add(file);
  if (!source.includes("node-forge")) continue;
  forgeImporters.add(file);
  const audited = PARA_NODE_FORGE_USAGE.get(file);
  const apis = forgeApisOf(source);
  if (!audited || !apis || apis.size !== audited.length || !audited.every((api) => apis.has(api))) {
    changedForgeFiles.add(file);
  }
}
for (const file of PARA_NODE_FORGE_USAGE.keys()) {
  if (!forgeImporters.has(file)) changedForgeFiles.add(file);
}
if (changedForgeFiles.size > 0) {
  throw new Error(
    `Para's node-forge usage changed in ${[...changedForgeFiles].sort().join(", ")}. Reassess GHSA-86w9-cpqp-85rv before releasing.`,
  );
}

const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
const nodeForgeDependents = Object.entries(lockfile.packages ?? {})
  .filter(([, entry]) => !entry.dev && ["dependencies", "optionalDependencies", "peerDependencies"]
    .some((field) => Object.hasOwn(entry[field] ?? {}, "node-forge")))
  .map(([path]) => path)
  .sort();
if (nodeForgeDependents.join() !== NODE_FORGE_DEPENDENTS.join()) {
  throw new Error(
    `The production packages that depend on node-forge changed to: ${nodeForgeDependents.join(", ") || "none"}. Reassess GHSA-86w9-cpqp-85rv before releasing.`,
  );
}

if (process.argv.includes("--source-only")) {
  console.log("Para dependency, elliptic and node-forge usage invariants verified.");
  process.exit(0);
}

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  env: process.env,
});

// npm uses exit 1 for vulnerability findings as well as operational failures.
// Only a complete report can distinguish those; an error JSON is never clean.
if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
  console.error("Production audit could not run to completion. No audit result was verified.");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(
    result.stderr || result.stdout || "npm audit returned no JSON.\n",
  );
  process.exit(1);
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const severities = ["info", "low", "moderate", "high", "critical"];
const vulnerabilities = report?.vulnerabilities;
const counts = report?.metadata?.vulnerabilities;
if (
  !isRecord(report) || Object.hasOwn(report, "error") || report.auditReportVersion !== 2 ||
  !isRecord(vulnerabilities) || !isRecord(counts) ||
  ![...severities, "total"].every((severity) => Number.isInteger(counts[severity]) && counts[severity] >= 0) ||
  Object.values(vulnerabilities).some((vulnerability) =>
    !isRecord(vulnerability) || !severities.includes(vulnerability.severity) || !Array.isArray(vulnerability.via) ||
    vulnerability.via.some((via) => typeof via !== "string" &&
      (!isRecord(via) || typeof via.url !== "string" || !severities.includes(via.severity)))) ||
  counts.total !== Object.keys(vulnerabilities).length ||
  severities.some((severity) => counts[severity] !==
    Object.values(vulnerabilities).filter((vulnerability) => vulnerability.severity === severity).length) ||
  (result.status === 1 && counts.total === 0)
) {
  console.error("npm audit did not return a complete, consistent vulnerability report. No audit result was verified.");
  process.exit(1);
}

const rank = (severity) => severities.indexOf(severity);
const memo = new Map();
// The Para advisories a finding reaches, or null when any of its paths leads
// to another advisory, or when npm rates it above the most severe of them.
// npm can rate a dependent below them: @getpara/react-core is low although
// it reaches node-forge.
const paraAdvisoriesOf = (name, active = new Set()) => {
  if (memo.has(name)) return memo.get(name);
  const vulnerability = vulnerabilities[name];
  if (!vulnerability || active.has(name) || vulnerability.via.length === 0) return null;

  const nextActive = new Set(active).add(name);
  let reached = new Set();
  for (const via of vulnerability.via) {
    const advisories = typeof via === "string"
      ? paraAdvisoriesOf(via, nextActive)
      : PARA_ADVISORIES.get(via.url)?.severity === via.severity ? [via.url] : null;
    if (!advisories) {
      reached = null;
      break;
    }
    for (const advisory of advisories) reached.add(advisory);
  }
  if (reached && rank(vulnerability.severity) >
    Math.max(...[...reached].map((advisory) => rank(PARA_ADVISORIES.get(advisory).severity)))) {
    reached = null;
  }
  memo.set(name, reached);
  return reached;
};

const unexpected = Object.keys(vulnerabilities).filter(
  (name) => !paraAdvisoriesOf(name),
);
if (unexpected.length > 0) {
  console.error("Unexpected production vulnerabilities:");
  for (const name of unexpected) {
    console.error(`- ${name}: ${vulnerabilities[name].severity}`);
  }
  process.exit(1);
}

const excepted = new Set(Object.keys(vulnerabilities).flatMap((name) => [...paraAdvisoriesOf(name)]));
if (excepted.size === 0) {
  console.log("Production dependency audit passed.");
} else {
  const notes = [...PARA_ADVISORIES].filter(([advisory]) => excepted.has(advisory)).map(([, { note }]) => note);
  console.warn(
    `Production audit passed with fail-closed Para exceptions for advisories with no patched release: ${notes.join("; ")}.`,
  );
}
