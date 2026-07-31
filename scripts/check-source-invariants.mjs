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

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log("Source build invariants verified.");
