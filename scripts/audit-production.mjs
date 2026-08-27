import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ELLIPTIC_ADVISORY =
  "https://github.com/advisories/GHSA-848j-6mx2-7j84";
const PARA_PACKAGES = [
  "@getpara/react-component-library",
  "@getpara/react-sdk-lite",
  "@getpara/wagmi-v2-connector",
  "@getpara/web-sdk",
];

// Para is not pinned to a version; it is pinned to a shape. Every Para package
// must move together, and the elliptic usage below must stay exactly the one
// audited under GHSA-848j-6mx2-7j84 (compressing a public key, never signing).
// A bump that keeps both passes; one that changes either fails closed.
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

if (process.argv.includes("--source-only")) {
  console.log("Para dependency and elliptic usage invariants verified.");
  process.exit(0);
}

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  env: process.env,
});

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(
    result.stderr || result.stdout || "npm audit returned no JSON.\n",
  );
  process.exit(1);
}

const vulnerabilities = report.vulnerabilities ?? {};
const memo = new Map();
const isScopedEllipticFinding = (name, active = new Set()) => {
  if (memo.has(name)) return memo.get(name);
  if (active.has(name)) return false;

  const vulnerability = vulnerabilities[name];
  if (!vulnerability || vulnerability.severity !== "low") return false;

  const nextActive = new Set(active).add(name);
  const allowed =
    vulnerability.via.length > 0 &&
    vulnerability.via.every((via) =>
      typeof via === "string"
        ? isScopedEllipticFinding(via, nextActive)
        : via.url === ELLIPTIC_ADVISORY && via.severity === "low",
    );
  memo.set(name, allowed);
  return allowed;
};

const unexpected = Object.keys(vulnerabilities).filter(
  (name) => !isScopedEllipticFinding(name),
);
if (unexpected.length > 0) {
  console.error("Unexpected production vulnerabilities:");
  for (const name of unexpected) {
    console.error(`- ${name}: ${vulnerabilities[name].severity}`);
  }
  process.exit(1);
}

if (Object.keys(vulnerabilities).length === 0) {
  console.log("Production dependency audit passed.");
} else {
  console.warn(
    "Production audit passed with one fail-closed Para exception: elliptic GHSA-848j-6mx2-7j84 has no patched release, and the installed Para code uses elliptic only to compress public keys, never to sign.",
  );
}
