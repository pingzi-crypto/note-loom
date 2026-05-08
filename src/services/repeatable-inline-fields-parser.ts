import {
  prefixRepeatableBullet,
  runRepeatableEntryParser,
  type RepeatableEntryParseResult
} from "./repeatable-entry-parser";
import {
  parseExistingInlineFieldContent,
  repairRepeatableInlineFieldDraft
} from "./repeatable-inline-repair";
import {
  dedupeInlineFieldNames,
  escapeInlineFieldRegExp,
  normalizeRepeatableInlineFieldValue
} from "./dataview-inline-field-utils";
import {
  resolveRepeatableSchemaIndex,
  scoreRepeatableParsedEntry
} from "./repeatable-inline-schema-scoring";
import {
  matchEmbeddedTimePairEntry,
  matchEmbeddedTimeRangeEntry,
  matchLeadingTimeRangeEntry
} from "./repeatable-inline-time-entry";
import { buildRepeatableInlineEntryWarnings } from "./repeatable-inline-warnings";

export { repairRepeatableInlineFieldDraft } from "./repeatable-inline-repair";

export interface RepeatableInlineFieldsParseContext {
  fieldNames?: string[];
  entryLabel?: string;
  entrySchemas?: Array<{
    entryLabel?: string;
    fieldNames: string[];
  }>;
  fieldAliases?: Record<string, string[]>;
  sectionLabels?: string[];
  stopLabels?: string[];
  shouldStopAtLine?: (line: string) => boolean;
  truncateAtBoundary?: (value: string, currentLabel: string) => string;
}

interface LabelMatch {
  fieldName: string;
  label: string;
  start: number;
  end: number;
}

interface ParsedEntry {
  entryText: string;
  fields: Map<string, string>;
  startsNewEntry?: boolean;
  schemaFieldNames: string[];
  schemaIndex?: number;
  sequentialPartCount?: number;
  sequentialTargetCount?: number;
  droppedFragments?: string[];
  hasExplicitFieldLabels?: boolean;
  hasExplicitTimeRange?: boolean;
}

function stripListBulletPrefix(value: string): string {
  return value.replace(/^\s*[-*+]\s*/, "").trim();
}

const escapeRegExp = escapeInlineFieldRegExp;
const uniqueFieldNames = dedupeInlineFieldNames;
const normalizeValue = normalizeRepeatableInlineFieldValue;

function stripLeadingInlineHeader(value: string, sectionLabels?: string[]): string {
  const normalized = value.trim();
  const labels = uniqueLabels(sectionLabels ?? [])
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let startIndex = 0;

  labels.forEach((label) => {
    const pattern = new RegExp(`(?:^|[\\s，,。；;、])${escapeRegExp(label)}\\s*[：:]`, "gu");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized)) !== null) {
      startIndex = Math.max(startIndex, pattern.lastIndex);
    }
  });

  const stripped = startIndex > 0 ? normalized.slice(startIndex).trim() : normalized;
  return stripped.replace(/^[^\s，,。；;、]{1,24}[：:]\s*/u, "").trim();
}

function truncateAtStopLabels(value: string, stopLabels: string[] | undefined): string {
  const labels = uniqueLabels(stopLabels ?? [])
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let endIndex = value.length;

  labels.forEach((label) => {
    const pattern = new RegExp(`(?:^|[\\s，,。；;、])${escapeRegExp(label)}\\s*[：:]`, "gu");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const prefix = match[0] ?? "";
      const labelOffset = prefix.lastIndexOf(label);
      endIndex = Math.min(endIndex, match.index + Math.max(0, labelOffset));
    }
  });

  return value.slice(0, endIndex).trim();
}

function truncateAtParserBoundary(
  value: string,
  currentLabel: string,
  context: RepeatableInlineFieldsParseContext
): string {
  return context.truncateAtBoundary?.(value, currentLabel) ?? truncateAtStopLabels(value, context.stopLabels);
}

function splitCompactValues(value: string): string[] {
  return value
    .split(/[，,；;、]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitFlexibleValues(value: string, expectedCount: number): string[] {
  const parts = splitCompactValues(value);
  if (expectedCount <= 0 || parts.length >= expectedCount) {
    return parts;
  }

  const flexibleParts = [...parts];
  for (let index = 0; index < flexibleParts.length && flexibleParts.length < expectedCount; index += 1) {
    const part = flexibleParts[index] ?? "";
    const tokens = part
      .split(/\s+/u)
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length < 2) {
      continue;
    }

    const remainingSlots = expectedCount - flexibleParts.length + 1;
    const nextTokens = [
      ...tokens.slice(0, remainingSlots - 1),
      tokens.slice(remainingSlots - 1).join(" ")
    ].filter(Boolean);
    flexibleParts.splice(index, 1, ...nextTokens);
  }

  return flexibleParts;
}

function splitLabeledValueFragments(value: string): { value: string; dropped: string[] } {
  const parts = splitCompactValues(value);
  if (parts.length <= 1) {
    return {
      value: normalizeValue(value),
      dropped: []
    };
  }

  return {
    value: normalizeValue(parts[0] ?? ""),
    dropped: parts.slice(1).map(normalizeValue).filter(Boolean)
  };
}

function assignSequentialFieldValues(
  fields: Map<string, string>,
  fieldNames: string[],
  startIndex: number,
  value: string,
  options: { flexible?: boolean } = {}
): { partCount: number; targetCount: number } {
  const targetFieldNames = fieldNames.slice(startIndex);
  const parts = options.flexible
    ? splitFlexibleValues(value, targetFieldNames.length)
    : splitCompactValues(value);

  targetFieldNames.forEach((fieldName, index) => {
    if (!fieldName) {
      return;
    }

    const valueParts = index === targetFieldNames.length - 1
      ? parts.slice(index)
      : parts.slice(index, index + 1);
    fields.set(fieldName, normalizeValue(valueParts.join("，")));
  });

  return {
    partCount: parts.length,
    targetCount: targetFieldNames.length
  };
}

function stripEntryLabel(line: string, entryLabel: string | undefined): { line: string; matched: boolean } {
  const label = entryLabel?.trim();
  if (!label) {
    return { line, matched: false };
  }

  const pattern = new RegExp(`^${escapeRegExp(label)}\\s*(?:[:：-]\\s*|\\s+)?`, "u");
  if (!pattern.test(line)) {
    return { line, matched: false };
  }

  return {
    line: line.replace(pattern, "").trim(),
    matched: true
  };
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  labels.forEach((label) => {
    const trimmed = label.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push(trimmed);
  });
  return result;
}

function buildFieldLabelEntries(
  fieldNames: string[],
  fieldAliases: Record<string, string[]> | undefined
): Array<{ fieldName: string; label: string }> {
  return fieldNames.flatMap((fieldName) =>
    uniqueLabels([fieldName, ...(fieldAliases?.[fieldName] ?? [])]).map((label) => ({
      fieldName,
      label
    }))
  );
}

function buildLabelPattern(
  fieldNames: string[],
  fieldAliases?: Record<string, string[]>
): { pattern: RegExp; labelToFieldName: Map<string, string> } | undefined {
  const entries = buildFieldLabelEntries(fieldNames, fieldAliases)
    .filter(Boolean)
    .sort((left, right) => right.label.length - left.label.length);

  if (entries.length === 0) {
    return undefined;
  }

  const labelToFieldName = new Map(
    entries.map((entry) => [entry.label.toLocaleLowerCase(), entry.fieldName] as const)
  );
  return {
    pattern: new RegExp(
      `(^|[\\s，,。；;、])(${entries.map((entry) => escapeRegExp(entry.label)).join("|")})\\s*(?:[:：=]|\\s+)\\s*`,
      "giu"
    ),
    labelToFieldName
  };
}

function collectLabelMatches(
  line: string,
  fieldNames: string[],
  fieldAliases?: Record<string, string[]>
): LabelMatch[] {
  const compiled = buildLabelPattern(fieldNames, fieldAliases);
  if (!compiled) {
    return [];
  }

  const matches: LabelMatch[] = [];
  let match: RegExpExecArray | null;
  const { pattern, labelToFieldName } = compiled;
  while ((match = pattern.exec(line)) !== null) {
    const label = match[2] ?? "";
    matches.push({
      fieldName: labelToFieldName.get(label.toLocaleLowerCase()) ?? label,
      label,
      start: match.index + (match[1]?.length ?? 0),
      end: pattern.lastIndex
    });
  }
  return matches;
}

function parseLabeledEntry(
  line: string,
  fieldNames: string[],
  entryLabel?: string,
  fieldAliases?: Record<string, string[]>
): ParsedEntry | undefined {
  const stripped = stripEntryLabel(stripListBulletPrefix(line), entryLabel);
  const matches = collectLabelMatches(stripped.line, fieldNames, fieldAliases);
  if (matches.length === 0) {
    return undefined;
  }

  const fields = new Map<string, string>();
  const droppedFragments: string[] = [];
  matches.forEach((match, index) => {
    const next = matches[index + 1];
    const rawValue = stripped.line.slice(match.end, next?.start ?? stripped.line.length);
    const fragments = next
      ? splitLabeledValueFragments(rawValue)
      : { value: normalizeValue(rawValue), dropped: [] };
    fields.set(match.fieldName, fragments.value);
    droppedFragments.push(...fragments.dropped);
  });

  return {
    entryText: normalizeValue(stripped.line.slice(0, matches[0]?.start ?? 0)),
    fields,
    startsNewEntry: stripped.matched,
    schemaFieldNames: fieldNames,
    droppedFragments,
    hasExplicitFieldLabels: true
  };
}

function extractSpokenActivityText(value: string): string | undefined {
  const normalized = normalizeValue(value);
  const match = normalized.match(/(?:^|[，,。；;、\s])活动(?:叫|是|为)?\s*([\s\S]+)$/u);
  const activity = normalizeValue(match?.[1] ?? "");
  return activity.length > 0 ? activity : undefined;
}

function resolveEmbeddedEntryText(
  leadingText: string,
  labeledEntryText: string | undefined
): string {
  return extractSpokenActivityText(labeledEntryText ?? "") ?? normalizeValue(leadingText);
}

function parseLeadingTimeRangeEntry(
  line: string,
  fieldNames: string[],
  entryLabel?: string,
  fieldAliases?: Record<string, string[]>
): ParsedEntry | undefined {
  if (fieldNames.length < 2) {
    return undefined;
  }

  const stripped = stripEntryLabel(stripListBulletPrefix(line), entryLabel);
  const match = matchLeadingTimeRangeEntry(stripped.line);
  if (!match) {
    return undefined;
  }

  const fields = new Map<string, string>([
    [fieldNames[0] ?? "", normalizeValue(match.start)],
    [fieldNames[1] ?? "", normalizeValue(match.end)]
  ]);
  const remainder = normalizeValue(match.remainder);
  const labeledRemainder = parseLabeledEntry(remainder, fieldNames.slice(2), undefined, fieldAliases);
  if (labeledRemainder) {
    mergeEntryFields({ entryText: "", fields, schemaFieldNames: fieldNames }, labeledRemainder);
    return {
      entryText: labeledRemainder.entryText,
      fields,
      startsNewEntry: true,
      schemaFieldNames: fieldNames,
      hasExplicitTimeRange: true
    };
  }

  return {
    entryText: remainder,
    fields,
    startsNewEntry: true,
    schemaFieldNames: fieldNames,
    hasExplicitTimeRange: true
  };
}

function parseEmbeddedTimeRangeEntry(
  line: string,
  fieldNames: string[],
  entryLabel?: string,
  fieldAliases?: Record<string, string[]>,
  sectionLabels?: string[]
): ParsedEntry | undefined {
  if (fieldNames.length < 2) {
    return undefined;
  }

  const stripped = stripEntryLabel(stripListBulletPrefix(line), entryLabel);
  const match = matchEmbeddedTimeRangeEntry(stripped.line);
  if (!match) {
    return undefined;
  }

  const fields = new Map<string, string>([
    [fieldNames[0] ?? "", normalizeValue(match.start)],
    [fieldNames[1] ?? "", normalizeValue(match.end)]
  ]);
  const entryText = stripLeadingInlineHeader(normalizeValue(match.leadingText), sectionLabels);
  const remainder = normalizeValue(match.remainder);
  const labeledRemainder = parseLabeledEntry(remainder, fieldNames.slice(2), undefined, fieldAliases);
  if (labeledRemainder) {
    mergeEntryFields({ entryText, fields, schemaFieldNames: fieldNames }, labeledRemainder);
    return {
      entryText: resolveEmbeddedEntryText(entryText, labeledRemainder.entryText),
      fields,
      startsNewEntry: true,
      schemaFieldNames: fieldNames,
      hasExplicitTimeRange: true
    };
  }

  const sequential = assignSequentialFieldValues(fields, fieldNames, 2, remainder);

  return {
    entryText,
    fields,
    startsNewEntry: true,
    schemaFieldNames: fieldNames,
    sequentialPartCount: sequential.partCount,
    sequentialTargetCount: sequential.targetCount,
    hasExplicitTimeRange: true
  };
}

function parseEmbeddedTimePairEntry(
  line: string,
  fieldNames: string[],
  entryLabel?: string,
  fieldAliases?: Record<string, string[]>,
  sectionLabels?: string[]
): ParsedEntry | undefined {
  if (fieldNames.length < 2) {
    return undefined;
  }

  const stripped = stripEntryLabel(stripListBulletPrefix(line), entryLabel);
  const match = matchEmbeddedTimePairEntry(stripped.line);
  if (!match) {
    return undefined;
  }

  const fields = new Map<string, string>([
    [fieldNames[0] ?? "", normalizeValue(match.start)],
    [fieldNames[1] ?? "", normalizeValue(match.end)]
  ]);
  const entryText = stripLeadingInlineHeader(normalizeValue(match.leadingText), sectionLabels);
  const remainder = normalizeValue(match.remainder);
  const labeledRemainder = parseLabeledEntry(remainder, fieldNames.slice(2), undefined, fieldAliases);
  if (labeledRemainder) {
    mergeEntryFields({ entryText, fields, schemaFieldNames: fieldNames }, labeledRemainder);
    return {
      entryText: resolveEmbeddedEntryText(entryText, labeledRemainder.entryText),
      fields,
      startsNewEntry: true,
      schemaFieldNames: fieldNames,
      hasExplicitTimeRange: true
    };
  }

  const sequential = assignSequentialFieldValues(fields, fieldNames, 2, remainder, { flexible: true });

  return {
    entryText,
    fields,
    startsNewEntry: true,
    schemaFieldNames: fieldNames,
    sequentialPartCount: sequential.partCount,
    sequentialTargetCount: sequential.targetCount,
    hasExplicitTimeRange: true
  };
}

function parseCompactEntry(line: string, fieldNames: string[], entryLabel?: string): ParsedEntry | undefined {
  const stripped = stripEntryLabel(stripListBulletPrefix(line), entryLabel);
  if (!stripped.matched && entryLabel?.trim()) {
    return undefined;
  }

  const parts = splitCompactValues(stripped.line);
  if (parts.length === 0) {
    return undefined;
  }

  const fields = new Map<string, string>();
  fieldNames.forEach((fieldName, index) => {
    const valueParts = index === fieldNames.length - 1
      ? parts.slice(index + 1)
      : parts.slice(index + 1, index + 2);
    fields.set(fieldName, normalizeValue(valueParts.join("，")));
  });

  return {
    entryText: parts[0] ?? entryLabel?.trim() ?? "",
    fields,
    startsNewEntry: stripped.matched || !entryLabel?.trim(),
    schemaFieldNames: fieldNames,
    sequentialPartCount: Math.max(0, parts.length - 1),
    sequentialTargetCount: fieldNames.length
  };
}

function formatEntry(entry: ParsedEntry): string {
  const inlineFields = entry.schemaFieldNames
    .map((fieldName) => `[${fieldName}:: ${entry.fields.get(fieldName) ?? ""}]`)
    .join(" ");
  return entry.entryText
    ? `- ${entry.entryText}${inlineFields ? ` ${inlineFields}` : ""}`
    : `- ${inlineFields}`.trim();
}

function parseLineEntryWithSchema(
  normalizedLine: string,
  fieldNames: string[],
  entryLabel: string | undefined,
  context: RepeatableInlineFieldsParseContext
): ParsedEntry | undefined {
  return (
    parseLeadingTimeRangeEntry(normalizedLine, fieldNames, entryLabel, context.fieldAliases) ??
    parseEmbeddedTimeRangeEntry(normalizedLine, fieldNames, entryLabel, context.fieldAliases, context.sectionLabels) ??
    parseEmbeddedTimePairEntry(normalizedLine, fieldNames, entryLabel, context.fieldAliases, context.sectionLabels) ??
    parseLabeledEntry(normalizedLine, fieldNames, entryLabel, context.fieldAliases) ??
    parseCompactEntry(normalizedLine, fieldNames, entryLabel)
  );
}

function parseLineEntry(line: string, context: RepeatableInlineFieldsParseContext, schemaIndex: number): ParsedEntry | undefined {
  const schemas = context.entrySchemas ?? [];
  const preferredSchemaIndex = resolveRepeatableSchemaIndex(schemas.length, schemaIndex);
  const normalizedLine = stripListBulletPrefix(line);
  if (!normalizedLine) {
    return undefined;
  }

  if (/\[[^\]]+::[^\]]*\]/u.test(normalizedLine)) {
    return undefined;
  }

  if (schemas.length === 0) {
    return parseLineEntryWithSchema(
      normalizedLine,
      uniqueFieldNames(context.fieldNames),
      context.entryLabel,
      context
    );
  }

  return schemas
    .map((schema, index) => {
      const parsed = parseLineEntryWithSchema(
        normalizedLine,
        uniqueFieldNames(schema.fieldNames),
        schema.entryLabel ?? context.entryLabel,
        context
      );
      if (!parsed) {
        return undefined;
      }

      parsed.schemaIndex = index;
      return parsed;
    })
    .filter((entry): entry is ParsedEntry => !!entry)
    .sort((left, right) => scoreRepeatableParsedEntry(right, preferredSchemaIndex) - scoreRepeatableParsedEntry(left, preferredSchemaIndex))[0];
}

function hasAnyFieldValue(entry: ParsedEntry): boolean {
  return Array.from(entry.fields.values()).some((value) => value.trim().length > 0);
}

function startsWithSingleEntryLead(entry: ParsedEntry): boolean {
  return !/[。；;]/u.test(entry.entryText);
}

function mergeEntryFields(target: ParsedEntry, source: ParsedEntry): void {
  source.fields.forEach((value, fieldName) => {
    if (value.trim().length > 0 || !target.fields.has(fieldName)) {
      target.fields.set(fieldName, value);
    }
  });
}

function appendToLastEmptyField(entry: ParsedEntry, fieldNames: string[], value: string): boolean {
  const targetFieldName = [...fieldNames]
    .reverse()
    .find((fieldName) => (entry.fields.get(fieldName) ?? "").trim().length === 0);
  if (!targetFieldName) {
    return false;
  }

  entry.fields.set(targetFieldName, normalizeValue(value));
  return true;
}

function appendToEmptyFieldsInOrder(entry: ParsedEntry, fieldNames: string[], value: string): boolean {
  const emptyFieldNames = fieldNames.filter((fieldName) => (entry.fields.get(fieldName) ?? "").trim().length === 0);
  if (emptyFieldNames.length === 0) {
    return false;
  }

  const parts = splitFlexibleValues(value, emptyFieldNames.length);
  if (parts.length === 0) {
    return false;
  }

  parts.forEach((part, index) => {
    const fieldName = emptyFieldNames[index];
    if (fieldName) {
      entry.fields.set(fieldName, normalizeValue(part));
    }
  });
  return true;
}

function findNextSchemaEntrySplit(
  line: string,
  context: RepeatableInlineFieldsParseContext,
  currentSchemaIndex: number,
  nextSchemaIndex: number
): { head: string; tail: string } | undefined {
  const schemaCount = context.entrySchemas?.length ?? 0;
  if (schemaCount === 0) {
    return undefined;
  }

  const splitPattern = /[。；;]\s*/gu;
  let match: RegExpExecArray | null;
  while ((match = splitPattern.exec(line)) !== null) {
    const head = line.slice(0, match.index).trim();
    const tail = line.slice(splitPattern.lastIndex).trim();
    if (!head || !tail) {
      continue;
    }

    const parsedHead = parseLineEntry(head, context, currentSchemaIndex);
    if (!parsedHead || !hasAnyFieldValue(parsedHead)) {
      continue;
    }

    const parsedTail = parseLineEntry(tail, context, nextSchemaIndex);
    if (parsedTail && hasAnyFieldValue(parsedTail) && startsWithSingleEntryLead(parsedTail)) {
      return { head, tail };
    }
  }

  return undefined;
}

function startsWithStopLabel(line: string, stopLabels: string[] | undefined): boolean {
  const normalizedLine = stripListBulletPrefix(line).trim();
  if (!normalizedLine) {
    return false;
  }

  return uniqueLabels(stopLabels ?? [])
    .sort((left, right) => right.length - left.length)
    .some((label) => {
      const trimmed = label.trim();
      if (!trimmed || !normalizedLine.startsWith(trimmed)) {
        return false;
      }

      const next = normalizedLine.slice(trimmed.length, trimmed.length + 1);
      return !next || /[\s，,。；;、:：]/u.test(next) || /^[这本该有]/u.test(next);
    });
}

function buildEffectiveEntrySchemas(
  context: RepeatableInlineFieldsParseContext
): RepeatableInlineFieldsParseContext["entrySchemas"] {
  const configuredSchemas = context.entrySchemas
    ?.map((schema) => ({
      entryLabel: schema.entryLabel?.trim() || undefined,
      fieldNames: uniqueFieldNames(schema.fieldNames)
    }))
    .filter((schema) => schema.fieldNames.length > 0) ?? [];
  const fullFieldNames = uniqueFieldNames(context.fieldNames);
  if (fullFieldNames.length === 0) {
    return configuredSchemas.length > 0 ? configuredSchemas : undefined;
  }

  const fullSchemaKey = fullFieldNames.join("\u0000").toLocaleLowerCase();
  const fullSchemaIndex = configuredSchemas.findIndex(
    (schema) => schema.fieldNames.join("\u0000").toLocaleLowerCase() === fullSchemaKey
  );
  if (fullSchemaIndex < 0) {
    return configuredSchemas.length > 0 ? configuredSchemas : [{ entryLabel: context.entryLabel?.trim() || undefined, fieldNames: fullFieldNames }];
  }

  const schemas = [
    configuredSchemas[fullSchemaIndex]!,
    ...configuredSchemas.slice(0, fullSchemaIndex),
    ...configuredSchemas.slice(fullSchemaIndex + 1)
  ];
  return schemas.length > 0 ? schemas : undefined;
}

export class RepeatableInlineFieldsParser {
  parse(content: string, context: RepeatableInlineFieldsParseContext = {}): RepeatableEntryParseResult {
    const existingInlineFieldContent = parseExistingInlineFieldContent(content, context);
    if (existingInlineFieldContent) {
      return {
        content: existingInlineFieldContent,
        warnings: []
      };
    }

    const entrySchemas = buildEffectiveEntrySchemas(context);
    const schemaDriven = !!entrySchemas && entrySchemas.length > 0;
    const parseContext = schemaDriven
      ? { ...context, entrySchemas }
      : context;
    const rows: string[] = [];
    const warnings: string[] = [];
    let pending: ParsedEntry | undefined;

    const flushPending = (): void => {
      if (!pending) {
        return;
      }

      warnings.push(...buildRepeatableInlineEntryWarnings(pending, rows.length + 1));
      rows.push(formatEntry(pending));
      pending = undefined;
    };

    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";

        const normalizedLine = stripListBulletPrefix(line);
        if (/\[[^\]]+::[^\]]*\]/u.test(normalizedLine)) {
          const inlineFieldIndex = normalizedLine.search(/\[[^\]]+::[^\]]*\]/u);
          const leadingText = inlineFieldIndex > 0 ? normalizeValue(normalizedLine.slice(0, inlineFieldIndex)) : "";
          if (pending && leadingText && appendToLastEmptyField(pending, pending.schemaFieldNames, leadingText)) {
            flushPending();
            rows.push(prefixRepeatableBullet(normalizedLine.slice(inlineFieldIndex).trim()));
            continue;
          }

          flushPending();
          rows.push(prefixRepeatableBullet(normalizedLine));
          continue;
        }

        const schemaIndex = rows.length + (pending ? 1 : 0);
        const split = findNextSchemaEntrySplit(line, parseContext, schemaIndex, schemaIndex + 1);
        if (split) {
          lines.splice(lineIndex + 1, 0, split.tail);
        }

        if (parseContext.shouldStopAtLine?.(line)) {
          flushPending();
          break;
        }

        const parsed = parseLineEntry(
          truncateAtParserBoundary(split?.head ?? line, parseContext.entryLabel ?? "", parseContext),
          parseContext,
          schemaIndex
        );
        if (!parsed) {
          if (pending && startsWithStopLabel(line, parseContext.stopLabels)) {
            flushPending();
            continue;
          }

          if (schemaDriven && !pending) {
            continue;
          }

          if (pending && appendToEmptyFieldsInOrder(pending, pending.schemaFieldNames, line)) {
            continue;
          }

          if (schemaDriven) {
            flushPending();
            continue;
          }

          flushPending();
          const fallback = runRepeatableEntryParser(line, {
            parseLine: (fallbackLine) => prefixRepeatableBullet(stripListBulletPrefix(fallbackLine))
          }).content;
          if (fallback.trim()) {
            rows.push(fallback);
          }
          continue;
        }

        const pendingEntry = pending;
        if (
          schemaDriven &&
          pendingEntry &&
          !parsed.startsNewEntry &&
          parsed.entryText.length > 0 &&
          !hasAnyFieldValue(parsed) &&
          appendToEmptyFieldsInOrder(pendingEntry, pendingEntry.schemaFieldNames, parsed.entryText)
        ) {
          continue;
        }

        if (
          pendingEntry &&
          !parsed.startsNewEntry &&
          parsed.entryText.length > 0 &&
          hasAnyFieldValue(parsed) &&
          appendToLastEmptyField(pendingEntry, pendingEntry.schemaFieldNames, parsed.entryText)
        ) {
          flushPending();
          pending = {
            entryText: "",
            fields: parsed.fields,
            schemaFieldNames: parsed.schemaFieldNames
          };
          continue;
        }

        const shouldMergeIntoPending =
          !!pendingEntry &&
          (parsed.entryText.length === 0 || parsed.entryText === context.entryLabel?.trim()) &&
          (hasAnyFieldValue(parsed) || parsed.fields.size > 0);
        if (shouldMergeIntoPending) {
          mergeEntryFields(pendingEntry, parsed);
          continue;
        }

        if (pending) {
          flushPending();
        }
        pending = parsed;
    }

    flushPending();
    return {
      content: rows.join("\n"),
      warnings: Array.from(new Set(warnings))
    };
  }
}
