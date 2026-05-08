import {
  dedupeInlineFieldNames,
  normalizeRepeatableInlineFieldValue
} from "./dataview-inline-field-utils";

export interface RepeatableInlineRepairContext {
  fieldNames?: string[];
  entryLabel?: string;
  entrySchemas?: Array<{
    entryLabel?: string;
    fieldNames: string[];
  }>;
}

interface RepairedInlineEntry {
  entryText: string;
  fields: Map<string, string>;
  schemaFieldNames: string[];
}

const normalizeValue = normalizeRepeatableInlineFieldValue;
const uniqueFieldNames = dedupeInlineFieldNames;

function hasAnyFieldValue(entry: RepairedInlineEntry): boolean {
  return [...entry.fields.values()].some((value) => value.trim().length > 0) || entry.entryText.trim().length > 0;
}

function appendToLastEmptyField(entry: RepairedInlineEntry, fieldNames: string[], value: string): boolean {
  const targetFieldName = [...fieldNames]
    .reverse()
    .find((fieldName) => (entry.fields.get(fieldName) ?? "").trim().length === 0);
  if (!targetFieldName) {
    return false;
  }

  entry.fields.set(targetFieldName, normalizeValue(value));
  return true;
}

function formatEntry(entry: RepairedInlineEntry): string {
  const inlineFields = entry.schemaFieldNames
    .map((fieldName) => `[${fieldName}:: ${entry.fields.get(fieldName) ?? ""}]`)
    .join(" ");
  return entry.entryText
    ? `- ${entry.entryText}${inlineFields ? ` ${inlineFields}` : ""}`
    : `- ${inlineFields}`.trim();
}

function normalizeInlineFieldFragmentSyntax(content: string): string {
  return content
    .replace(/\[\s*\[([^\]\r\n:]+)::\s*:?\s*([^\]]*)\]\s*(?:\[\]\s*)*/gu, (_match, fieldName: string, value: string) =>
      `[${fieldName.trim()}:: ${normalizeValue(value)}] `
    )
    .replace(/\[([^\]\r\n:]+)::\s*:\s*([^\]]*)\]/gu, (_match, fieldName: string, value: string) =>
      `[${fieldName.trim()}:: ${normalizeValue(value)}]`
    )
    .replace(/[ \t]+$/gm, "");
}

function collectInlineFieldMatches(
  content: string,
  fieldNames: string[]
): Array<{ fieldName: string; value: string; start: number; end: number }> {
  const allowedFieldNames = new Set(fieldNames.map((fieldName) => fieldName.toLocaleLowerCase()));
  const matches: Array<{ fieldName: string; value: string; start: number; end: number }> = [];
  const pattern = /\[([^\]\r\n:]+)::\s*([^\]]*)\]/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const fieldName = (match[1] ?? "").trim();
    if (!allowedFieldNames.has(fieldName.toLocaleLowerCase())) {
      continue;
    }

    matches.push({
      fieldName,
      value: normalizeValue(match[2] ?? ""),
      start: match.index,
      end: pattern.lastIndex
    });
  }
  return matches;
}

function hasMalformedInlineFieldFragments(content: string): boolean {
  return /\[\s*\[[^\]\r\n:]+::/u.test(content) ||
    /\[\]\s*\[/u.test(content) ||
    /\[[^\]\r\n:]+::\s*:/u.test(content) ||
    /\[[^\]\r\n:]+::\s*\]\s*\r?\n\s*[-*+]\s+[^\[\r\n]+\s+\[[^\]\r\n:]+::/u.test(content);
}

export function parseExistingInlineFieldContent(
  content: string,
  context: RepeatableInlineRepairContext
): string | undefined {
  const fieldNames = uniqueFieldNames([
    ...(context.fieldNames ?? []),
    ...(context.entrySchemas?.flatMap((schema) => schema.fieldNames) ?? [])
  ]);
  if (fieldNames.length === 0 || !hasMalformedInlineFieldFragments(content)) {
    return undefined;
  }

  const normalizedContent = normalizeInlineFieldFragmentSyntax(content);
  const matches = collectInlineFieldMatches(normalizedContent, fieldNames);
  if (matches.length === 0) {
    return undefined;
  }

  const rows: RepairedInlineEntry[] = [];
  let current: RepairedInlineEntry | undefined;
  const primaryFieldName = fieldNames[0];

  const flush = (): void => {
    if (!current) {
      return;
    }
    if (hasAnyFieldValue(current)) {
      rows.push(current);
    }
    current = undefined;
  };

  matches.forEach((match, index) => {
    const previous = matches[index - 1];
    const between = previous
      ? normalizeValue(normalizedContent.slice(previous.end, match.start).replace(/(?:^|\n)\s*[-*+]\s*/gu, " ").replace(/\]\s*$/u, ""))
      : "";
    if (current && between) {
      appendToLastEmptyField(current, current.schemaFieldNames, between);
    }

    if (current && match.fieldName === primaryFieldName && hasAnyFieldValue(current)) {
      flush();
    }

    if (!current) {
      flush();
      current = {
        entryText: "",
        fields: new Map(fieldNames.map((fieldName) => [fieldName, ""])),
        schemaFieldNames: fieldNames
      };
    }

    current.fields.set(match.fieldName, match.value);
  });

  flush();
  if (rows.length === 0) {
    return undefined;
  }

  return rows.map(formatEntry).join("\n");
}

export function repairRepeatableInlineFieldDraft(
  content: string,
  fieldNames: string[],
  context: Pick<RepeatableInlineRepairContext, "entryLabel" | "entrySchemas"> = {}
): string | undefined {
  if (context.entryLabel?.trim() || (context.entrySchemas ?? []).some((schema) => schema.entryLabel?.trim())) {
    return undefined;
  }

  return parseExistingInlineFieldContent(content, { fieldNames, ...context });
}
