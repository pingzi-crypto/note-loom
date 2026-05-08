import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(projectRoot, "docs");
const uiRoot = path.join(projectRoot, "src", "ui");

const requiredDocs = [
  "02-前端交互与页面定义.md",
  "10-Obsidian官方风格改造指导.md",
  "15-UI实现入口与验收Gate.md",
  "16-UI变更检查模板.md",
  "18-UI共享骨架与复用对照表.md",
  path.join("ui-gate-records", "README.md")
];

const directSettingAllowlist = new Set([
  "src/ui/ui-entry.ts",
  "src/ui/settings-tab.ts"
]);

function collectFiles(dir, predicate) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const absolutePath = path.join(dir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      results.push(...collectFiles(absolutePath, predicate));
      continue;
    }
    if (predicate(absolutePath)) {
      results.push(absolutePath);
    }
  }
  return results;
}

function fail(message, details = []) {
  console.error(`UI gate failed: ${message}`);
  details.forEach((detail) => console.error(`- ${detail}`));
  process.exit(1);
}

function resolveRecordArg(argv) {
  const recordFlagIndex = argv.findIndex((arg) => arg === "--record");
  if (recordFlagIndex >= 0) {
    return argv[recordFlagIndex + 1] ?? "";
  }
  return argv[0] ?? "";
}

const recordArg = resolveRecordArg(process.argv.slice(2));

const missingDocs = requiredDocs
  .map((relativePath) => path.join(docsRoot, relativePath))
  .filter((absolutePath) => !existsSync(absolutePath))
  .map((absolutePath) => path.relative(projectRoot, absolutePath));

if (missingDocs.length > 0) {
  fail("missing required UI gate docs", missingDocs);
}

const uiFiles = collectFiles(uiRoot, (absolutePath) => absolutePath.endsWith(".ts"));
const forbiddenNewSetting = [];
const forbiddenInlineStyle = [];

for (const absolutePath of uiFiles) {
  const relativePath = path.relative(projectRoot, absolutePath).replaceAll("\\", "/");
  const source = readFileSync(absolutePath, "utf8");

  if (source.includes("new Setting(") && !directSettingAllowlist.has(relativePath)) {
    forbiddenNewSetting.push(relativePath);
  }

  const inlineStylePatterns = [
    /\.style\./,
    /setAttribute\(\s*["']style["']/,
    /\{\s*style\s*:/,
    /style\s*=/
  ];
  if (inlineStylePatterns.some((pattern) => pattern.test(source))) {
    forbiddenInlineStyle.push(relativePath);
  }
}

if (forbiddenNewSetting.length > 0) {
  fail(
    "direct `new Setting(...)` is only allowed in shared UI entrypoints or heading-only settings files",
    forbiddenNewSetting
  );
}

if (forbiddenInlineStyle.length > 0) {
  fail("inline visual style was found in UI TypeScript files", forbiddenInlineStyle);
}

if (recordArg) {
  const recordPath = path.resolve(projectRoot, recordArg);
  const allowedRecordRoot = path.join(docsRoot, "ui-gate-records");
  const normalizedAllowedRoot = path.normalize(`${allowedRecordRoot}${path.sep}`);
  const normalizedRecordPath = path.normalize(recordPath);

  if (!normalizedRecordPath.startsWith(normalizedAllowedRoot) || !existsSync(recordPath)) {
    fail("record file must exist under docs/ui-gate-records", [recordArg]);
  }

  const recordContent = readFileSync(recordPath, "utf8");
  const uncheckedBoxes = [...recordContent.matchAll(/^- \[ \].*$/gm)].map((match) => match[0]);
  if (uncheckedBoxes.length > 0) {
    fail("record file still contains unchecked checklist items", uncheckedBoxes);
  }
}

console.log("UI gate passed.");
