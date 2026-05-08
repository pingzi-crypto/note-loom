import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(projectRoot, "src");
const stylesPath = path.join(projectRoot, "styles.css");

const classTokenPattern = /(note-loom-[A-Za-z0-9_-]+|semantic-[A-Za-z0-9_-]+)/g;
const cssClassPattern = /\.(note-loom-[A-Za-z0-9_-]+|semantic-[A-Za-z0-9_-]+)/g;

const sourceExactIgnore = new Set([
  "note-loom-ribbon",
  "semantic-service",
  "semantic-match-service",
  "semantic-render-service"
]);

const sourcePrefixIgnore = [
  "note-loom-run-diff-action-",
  "note-loom-integrity-badge-"
];

const cssPrefixIgnore = [
  "note-loom-run-diff-action-"
];

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

function normalizeRelative(absolutePath) {
  return path.relative(projectRoot, absolutePath).replaceAll("\\", "/");
}

function extractMatches(content, pattern) {
  return [...content.matchAll(pattern)].map((match) => match[1]);
}

function shouldIgnoreSourceClass(token) {
  return sourceExactIgnore.has(token) || sourcePrefixIgnore.some((prefix) => token.startsWith(prefix));
}

function shouldIgnoreCssClass(token) {
  return cssPrefixIgnore.some((prefix) => token.startsWith(prefix));
}

function collectSourceClassUsage(files) {
  const usage = new Map();

  for (const absolutePath of files) {
    const content = readFileSync(absolutePath, "utf8");
    const tokens = extractMatches(content, classTokenPattern);
    const relativePath = normalizeRelative(absolutePath);

    for (const token of tokens) {
      if (shouldIgnoreSourceClass(token)) {
        continue;
      }

      const current = usage.get(token) ?? [];
      current.push(relativePath);
      usage.set(token, current);
    }
  }

  return usage;
}

function collectCssClasses() {
  const content = readFileSync(stylesPath, "utf8");
  return new Set(
    extractMatches(content, cssClassPattern).filter((token) => !shouldIgnoreCssClass(token))
  );
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function printGroup(title, entries) {
  console.error(title);
  entries.forEach((entry) => console.error(`- ${entry}`));
}

const sourceFiles = collectFiles(srcRoot, (absolutePath) => absolutePath.endsWith(".ts"));
const cssClasses = collectCssClasses();
const sourceUsage = collectSourceClassUsage(sourceFiles);
const sourceClasses = new Set(sourceUsage.keys());

const cssOnly = [...cssClasses]
  .filter((token) => !sourceClasses.has(token))
  .sort((left, right) => left.localeCompare(right, "en"));

const sourceOnly = [...sourceClasses]
  .filter((token) => !cssClasses.has(token))
  .map((token) => `${token} <- ${uniqueSorted(sourceUsage.get(token) ?? []).join(", ")}`)
  .sort((left, right) => left.localeCompare(right, "en"));

if (cssOnly.length > 0 || sourceOnly.length > 0) {
  console.error("Class audit failed.");
  console.error(
    `Scanned ${cssClasses.size} CSS classes and ${sourceClasses.size} source-side class tokens after ignore filters.`
  );

  if (cssOnly.length > 0) {
    printGroup("CSS-only classes:", cssOnly);
  }

  if (sourceOnly.length > 0) {
    printGroup("Source-side tokens without CSS selector:", sourceOnly);
  }

  process.exit(1);
}

console.log(
  `Class audit passed. Scanned ${cssClasses.size} CSS classes and ${sourceClasses.size} source-side class tokens after ignore filters.`
);
