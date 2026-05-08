export interface RepeatableInlineScoringEntry {
  entryText: string;
  fields: Map<string, string>;
  schemaFieldNames: string[];
  schemaIndex?: number;
  sequentialPartCount?: number;
  sequentialTargetCount?: number;
  droppedFragments?: string[];
  hasExplicitFieldLabels?: boolean;
  hasExplicitTimeRange?: boolean;
}

function isStartLikeFieldName(fieldName: string | undefined): boolean {
  return /^(?:start|from|begin|go|depart|leave|.*(?:start|begin)|.*_start)$/iu.test(fieldName?.trim() ?? "");
}

function isEndLikeFieldName(fieldName: string | undefined): boolean {
  return /^(?:end|to|finish|back|return|arrive|.*(?:end|finish)|.*_end)$/iu.test(fieldName?.trim() ?? "");
}

function schemaStartsWithTimeRangeFields(fieldNames: string[]): boolean {
  return isStartLikeFieldName(fieldNames[0]) && isEndLikeFieldName(fieldNames[1]);
}

function hasAnyFieldValue(entry: RepeatableInlineScoringEntry): boolean {
  return Array.from(entry.fields.values()).some((value) => value.trim().length > 0);
}

export function resolveRepeatableSchemaIndex(schemaCount: number, entryIndex: number): number {
  if (schemaCount <= 0) {
    return -1;
  }

  return Math.max(0, entryIndex) % schemaCount;
}

export function scoreRepeatableParsedEntry(
  entry: RepeatableInlineScoringEntry,
  preferredSchemaIndex: number
): number {
  let score = hasAnyFieldValue(entry) ? 100 : 0;
  if (entry.entryText.trim().length > 0) {
    score += 10;
  }

  if (entry.hasExplicitFieldLabels) {
    score += 1000 + entry.fields.size * 50;
    score -= (entry.droppedFragments?.length ?? 0) * 10;
  }

  if (
    entry.sequentialPartCount !== undefined &&
    entry.sequentialTargetCount !== undefined
  ) {
    const distance = Math.abs(entry.sequentialPartCount - entry.sequentialTargetCount);
    score += 500 - distance * 40;
    if (distance === 0) {
      score += 120;
    }
  }

  if (entry.schemaIndex === preferredSchemaIndex) {
    score += 1;
  }

  if (entry.hasExplicitTimeRange) {
    score += schemaStartsWithTimeRangeFields(entry.schemaFieldNames) ? 600 : -600;
  }

  return score;
}
