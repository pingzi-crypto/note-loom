import {
  prefixRepeatableBullet,
  type RepeatableEntryParseResult
} from "./repeatable-entry-parser";
import { escapeInlineFieldRegExp } from "./dataview-inline-field-utils";

export interface GenericInlineFieldsParseContext {
  fieldNames?: string[];
  shouldStopAtLine?: (line: string) => boolean;
  truncateAtBoundary?: (value: string, currentLabel: string) => string;
}

export type GenericInlineFieldsParseResult = RepeatableEntryParseResult;

interface LabelMatch {
  fieldName: string;
  start: number;
  end: number;
}

interface ParsedInlineField {
  fieldName: string;
  value: string;
}

const escapeRegExp = escapeInlineFieldRegExp;

function normalizeRawLine(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .trim();
}

function normalizeValue(value: string): string {
  return value
    .replace(/^[，,。；;、\s]+/u, "")
    .replace(/^[-*+]\s+/u, "")
    .replace(/\]+$/u, "")
    .replace(/[，,；;]\s*$/u, "")
    .trim();
}

function buildLabelPattern(fieldNames: string[]): RegExp | undefined {
  const labels = fieldNames
    .map((fieldName) => fieldName.trim())
    .filter((fieldName) => fieldName.length > 0)
    .sort((left, right) => right.length - left.length)
    .map((fieldName) => escapeRegExp(fieldName));

  if (labels.length === 0) {
    return undefined;
  }

  return new RegExp(`(${labels.join("|")})(?:\\s*[:：]\\s*|\\s+|(?=\\S))`, "giu");
}

function collectLabelMatches(line: string, fieldNames: string[]): LabelMatch[] {
  const pattern = buildLabelPattern(fieldNames);
  if (!pattern) {
    return [];
  }

  const matches: LabelMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const fieldName = match[1] ?? "";
    const labelStart = match.index;
    matches.push({
      fieldName,
      start: labelStart,
      end: pattern.lastIndex
    });
  }
  return matches;
}

function parseLineFields(
  line: string,
  fieldNames: string[],
  options: {
    includeEmpty?: boolean;
    truncateAtBoundary?: (value: string, currentLabel: string) => string;
  } = {}
): ParsedInlineField[] {
  const normalizedLine = normalizeRawLine(line);
  if (!normalizedLine || /\[[^\]]+::[^\]]+\]/.test(normalizedLine)) {
    return [];
  }

  const matches = collectLabelMatches(normalizedLine, fieldNames);
  if (matches.length === 0) {
    return [];
  }

  return matches
    .map((match, index) => {
      const next = matches[index + 1];
      const rawValue = normalizedLine.slice(match.end, next?.start ?? normalizedLine.length);
      const value = normalizeValue(options.truncateAtBoundary?.(rawValue, match.fieldName) ?? rawValue);
      return { fieldName: match.fieldName, value };
    })
    .filter((field) => options.includeEmpty || field.value.length > 0);
}

function formatInlineFields(fields: ParsedInlineField[]): string {
  return `- ${fields.map((field) => `[${field.fieldName}:: ${field.value}]`).join(" ")}`;
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

function collectExistingInlineFieldMatches(
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
    /\[[^\]\r\n:]+::\s*\]\s*\r?\n\s*[-*+]\s+[^[\r\n]+\s+\[[^\]\r\n:]+::/u.test(content);
}

function parseExistingInlineFieldRows(content: string, fieldNames: string[]): string[] {
  if (fieldNames.length === 0 || !hasMalformedInlineFieldFragments(content)) {
    return [];
  }

  const normalizedContent = normalizeInlineFieldFragmentSyntax(content);
  const matches = collectExistingInlineFieldMatches(normalizedContent, fieldNames);
  if (matches.length < 2) {
    return [];
  }

  const rows: ParsedInlineField[][] = [];
  let pendingFields: ParsedInlineField[] = [];
  const primaryFieldName = fieldNames[0]?.trim() ?? "";
  const flushPending = (): void => {
    if (pendingFields.some((field) => field.value.trim().length > 0)) {
      rows.push(pendingFields);
    }
    pendingFields = [];
  };

  matches.forEach((match, index) => {
    const previous = matches[index - 1];
    const between = previous
      ? normalizeValue(normalizedContent.slice(previous.end, match.start).replace(/(?:^|\n)\s*[-*+]\s*/gu, " ").replace(/\]\s*$/u, ""))
      : "";
    const pendingLastField = pendingFields[pendingFields.length - 1];
    if (between && pendingLastField && pendingLastField.value.length === 0) {
      pendingLastField.value = between;
    }

    if (match.fieldName === primaryFieldName && pendingFields.length > 0) {
      flushPending();
    }

    pendingFields.push({
      fieldName: match.fieldName,
      value: match.value
    });
  });

  flushPending();
  return rows.map(formatInlineFields);
}

function parseLineToInlineFields(line: string, fieldNames: string[], context: GenericInlineFieldsParseContext = {}): string {
  const normalizedLine = normalizeRawLine(line);
  const fields = parseLineFields(line, fieldNames, {
    truncateAtBoundary: context.truncateAtBoundary
  });

  return fields.length > 0 ? formatInlineFields(fields) : prefixRepeatableBullet(normalizedLine);
}

function shouldSkipDefaultLine(line: string): boolean {
  return /^(#|>|```|---)/.test(line);
}

function parseLinesToInlineFieldRows(
  content: string,
  fieldNames: string[],
  context: GenericInlineFieldsParseContext = {}
): string[] {
  const existingInlineRows = parseExistingInlineFieldRows(content, fieldNames);
  if (existingInlineRows.length > 0) {
    return existingInlineRows;
  }

  const rows: string[] = [];
  let pendingFields: ParsedInlineField[] = [];
  let pendingRawLines: string[] = [];
  const primaryFieldName = fieldNames[0]?.trim() ?? "";
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !shouldSkipDefaultLine(line));
  const boundedLines: string[] = [];
  for (const line of lines) {
    if (context.shouldStopAtLine?.(line)) {
      break;
    }
    boundedLines.push(line);
  }
  const hasAnyParsedField = boundedLines.some((line) => parseLineFields(line, fieldNames, {
    includeEmpty: true,
    truncateAtBoundary: context.truncateAtBoundary
  }).length > 0);

  const flushPending = (): void => {
    if (pendingFields.length === 0) {
      return;
    }

    rows.push(
      pendingFields.length > 1
        ? formatInlineFields(pendingFields)
        : parseLineToInlineFields(pendingRawLines[0] ?? "", fieldNames)
    );
    pendingFields = [];
    pendingRawLines = [];
  };

  boundedLines
    .forEach((line) => {
      const parsedFields = parseLineFields(line, fieldNames, {
        includeEmpty: true,
        truncateAtBoundary: context.truncateAtBoundary
      });
      const parsedField = parsedFields[0];
      const canJoinSequentialField =
        parsedFields.length === 1 &&
        primaryFieldName.length > 0 &&
        fieldNames.includes(parsedField?.fieldName ?? "");

      if (!canJoinSequentialField || !parsedField) {
        const pendingLastField = pendingFields[pendingFields.length - 1];
        if (parsedFields.length === 0 && pendingLastField && pendingLastField.value.length === 0) {
          pendingLastField.value = normalizeValue(line);
          pendingRawLines[pendingRawLines.length - 1] = `${pendingRawLines[pendingRawLines.length - 1] ?? pendingLastField.fieldName} ${line}`;
          return;
        }
        flushPending();
        if (hasAnyParsedField && parsedFields.length === 0) {
          return;
        }
        rows.push(parseLineToInlineFields(line, fieldNames, context));
        return;
      }

      const startsNextRecord = parsedField.fieldName === primaryFieldName && pendingFields.length > 0;
      const duplicatesPendingField = pendingFields.some((field) => field.fieldName === parsedField.fieldName);
      if (startsNextRecord || duplicatesPendingField) {
        flushPending();
      }

      pendingFields.push(parsedField);
      pendingRawLines.push(line);
    });

  flushPending();
  return rows.filter((row) => row.length > 0);
}

export class GenericInlineFieldsParser {
  parse(content: string, context?: GenericInlineFieldsParseContext): GenericInlineFieldsParseResult {
    const fieldNames = context?.fieldNames ?? [];
    return {
      content: parseLinesToInlineFieldRows(content, fieldNames, context).join("\n"),
      warnings: []
    };
  }
}
