export type FrontmatterValue = string | number | boolean;

interface FrontmatterEntry {
  key: string;
  lines: string[];
}

function serializeYamlValue(value: FrontmatterValue): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
}

function matchTopLevelKey(line: string): string | null {
  if (/^\s/.test(line)) {
    return null;
  }

  const separatorIndex = line.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  return line.slice(0, separatorIndex).trim() || null;
}

function parseFrontmatterEntries(block: string): {
  preamble: string[];
  entries: FrontmatterEntry[];
} {
  const preamble: string[] = [];
  const entries: FrontmatterEntry[] = [];
  let currentEntry: FrontmatterEntry | null = null;

  for (const line of block.split(/\r?\n/)) {
    const nextKey = matchTopLevelKey(line);
    if (nextKey) {
      if (currentEntry) {
        entries.push(currentEntry);
      }
      currentEntry = {
        key: nextKey,
        lines: [line]
      };
      continue;
    }

    if (currentEntry) {
      currentEntry.lines.push(line);
      continue;
    }

    preamble.push(line);
  }

  if (currentEntry) {
    entries.push(currentEntry);
  }

  return { preamble, entries };
}

function extractFrontmatterEntries(content: string): FrontmatterEntry[] {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return [];
  }

  return parseFrontmatterEntries(match[1] ?? "").entries;
}

export function hasFrontmatter(content: string): boolean {
  return content.startsWith("---\n") || content.startsWith("---\r\n");
}

export function resolveExistingFrontmatterKey(
  content: string,
  candidates: string[],
  fallback: string
): string {
  const candidateSet = new Set(candidates);
  const existingEntry = extractFrontmatterEntries(content).find((entry) => candidateSet.has(entry.key));
  return existingEntry?.key ?? fallback;
}

export function mergeFrontmatter(content: string, fields: Record<string, FrontmatterValue>): string {
  const normalizedFields = Object.entries(fields).filter(([, value]) => {
    if (typeof value === "string") {
      return value.length > 0;
    }

    return true;
  });

  if (normalizedFields.length === 0) {
    return content;
  }

  if (!hasFrontmatter(content)) {
    const lines = normalizedFields.map(([key, value]) => `${key}: ${serializeYamlValue(value)}`);
    return `---\n${lines.join("\n")}\n---\n\n${content}`;
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    const lines = normalizedFields.map(([key, value]) => `${key}: ${serializeYamlValue(value)}`);
    return `---\n${lines.join("\n")}\n---\n\n${content}`;
  }

  const existingBlock = match[1] ?? "";
  const body = content.slice(match[0].length);
  const { preamble, entries } = parseFrontmatterEntries(existingBlock);
  const entryMap = new Map(entries.map((entry) => [entry.key, entry] as const));
  const orderedKeys = entries.map((entry) => entry.key);

  for (const [key, value] of normalizedFields) {
    const nextEntry: FrontmatterEntry = {
      key,
      lines: [`${key}: ${serializeYamlValue(value)}`]
    };

    if (!entryMap.has(key)) {
      orderedKeys.push(key);
    }

    entryMap.set(key, nextEntry);
  }

  const mergedLines = [...preamble];
  orderedKeys.forEach((key) => {
    const entry = entryMap.get(key);
    if (!entry) {
      return;
    }
    mergedLines.push(...entry.lines);
  });

  return `---\n${mergedLines.join("\n")}\n---\n\n${body}`;
}
