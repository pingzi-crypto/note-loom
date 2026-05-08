export interface RepeatableInlineEntrySchema {
  entryLabel?: string;
  fieldNames: string[];
}

function uniqueFieldNames(fieldNames: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  fieldNames.forEach((fieldName) => {
    const trimmed = fieldName.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push(trimmed);
  });
  return result;
}

function normalizeTemplateLine(line: string): string {
  return line
    .trim()
    .replace(/^\s*>\s*/u, "")
    .replace(/^`/u, "")
    .replace(/`$/u, "")
    .trim();
}

function extractSchemaFromTemplateLine(line: string): RepeatableInlineEntrySchema | undefined {
  const normalized = normalizeTemplateLine(line);
  if (!/^\s*[-*+]\s+/u.test(normalized) || !/\[[^\]]+::[^\]]*\]/u.test(normalized)) {
    return undefined;
  }

  const withoutBullet = normalized.replace(/^\s*[-*+]\s+/, "");
  const inlineFieldIndex = withoutBullet.search(/\[[^\]]+::[^\]]*\]/u);
  const entryLabel = inlineFieldIndex > 0 ? withoutBullet.slice(0, inlineFieldIndex).trim() : undefined;
  const fieldNames = uniqueFieldNames(
    Array.from(withoutBullet.matchAll(/\[([^\]\r\n:]+)::[^\]]*\]/gu))
      .map((match) => match[1]?.trim() ?? "")
      .filter(Boolean)
  );

  return fieldNames.length > 0
    ? {
        entryLabel: entryLabel || undefined,
        fieldNames
      }
    : undefined;
}

export function extractRepeatableInlineEntrySchemasFromRawContent(
  rawContent: string | undefined
): RepeatableInlineEntrySchema[] | undefined {
  const schemas = (rawContent ?? "")
    .split(/\r?\n/)
    .map(extractSchemaFromTemplateLine)
    .filter((schema): schema is RepeatableInlineEntrySchema => schema !== undefined);

  return schemas.length > 0 ? schemas : undefined;
}

export function extractRepeatableInlineEntryLabelFromRawContent(rawContent: string | undefined): string | undefined {
  return extractRepeatableInlineEntrySchemasFromRawContent(rawContent)
    ?.find((schema) => schema.entryLabel?.trim())
    ?.entryLabel;
}
