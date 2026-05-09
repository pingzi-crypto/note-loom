import type {
  TemplateFieldConfig,
  TemplateSectionMixedFieldBlockOptionConfig,
  TemplateSectionMixedFieldBlockBehaviorConfig,
  TemplateSectionMixedFieldBlockItemConfig,
  TemplateSectionBoundaryPolicyConfig,
  TemplateSectionBehaviorFieldConfig,
  TemplateSectionBehaviorGroupConfig,
  TemplateSectionConfig,
  TemplateSectionFieldBlockBehaviorConfig,
  TemplateSectionGroupedFieldBlockBehaviorConfig,
  TemplateSectionParserId,
  TemplateSectionRepeatableBehaviorConfig,
  TemplateSectionTableBlockBehaviorConfig,
  TemplateSectionTaskListBehaviorConfig
} from "../types/template";
import type {
  SectionStructureDescriptor,
  StructureEvidence,
  TemplateStructureDescriptor
} from "../types/template-structure-descriptor";
import {
  resolveTemplateFieldContextFields,
  type TemplateFieldContext
} from "./template-field-state-service";
import type { PreparedSourceForExtraction } from "./source-preparation-service";
import { getRuntimeSectionRawContent } from "./template-section-config-service";
import { resolveTemplateSectionParser } from "./template-section-parser-registry";
import { buildSectionStructureDescriptor } from "./template-structure-descriptor-service";
import {
  normalizeLooseCompareValue,
  scoreFieldLinkCandidate,
  uniqueFieldLinkLabels
} from "../utils/field-link-heuristics";
import {
  collectBestLabelBlock,
  detectFirstStructuralLabelStart,
  escapeRegExp,
  hasKnownLabelStructuralBoundary,
  hasStructuralLabelStart,
  normalizeInlineLabelValue,
  startsWithNaturalLanguageContinuation,
  startsWithLongerKnownLabel,
  trimBlockLines,
  truncateSectionBlockAtNextKnownLabel,
  truncateTableCellAtNextKnownLabel
} from "../utils/label-block";
import { extractDataviewInlineFieldNames } from "../utils/dataview-inline-field";
import {
  COMPACT_MARKDOWN_TASK_BOUNDARY,
  COMPACT_PLAIN_BULLET_BOUNDARY,
  splitCompactSourceLine,
  splitCompactSourceText
} from "../utils/compact-source-segmentation";
import { expandLabelVariants } from "../utils/label-variants";
import { normalizeCompactSourceLabelFlow } from "../utils/source-label-flow";
import { repairRepeatableInlineFieldDraft } from "./repeatable-inline-fields-parser";
import {
  matchEmbeddedTimePairEntry,
  matchEmbeddedTimeRangeEntry,
  matchLeadingTimeRangeEntry
} from "./repeatable-inline-time-entry";
import { extractRepeatableInlineEntrySchemasFromRawContent } from "./repeatable-inline-schema";
import {
  decideSectionBoundaryLine,
  isValidSectionBoundaryCandidate,
  truncateValueAtSectionBoundary,
  type SectionBoundaryRule
} from "./section-boundary-decision-service";

export interface TemplateSectionDraftExtraction {
  repeatableDrafts: Map<string, string>;
  repeatableWarnings: Map<string, string[]>;
  fieldBlockDrafts: Map<string, Record<string, string>>;
  groupedFieldBlockDrafts: Map<string, Record<string, Record<string, string>>>;
  tableBlockDrafts: Map<string, Array<Record<string, string>>>;
  mixedFieldBlockDrafts: Map<string, Record<string, string>>;
  sectionDraftTraces: Map<string, TemplateSectionDraftTrace>;
}

export type TemplateSectionDraftTraceKind =
  | "repeatable_entries"
  | "task_list"
  | "field_block"
  | "grouped_field_block"
  | "table_block"
  | "mixed_field_block";

export interface TemplateSectionDraftTrace {
  sectionId: string;
  sectionTitle: string;
  kind: TemplateSectionDraftTraceKind;
  sectionKind: TemplateSectionConfig["kind"];
  behaviorKind?: SectionStructureDescriptor["behaviorKind"];
  parserId?: string;
  sourceScope?: "section_body" | "whole_source" | "none";
  fallbackReason?: string;
  features: string[];
  evidence: StructureEvidence[];
}

interface TemplateSectionExtractOptions {
  templateFields?: TemplateFieldContext | TemplateFieldConfig[];
  structureDescriptor?: TemplateStructureDescriptor;
}

export interface TemplateSectionExtractionContext {
  rawSourceText: string;
  normalizedSourceText: string;
  labelSets?: PreparedSourceForExtraction["labelSets"];
  normalizationVersion?: PreparedSourceForExtraction["normalizationVersion"];
}

type TemplateSectionSourceInput = string | PreparedSourceForExtraction | TemplateSectionExtractionContext;

type SectionStopRule = SectionBoundaryRule<TemplateSectionConfig> & { section: TemplateSectionConfig };

type ExtractionFallbackPolicy =
  | "none"
  | "section-only"
  | "whole-source-with-warning"
  | "manual-review";

interface SectionSourceDecision {
  source: string;
  scope: "section_body" | "whole_source" | "none";
  fallbackReason?: string;
  warnings: string[];
}

function extractDataviewInlineFieldDisplayLabels(rawContent: string): string[] {
  return uniqueLabels(
    rawContent
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/\[[^\]\r\n:]+::[^\]]*\]/u);
        if (!match || match.index === undefined) {
          return "";
        }

        return line
          .slice(0, match.index)
          .replace(/^\s*>+\s*/u, "")
          .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, "")
          .replace(/^#+\s*/u, "")
          .replace(/[\s:：-]+$/u, "")
          .trim();
      })
  );
}

function buildAllFieldLabels(
  sections: TemplateSectionConfig[],
  templateFields?: TemplateFieldContext | TemplateFieldConfig[]
): string[] {
  return uniqueLabels(
    expandLabelVariants([
      ...sections.flatMap((section) => section.fieldNames ?? []),
      ...sections.flatMap((section) =>
        extractDataviewInlineFieldDisplayLabels(getRuntimeSectionRawContent(section))
      ),
      ...resolveTemplateFieldContextFields(templateFields ?? []).map((field) => field.name)
    ])
  );
}

function collectSectionBehaviorLabels(section: TemplateSectionConfig): string[] {
  const behavior = section.behavior;
  if (!behavior) {
    return [];
  }

  if (behavior.kind === "field_block" || behavior.kind === "grouped_field_block") {
    return [
      ...(behavior.kind === "grouped_field_block"
        ? behavior.groups.flatMap((group) => [group.id, ...buildGroupedBehaviorGroupLabels(group)])
        : []),
      ...behavior.fields.flatMap((field) => [field.id, field.label, ...(field.aliases ?? [])])
    ];
  }

  if (behavior.kind === "table_block") {
    return behavior.columns.flatMap((column) => [column.id, column.label, ...(column.aliases ?? [])]);
  }

  if (behavior.kind === "mixed_field_block") {
    return behavior.items.flatMap((item) => {
      if (item.kind === "static_note") {
        return [];
      }

      if (item.kind === "inline_field_group") {
        return item.fields.flatMap((field) => [field.fieldName, field.id, field.label, ...(field.aliases ?? [])]);
      }

      return [item.targetFieldName ?? "", item.id, item.label, ...(item.aliases ?? [])];
    });
  }

  return [];
}

function stripLeadingOrdinalLabelPrefix(label: string): string {
  return label.trim().replace(/^(?:第?\s*[一二三四五六七八九十百千万\d]+[、.．\-\s]+)\s*/u, "").trim();
}

function buildGroupedBehaviorGroupLabels(group: TemplateSectionBehaviorGroupConfig): string[] {
  return uniqueLabels([
    group.label,
    stripLeadingOrdinalLabelPrefix(group.label),
    ...(group.aliases ?? []),
    ...(group.aliases ?? []).map(stripLeadingOrdinalLabelPrefix)
  ]);
}

function collectMixedFieldBlockIdentityLabels(
  behavior: TemplateSectionMixedFieldBlockBehaviorConfig
): string[] {
  return uniqueLabels(
    behavior.items.flatMap((item) => {
      if (item.kind === "static_note") {
        return [];
      }

      if (item.kind === "inline_field_group") {
        return item.fields.flatMap((field) => [field.fieldName, field.id, field.label]);
      }

      return [item.targetFieldName ?? "", item.id, item.label];
    })
  );
}

function uniqueLabels(labels: string[]): string[] {
  return uniqueFieldLinkLabels(labels);
}

function isStandaloneSourceHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (/^#{1,6}\s+/.test(trimmed)) {
    return true;
  }

  return /^[^][<>|`]+[：:]\s*$/.test(trimmed);
}

function isNumberedSourceHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  const match = trimmed.match(/^\d{1,3}[.)．、]\s+(.+)$/u);
  const headingText = match?.[1]?.trim() ?? "";
  if (!headingText) {
    return false;
  }

  if (new RegExp("[\\[\\]<>|`]", "u").test(headingText)) {
    return false;
  }

  return headingText.length <= 40 && !/[。.!！?？；;]$/u.test(headingText);
}

function isMarkdownThematicBreak(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  return (
    /^(?:-\s*){3,}$/.test(trimmed) ||
    /^(?:\*\s*){3,}$/.test(trimmed) ||
    /^(?:_\s*){3,}$/.test(trimmed)
  );
}

function getNextMeaningfulLine(lines: string[], fromIndex: number): string {
  for (let index = fromIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim()) {
      return line;
    }
  }

  return "";
}

function truncateSectionBlockAtStructuralStopLabel(
  value: string,
  stopLabels: string[],
  currentLabel: string,
  stopRules: SectionStopRule[] = [],
  options: { allowTightStructuralStops?: boolean } = {}
): string {
  return truncateValueAtSectionBoundary(value, stopLabels, currentLabel, stopRules, options);
}

function extractTemplateTaskItems(section: TemplateSectionConfig, templateContent: string, taskPrefix: string): NormalizedTaskItem[] {
  return extractTemplateTaskItemsFromText(
    getRuntimeSectionRawContent(section) ||
      (section as TemplateSectionConfig & { rawContent?: string }).rawContent ||
      templateContent,
    taskPrefix
  );
}

function extractSectionTaskTemplateContent(templateContent: string, section: TemplateSectionConfig): string {
  if (!templateContent.trim()) {
    return "";
  }

  const escapedTitle = escapeRegExp(section.title);
  const headingPattern = new RegExp(`(^|\\n)(#{1,6})\\s+${escapedTitle}\\s*(?:\\n|$)`, "u");
  const match = templateContent.match(headingPattern);
  if (!match?.index) {
    return "";
  }

  const startIndex = match.index + match[0].length;
  const headingLevel = match[2]?.length ?? 1;
  const rest = templateContent.slice(startIndex);
  const nextHeadingPattern = new RegExp(`\\n#{1,${headingLevel}}\\s+`, "u");
  const nextHeadingMatch = rest.match(nextHeadingPattern);
  return nextHeadingMatch?.index !== undefined ? rest.slice(0, nextHeadingMatch.index) : rest;
}

function sectionLooksLikeStandaloneStructureBoundary(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^(?:#{1,6}\s+|>\s*#{1,6}\s+)/.test(trimmed) ||
    /^[-*+]\s+\[[ xX]\]\s+/.test(trimmed) ||
    /^[^：:]{2,40}[：:]\s*$/.test(trimmed)
  );
}

function stripGroupedValueAfterKnownStopLabelFragments(value: string, stopLabels: string[]): string {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return normalizedValue;
  }

  const stopFragments = uniqueLabels(stopLabels)
    .filter((label) => label.trim().length >= 2)
    .sort((left, right) => right.length - left.length);

  let endIndex = normalizedValue.length;
  stopFragments.forEach((label) => {
    const labelPattern = new RegExp(escapeRegExp(label), "gu");
    let match: RegExpExecArray | null;
    while ((match = labelPattern.exec(normalizedValue)) !== null) {
      const labelIndex = match.index;
      if (labelIndex <= 0) {
        continue;
      }

      const previousChar = normalizedValue[labelIndex - 1] ?? "";
      if (!/[。.!！?？；;，,、\s]/u.test(previousChar)) {
        continue;
      }

      const afterLabel = normalizedValue.slice(labelIndex + label.length);
      const delimiterMatch = afterLabel.match(/^(\s*([:：,，;；、|｜/\\\-—–~·]|\s+))/u);
      const delimiter = delimiterMatch?.[2] ?? "";
      const textAfterDelimiter = afterLabel.slice(delimiterMatch?.[1]?.length ?? 0);
      if (
        delimiter &&
        hasKnownLabelStructuralBoundary({
          label,
          delimiter,
          textAfterLabel: textAfterDelimiter
        })
      ) {
        endIndex = Math.min(endIndex, labelIndex);
        continue;
      }

      if (
        hasKnownLabelStructuralBoundary({
          label,
          delimiter,
          textAfterLabel: textAfterDelimiter
        }) &&
        /^(?:\d{1,2}[:：]\d{2}|[-*+]\s+|#{1,6}\s+)/u.test(afterLabel.trimStart())
      ) {
        endIndex = Math.min(endIndex, labelIndex);
      }
    }
  });

  const genericBoundaryMatch = normalizedValue.match(
    /(?:\r?\n\s*|[。.!！?？]\s*)([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9 _/\-（）()]{1,24})\s*[：:]/u
  );
  if (genericBoundaryMatch?.index !== undefined && genericBoundaryMatch.index > 0) {
    const matchedText = genericBoundaryMatch[0] ?? "";
    const boundaryOffset = matchedText.search(/[\p{Script=Han}A-Za-z]/u);
    endIndex = Math.min(endIndex, genericBoundaryMatch.index + Math.max(boundaryOffset, 0));
  }

  return normalizedValue.slice(0, endIndex).trimEnd();
}

function stripValueAfterKnownSectionLabelFragments(value: string, stopRules: SectionStopRule[]): string {
  const normalizedValue = value.trim();
  if (!normalizedValue || stopRules.length === 0) {
    return normalizedValue;
  }

  let endIndex = normalizedValue.length;
  stopRules.forEach((rule) => {
    uniqueLabels(rule.labels)
      .filter((label) => label.trim().length >= 2)
      .forEach((label) => {
        const labelPattern = new RegExp(escapeRegExp(label), "gu");
        let match: RegExpExecArray | null;
        while ((match = labelPattern.exec(normalizedValue)) !== null) {
          if (match.index <= 0) {
            continue;
          }

          const previousChar = normalizedValue[match.index - 1] ?? "";
          if (!/[。.!！?？；;，,、\s]/u.test(previousChar)) {
            continue;
          }

          const afterLabel = normalizedValue.slice(match.index + label.length);
          if (!afterLabel.trim()) {
            endIndex = Math.min(endIndex, match.index);
            continue;
          }

          const delimiterMatch = afterLabel.match(/^(\s*([:：,，;；、|｜/\\\-—–~·]|\s+))/u);
          if (!delimiterMatch) {
            continue;
          }

          const candidateValue = afterLabel.slice(delimiterMatch[1]?.length ?? 0).trimStart();
          if (isValidSectionBoundaryCandidate(label, candidateValue, stopRules)) {
            endIndex = Math.min(endIndex, match.index);
          }
        }
      });
  });

  return normalizedValue.slice(0, endIndex).trimEnd();
}

function extractTemplateTaskItemsFromText(content: string, taskPrefix: string): NormalizedTaskItem[] {
  return content
    .split(/\r?\n/)
    .map((line) => parseMarkdownTaskLine(line, taskPrefix))
    .filter((item): item is NormalizedTaskItem => item !== null);
}

function isValidTaskListBoundaryCandidate(value: string, section: TemplateSectionConfig): boolean {
  const behavior = section.behavior?.kind === "task_list" ? section.behavior : undefined;
  const taskPrefix = behavior?.taskPrefix ?? "- [ ] ";
  const templateItems = extractTemplateTaskItems(section, "", taskPrefix);
  const normalizedValue = value.trim();
  if (
    templateItems.length === 0 &&
    normalizedValue &&
    startsWithNaturalLanguageContinuation(normalizedValue) &&
    !/^[-*+]\s+/u.test(normalizedValue) &&
    !lineStartsWithCompletedOnlyTaskHint(normalizedValue) &&
    !/[\r\n，,；;、]/u.test(normalizedValue)
  ) {
    return false;
  }

  const candidateItems = parseTaskListDraftItems(value, taskPrefix);
  const compactCandidateItems = value
    .split(/[，,；;、]+/u)
    .map((part) => buildNormalizedTaskItem(part.trim(), true, taskPrefix))
    .filter((item): item is NormalizedTaskItem => item !== null);
  const allCandidateItems = [...candidateItems, ...compactCandidateItems];
  if (allCandidateItems.length === 0) {
    return value.trim().length === 0;
  }

  if (templateItems.length === 0) {
    return true;
  }

  const normalizedComparableValue = normalizeLooseCompareValue(value);
  return templateItems.some((templateItem) =>
    allCandidateItems.some((candidateItem) => matchTaskItems(candidateItem, templateItem)) ||
    (templateItem.matchKey.length > 0 && normalizedComparableValue.includes(templateItem.matchKey))
  );
}

function isValidRepeatableBoundaryCandidate(value: string, section: TemplateSectionConfig): boolean {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return true;
  }

  const behavior = section.behavior?.kind === "repeatable_text" ? section.behavior : undefined;
  if (!behavior) {
    return normalizedValue.length > 0;
  }

  if (/^[-*+]\s+/u.test(normalizedValue)) {
    return true;
  }

  if (
    matchLeadingTimeRangeEntry(normalizedValue) ||
    matchEmbeddedTimeRangeEntry(normalizedValue) ||
    matchEmbeddedTimePairEntry(normalizedValue)
  ) {
    return true;
  }

  const fieldNames = uniqueLabels([
    ...(section.fieldNames ?? []),
    ...(behavior.entrySchemas?.flatMap((schema) => schema.fieldNames ?? []) ?? [])
  ]);
  return fieldNames.length > 0 && hasStructuralLabelStart(normalizedValue, fieldNames, {
    allowQuotePrefix: true,
    allowTightLabel: true,
    allowMarkdownHeading: true
  });
}

function isValidFieldBlockBoundaryCandidate(value: string, section: TemplateSectionConfig): boolean {
  const behavior = section.behavior;
  if (behavior?.kind !== "field_block" && behavior?.kind !== "grouped_field_block") {
    return value.trim().length > 0;
  }

  const fields = behavior.fields.flatMap((field) => [field.id, field.label, ...(field.aliases ?? [])]);
  return value.trim().length === 0 || hasStructuralLabelStart(value, fields, {
    allowQuotePrefix: true,
    allowTightLabel: true,
    allowMarkdownHeading: true
  });
}

function validateSectionBoundaryCandidateForSection(value: string, section: TemplateSectionConfig): boolean {
  const behaviorKind = section.behavior?.kind;
  if (behaviorKind === "task_list") {
    return isValidTaskListBoundaryCandidate(value, section);
  }

  if (behaviorKind === "field_block" || behaviorKind === "grouped_field_block") {
    return isValidFieldBlockBoundaryCandidate(value, section);
  }

  if (behaviorKind === "repeatable_text") {
    return isValidRepeatableBoundaryCandidate(value, section);
  }

  return value.trim().length > 0;
}

function extractCompactTaskSectionFallbackBlock(
  sourceText: string,
  section: TemplateSectionConfig,
  sectionLabels: string[]
): string {
  if (section.behavior?.kind !== "task_list") {
    return "";
  }

  const labels = uniqueLabels(sectionLabels).sort((left, right) => right.length - left.length);
  for (const label of labels) {
    let searchIndex = 0;
    while (searchIndex < sourceText.length) {
      const labelStart = sourceText.indexOf(label, searchIndex);
      if (labelStart < 0) {
        break;
      }

      const afterLabel = sourceText.slice(labelStart + label.length);
      const delimiterMatch = afterLabel.match(/^\s*[：:，,。.;；、]\s*/u);
      if (delimiterMatch) {
        const candidate = afterLabel.slice(delimiterMatch[0].length).trim();
        if (candidate && isValidTaskListBoundaryCandidate(candidate, section)) {
          return candidate;
        }
      }

      searchIndex = labelStart + Math.max(1, label.length);
    }
  }

  return "";
}

function isValidStructuralStopLine(
  line: string,
  stopLabels: string[],
  stopRules: SectionStopRule[]
): boolean {
  if (stopRules.length === 0) {
    return true;
  }

  return decideSectionBoundaryLine(line, stopLabels, stopRules, {
    allowTightLabels: false,
    allowMarkdownHeadings: true
  }).matched;
}

function isNumberedHeadingStructuralBoundary(
  line: string,
  lines: string[],
  nextIndex: number,
  stopLabels: string[],
  stopRules: SectionStopRule[],
  boundaryPolicy: TemplateSectionBoundaryPolicyConfig
): boolean {
  if (!isNumberedSourceHeadingLine(line)) {
    return false;
  }

  const nextMeaningfulLine = getNextMeaningfulLine(lines, nextIndex + 1);
  if (!nextMeaningfulLine) {
    return false;
  }

  if (isStandaloneSourceHeadingLine(nextMeaningfulLine) || isMarkdownThematicBreak(nextMeaningfulLine)) {
    return true;
  }

  const hitsKnownStructure = hasStructuralLabelStart(
    nextMeaningfulLine,
    stopLabels,
    {
      allowQuotePrefix: true,
      allowTightLabel: boundaryPolicy.allowTightLabels ?? true,
      allowMarkdownHeading: boundaryPolicy.allowMarkdownHeadings ?? true
    }
  );

  return hitsKnownStructure && isValidStructuralStopLine(nextMeaningfulLine, stopLabels, stopRules);
}

function collectBlockForLabels(
  sourceText: string,
  labels: string[],
  stopLabels: string[],
  blockedStartLabels: string[] = stopLabels,
  continuationLabels: string[] = [],
  boundaryPolicy: TemplateSectionBoundaryPolicyConfig = {},
  stopRules: SectionStopRule[] = []
): string {
  const candidates = uniqueLabels(labels);
  if (candidates.length === 0) {
    return "";
  }

  const effectiveStops = uniqueLabels(stopLabels).sort((left, right) => right.length - left.length);
  const blockedStarts = uniqueLabels([...blockedStartLabels, ...candidates]).sort((left, right) => right.length - left.length);
  const truncateSectionBlock = (value: string, currentLabel: string, labels: string[] = effectiveStops): string => {
    if (stopRules.length > 0 || boundaryPolicy.allowTightLabels === false) {
      return truncateSectionBlockAtStructuralStopLabel(value, labels, currentLabel, stopRules, {
        allowTightStructuralStops: boundaryPolicy.allowTightLabels !== false
      });
    }

    return truncateSectionBlockAtNextKnownLabel(value, labels, currentLabel);
  };
  const bestMatch = collectBestLabelBlock(sourceText, {
    labels: candidates,
    startOptions: {
      allowQuotePrefix: true,
      allowTightLabel: boundaryPolicy.allowTightLabels ?? true,
      allowMarkdownHeading: boundaryPolicy.allowMarkdownHeadings ?? true
    },
    shouldSkipStart: (line, label) => startsWithLongerKnownLabel(line, label, blockedStarts),
    shouldStopLine: ({ blockLines, nextLine, nextIndex, previousLine, lines }) => {
      const previousLineIsInternalContinuationLabel = hasStructuralLabelStart(
        previousLine,
        continuationLabels
      ) && /[：:]$/.test(previousLine.trim());
      const hitsNextField = !previousLineIsInternalContinuationLabel && hasStructuralLabelStart(
        nextLine,
        effectiveStops,
        {
          allowQuotePrefix: true,
          allowTightLabel: boundaryPolicy.allowTightLabels ?? true,
          allowMarkdownHeading: boundaryPolicy.allowMarkdownHeadings ?? true
        }
      ) && isValidStructuralStopLine(nextLine, effectiveStops, stopRules);
      const hitsInternalContinuationLabel = hasStructuralLabelStart(
        nextLine,
        continuationLabels,
        { allowQuotePrefix: true, allowTightLabel: true, allowMarkdownHeading: true }
      );
      const hitsNumberedHeadingBoundary =
        blockLines.length > 0 &&
        !hitsInternalContinuationLabel &&
        isNumberedHeadingStructuralBoundary(nextLine, lines, nextIndex, effectiveStops, stopRules, boundaryPolicy);
      return (
        hitsNextField ||
        hitsNumberedHeadingBoundary ||
        (
          blockLines.length > 0 &&
          isStandaloneSourceHeadingLine(nextLine) &&
          !hitsInternalContinuationLabel
        )
      );
    },
    mapValue: (rawValue, label) => {
      const selfContinuationMatch = rawValue.match(
        new RegExp(`^${escapeRegExp(label)}\\s*[：:]\\s*\\n\\s*([\\s\\S]+)$`)
      );
      const normalizedRawValue = selfContinuationMatch ? `${label}${selfContinuationMatch[1] ?? ""}` : rawValue;
      const continuationStopLabels = new Set(
        effectiveStops.filter((stopLabel) =>
          continuationLabels.some((continuationLabel) =>
            new RegExp(
              `(?:^|\\n)\\s*${escapeRegExp(continuationLabel)}\\s*[：:]\\s*\\n\\s*${escapeRegExp(stopLabel)}`
            ).test(normalizedRawValue)
          )
        )
      );
      const truncateStops = effectiveStops.filter((stopLabel) => !continuationStopLabels.has(stopLabel));
      return normalizeInlineLabelValue(truncateSectionBlock(normalizedRawValue, label, truncateStops));
    }
  });

  if (bestMatch?.value) {
    return bestMatch.value;
  }

  if (boundaryPolicy.allowInlineFallback === false) {
    return "";
  }

  const inlineMatch = candidates
    .map((label) => {
      const pattern = new RegExp(
        `(^|[\\s，,。；;、])${escapeRegExp(label)}\\s*(?:是|为|[=:：])?\\s*([^\\r\\n]+)`,
        "i"
      );
      const match = sourceText.match(pattern);
      if (match?.index !== undefined) {
        const labelStart = match.index + (match[1]?.length ?? 0);
        if (startsWithLongerKnownLabel(sourceText.slice(labelStart), label, blockedStarts)) {
          return "";
        }
      }

      const rawValue = match?.[2]?.trim();
      if (rawValue) {
        return truncateSectionBlock(rawValue, label);
      }

      if (label.length < 2 || !/\p{Script=Han}/u.test(label)) {
        return "";
      }

      const labelStart = sourceText.indexOf(label);
      if (labelStart < 0 || startsWithLongerKnownLabel(sourceText.slice(labelStart), label, blockedStarts)) {
        return "";
      }

      const rawCompactValue = sourceText.slice(labelStart + label.length).split(/\r?\n/)[0]?.trim() ?? "";
      return rawCompactValue ? truncateSectionBlock(rawCompactValue, label) : "";
    })
    .find((value) => value.trim().length > 0);

  return inlineMatch ?? "";
}

function collectInlineFieldGroupBlock(
  sourceText: string,
  groupLabels: string[],
  childLabels: string[],
  stopLabels: string[],
  boundaryPolicy: TemplateSectionBoundaryPolicyConfig = {},
  stopRules: SectionStopRule[] = []
): string {
  const candidates = uniqueLabels(groupLabels);
  if (candidates.length === 0) {
    return "";
  }

  const childLabelSet = new Set(childLabels.map((label) => label.trim()).filter(Boolean));
  const effectiveStops = uniqueLabels(stopLabels).sort((left, right) => right.length - left.length);
  const lines = sourceText.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = detectFirstStructuralLabelStart(line, candidates, {
      allowQuotePrefix: true,
      allowTightLabel: boundaryPolicy.allowTightLabels ?? true,
      allowMarkdownHeading: boundaryPolicy.allowMarkdownHeadings ?? true
    });
    if (!match) {
      continue;
    }

    const blockLines: string[] = [];
    if (match.value.trim()) {
      blockLines.push(match.value);
    }

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex] ?? "";
      const childMatch = detectFirstStructuralLabelStart(nextLine, childLabels, {
        allowQuotePrefix: true,
        allowTightLabel: true,
        allowMarkdownHeading: true
      });
      if (childMatch && childLabelSet.has(childMatch.label)) {
        blockLines.push(nextLine);
        continue;
      }

      if (
        decideSectionBoundaryLine(nextLine, effectiveStops, stopRules, {
          allowTightLabels: boundaryPolicy.allowTightLabels ?? true,
          allowMarkdownHeadings: boundaryPolicy.allowMarkdownHeadings ?? true
        }).matched
      ) {
        break;
      }

      if (isStandaloneSourceHeadingLine(nextLine)) {
        break;
      }

      blockLines.push(nextLine);
    }

    const block = trimBlockLines(blockLines);
    if (block) {
      return block;
    }
  }

  return "";
}

function collectSpokenFieldBlockValue(
  sourceText: string,
  labels: string[],
  stopLabels: string[],
  boundaryPolicy: TemplateSectionBoundaryPolicyConfig,
  stopRules: SectionStopRule[]
): string {
  const candidates = uniqueLabels(labels).sort((left, right) => right.length - left.length);
  if (candidates.length === 0) {
    return "";
  }

  const lines = sourceText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const matchedLabel = candidates.find((label) => {
      const pattern = new RegExp(`^${escapeRegExp(label)}\\s*(?:是|为)\\s*\\S`, "u");
      return pattern.test(trimmed);
    });
    if (!matchedLabel) {
      continue;
    }

    const rawValue = trimmed.replace(new RegExp(`^${escapeRegExp(matchedLabel)}\\s*(?:是|为)\\s*`, "u"), "");
    const truncatedValue = truncateSectionBlockAtStructuralStopLabel(
      rawValue,
      stopLabels,
      matchedLabel,
      stopRules,
      { allowTightStructuralStops: boundaryPolicy.allowTightLabels !== false }
    );
    return normalizeInlineLabelValue(truncatedValue);
  }

  return "";
}

function trimFieldBlockValueAtStopLine(
  value: string,
  stopLabels: string[],
  stopRules: SectionStopRule[],
  boundaryPolicy: TemplateSectionBoundaryPolicyConfig
): string {
  const lines = value.split(/\r?\n/);
  const keptLines: string[] = [];
  for (const line of lines) {
    if (
      keptLines.length > 0 &&
      decideSectionBoundaryLine(line, stopLabels, stopRules, {
        allowTightLabels: boundaryPolicy.allowTightLabels ?? true,
        allowMarkdownHeadings: boundaryPolicy.allowMarkdownHeadings ?? true
      }).matched
    ) {
      break;
    }

    keptLines.push(line);
  }

  return trimBlockLines(keptLines);
}

function createBoundaryPolicy(
  behavior: TemplateSectionConfig["behavior"] | undefined,
  fallback: TemplateSectionBoundaryPolicyConfig | undefined = {}
): TemplateSectionBoundaryPolicyConfig {
  return {
    ...fallback,
    ...(behavior?.boundaryPolicy ?? {})
  };
}

function createSectionBodyBoundaryPolicy(section: TemplateSectionConfig): TemplateSectionBoundaryPolicyConfig {
  return createBoundaryPolicy(section.behavior, {
    strictness: "structural",
    allowTightLabels: false,
    allowMarkdownHeadings: true,
    allowInlineFallback: false,
    truncationStrategy: "section-block"
  });
}

function createFieldBlockBoundaryPolicy(
  behavior: TemplateSectionConfig["behavior"] | undefined
): TemplateSectionBoundaryPolicyConfig {
  return createBoundaryPolicy(behavior, {
    strictness: "structural",
    allowTightLabels: true,
    allowMarkdownHeadings: true,
    allowInlineFallback: true,
    truncationStrategy: "section-block"
  });
}

function createTableCellBoundaryPolicy(
  behavior: TemplateSectionConfig["behavior"] | undefined
): TemplateSectionBoundaryPolicyConfig {
  return createBoundaryPolicy(behavior, {
    strictness: "structural",
    allowTightLabels: true,
    allowMarkdownHeadings: false,
    allowInlineFallback: true,
    truncationStrategy: "table-cell"
  });
}

function buildSectionBodyStopLabels(
  section: TemplateSectionConfig & { rawContent?: string },
  sectionLabels: string[],
  allSectionLabels: string[],
  allFieldLabels: string[]
): string[] {
  if (
    section.behavior?.kind === "repeatable_text" &&
    (section.behavior.entrySchemas?.length ?? 0) > 0
  ) {
    return uniqueLabels(allSectionLabels.filter((label) => !sectionLabels.includes(label)));
  }

  const normalizeStopLabel = (label: string): string =>
    label.trim().toLocaleLowerCase().replace(/\s/g, "");
  const sectionFieldLabels = new Set(
    [
      ...(section.fieldNames ?? []),
      ...extractDataviewInlineFieldNames(getRuntimeSectionRawContent(section)),
      ...extractDataviewInlineFieldDisplayLabels(getRuntimeSectionRawContent(section)),
      ...collectSectionBehaviorLabels(section)
    ]
      .map((label) => normalizeStopLabel(label))
      .filter(Boolean)
  );
  return uniqueLabels([
    ...allSectionLabels.filter((label) => !sectionLabels.includes(label)),
    ...allFieldLabels.filter((label) => !sectionFieldLabels.has(normalizeStopLabel(label)))
  ]);
}

function buildSectionStopRules(
  sections: TemplateSectionConfig[],
  currentSectionLabels: string[]
): SectionStopRule[] {
  const currentLabels = new Set(currentSectionLabels.map((label) => label.trim()).filter(Boolean));
  return sections
    .map((section): SectionStopRule => ({
      labels: uniqueLabels([
        section.title,
        section.behavior?.kind === "repeatable_text" ? section.behavior.entryLabel ?? "" : "",
        ...(section.behavior?.sourceAliases ?? [])
      ]).filter((label) => !currentLabels.has(label)),
      section,
      source: section,
      validateCandidate: (_label, value, rule) => {
        const ruleSection = rule.source ?? section;
        return validateSectionBoundaryCandidateForSection(value, ruleSection);
      }
    }))
    .filter((rule) => rule.labels.length > 0);
}

function buildMixedItemLabels(item: TemplateSectionMixedFieldBlockItemConfig): string[] {
  if (item.kind === "static_note") {
    return [];
  }

  if (item.kind === "inline_field_group") {
    return uniqueLabels([item.label, ...(item.aliases ?? [])]);
  }

  return uniqueLabels([item.label, item.targetFieldName ?? "", item.id, ...(item.aliases ?? [])]);
}

function buildMixedItemContentLabels(item: TemplateSectionMixedFieldBlockItemConfig): string[] {
  if (item.kind === "static_note") {
    return [];
  }

  if (item.kind === "inline_field_group") {
    return uniqueLabels([
      ...buildMixedItemLabels(item),
      ...item.fields.flatMap((field) => [field.fieldName, field.id, field.label, ...(field.aliases ?? [])])
    ]);
  }

  if (item.kind === "checkbox_enum") {
    return uniqueLabels([
      ...buildMixedItemLabels(item),
      ...item.options.flatMap((option) => [option.label, option.value, ...(option.aliases ?? [])])
    ]);
  }

  return buildMixedItemLabels(item);
}

function isValidMixedItemBoundaryCandidate(
  value: string,
  item: TemplateSectionMixedFieldBlockItemConfig
): boolean {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return true;
  }

  if (item.kind === "inline_field_group") {
    const childLabels = uniqueLabels(
      item.fields.flatMap((field) => [field.fieldName, field.id, field.label, ...(field.aliases ?? [])])
    );
    return hasStructuralLabelStart(normalizedValue, childLabels, {
      allowQuotePrefix: true,
      allowTightLabel: true,
      allowMarkdownHeading: true
    });
  }

  if (item.kind === "checkbox_enum") {
    return matchMixedOptionLabel(normalizedValue, item.options, "multi").trim().length > 0;
  }

  if (item.kind === "task_list") {
    return parseTaskListDraftItems(normalizedValue, item.taskPrefix ?? "- [ ] ").length > 0 ||
      normalizedValue.length > 0;
  }

  if (item.kind === "text_field") {
    return normalizedValue.length > 0;
  }

  return false;
}

function buildMixedItemStopRules(
  section: TemplateSectionConfig,
  behavior: TemplateSectionMixedFieldBlockBehaviorConfig,
  currentItem: TemplateSectionMixedFieldBlockItemConfig
): SectionStopRule[] {
  const currentLabels = new Set(buildMixedItemContentLabels(currentItem).map((label) => label.trim()).filter(Boolean));
  return behavior.items
    .filter((item) => item.kind !== "static_note" && item.id !== currentItem.id)
    .map((item): SectionStopRule => ({
      labels: buildMixedItemLabels(item).filter((label) => !currentLabels.has(label)),
      section,
      source: section,
      validateCandidate: (_label, value) => isValidMixedItemBoundaryCandidate(value, item)
    }))
    .filter((rule) => rule.labels.length > 0);
}

function collectSectionMixedItemLabels(section: TemplateSectionConfig): string[] {
  return section.behavior?.kind === "mixed_field_block"
    ? uniqueLabels(section.behavior.items.flatMap((item) => buildMixedItemLabels(item)))
    : [];
}

function buildRepeatableParserFieldNames(section: TemplateSectionConfig & { rawContent?: string }, sectionDescriptor: SectionStructureDescriptor): string[] {
  return uniqueLabels([
    ...(sectionDescriptor.fieldNames ?? []),
    ...(section.behavior?.kind === "repeatable_text"
      ? section.behavior.entrySchemas?.flatMap((schema) => schema.fieldNames ?? []) ?? []
      : []),
    ...extractDataviewInlineFieldNames(getRuntimeSectionRawContent(section))
  ]);
}

function buildRepeatableParserFieldAliases(
  fieldNames: string[],
  templateFields?: TemplateFieldContext | TemplateFieldConfig[]
): Record<string, string[]> {
  const templateFieldMap = new Map(
    resolveTemplateFieldContextFields(templateFields ?? []).map((field) => [field.name, field] as const)
  );
  return fieldNames.reduce<Record<string, string[]>>((aliasesByField, fieldName) => {
    const aliases = templateFieldMap.get(fieldName)?.aliases ?? [];
    if (aliases.length > 0) {
      aliasesByField[fieldName] = uniqueLabels(aliases);
    }
    return aliasesByField;
  }, {});
}

function buildRepeatableParserEntrySchemas(
  behavior: TemplateSectionRepeatableBehaviorConfig | undefined,
  section?: TemplateSectionConfig & { rawContent?: string }
): TemplateSectionRepeatableBehaviorConfig["entrySchemas"] {
  const rawSchemas = extractRepeatableInlineEntrySchemasFromRawContent(section ? getRuntimeSectionRawContent(section) : "");
  const schemas = behavior?.entrySchemas?.length
    ? behavior.entrySchemas
    : section?.fieldNames?.length
      ? [{
          entryLabel: rawSchemas?.find((schema) => schema.entryLabel?.trim())?.entryLabel,
          fieldNames: section.fieldNames
        }]
      : rawSchemas;
  return schemas
    ?.map((schema) => ({
      entryLabel: schema.entryLabel?.trim() || undefined,
      fieldNames: uniqueLabels(schema.fieldNames ?? [])
    }))
    .filter((schema) => schema.fieldNames.length > 0);
}

function buildRepeatableParserEntryLabel(
  behavior: TemplateSectionRepeatableBehaviorConfig | undefined,
  section: TemplateSectionConfig & { rawContent?: string }
): string | undefined {
  return behavior?.entryLabel?.trim() ||
    buildRepeatableParserEntrySchemas(behavior, section)?.find((schema) => schema.entryLabel?.trim())?.entryLabel;
}

function resolveRepeatableSectionParserId(
  section: TemplateSectionConfig & { rawContent?: string },
  sectionDescriptor: SectionStructureDescriptor,
  behavior: TemplateSectionRepeatableBehaviorConfig | undefined
): TemplateSectionParserId | undefined {
  if (sectionDescriptor.parserId || behavior?.parserId) {
    return sectionDescriptor.parserId ?? behavior?.parserId;
  }

  return extractRepeatableInlineEntrySchemasFromRawContent(getRuntimeSectionRawContent(section))
    ? "repeatable_inline_fields"
    : undefined;
}

function hasRepeatableInlineFieldDraft(content: string, fieldNames: string[]): boolean {
  const allowedFieldNames = new Set(fieldNames.map((fieldName) => fieldName.trim().toLocaleLowerCase()).filter(Boolean));
  if (allowedFieldNames.size < 2) {
    return false;
  }

  return content
    .split(/\r?\n/)
    .some((line) => {
      if (!/^\s*[-*+]\s+/u.test(line)) {
        return false;
      }

      const fieldMatches = Array.from(line.matchAll(/\[([^\]\r\n:]+)::[^\]]*\]/gu));
      return fieldMatches.filter((match) => allowedFieldNames.has((match[1] ?? "").trim().toLocaleLowerCase())).length >= 2;
    });
}

function parseImplicitRepeatableInlineFieldDraft(
  content: string,
  section: TemplateSectionConfig,
  repeatableFieldNames: string[],
  context: {
    behavior?: TemplateSectionRepeatableBehaviorConfig;
    sectionLabels: string[];
    stopLabels: string[];
    templateFields?: TemplateFieldContext | TemplateFieldConfig[];
  }
): { content: string; warnings: string[] } | undefined {
  if (section.kind !== "repeatable_entries" || !hasRepeatableInlineFieldDraft(content, repeatableFieldNames)) {
    return undefined;
  }

  const parser = resolveTemplateSectionParser("repeatable_inline_fields");
  return parser?.parse(content, {
    fieldNames: repeatableFieldNames,
    entryLabel: buildRepeatableParserEntryLabel(context.behavior, section),
    entrySchemas: buildRepeatableParserEntrySchemas(context.behavior, section),
    fieldAliases: buildRepeatableParserFieldAliases(repeatableFieldNames, context.templateFields),
    boundaryPolicy: createBoundaryPolicy(context.behavior, parser.boundaryPolicy),
    sectionLabels: context.sectionLabels,
    stopLabels: context.stopLabels
  });
}

function normalizeFallbackEvidenceText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function countSpokenRepeatableTimeRanges(sourceText: string): number {
  return sourceText
    .split(/[。；;\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) =>
      !!(
        matchLeadingTimeRangeEntry(part) ??
        matchEmbeddedTimeRangeEntry(part) ??
        matchEmbeddedTimePairEntry(part)
      )
    ).length;
}

function hasSpokenRepeatableIdentityEvidence(
  sourceText: string,
  section: TemplateSectionConfig,
  behavior: TemplateSectionRepeatableBehaviorConfig,
  parserId: TemplateSectionParserId | undefined
): boolean {
  if (parserId === "repeatable_inline_fields" && behavior.parserId === "repeatable_inline_fields") {
    return true;
  }

  const normalizedSource = normalizeFallbackEvidenceText(sourceText);
  return uniqueLabels([section.title, behavior.entryLabel ?? "", ...(behavior.sourceAliases ?? [])])
    .some((label) => {
      const normalizedLabel = normalizeFallbackEvidenceText(label);
      return normalizedLabel.length > 0 && normalizedSource.includes(normalizedLabel);
    });
}

function countSpokenRepeatableFieldLabelEvidence(
  sourceText: string,
  fieldNames: string[],
  templateFields?: TemplateFieldContext | TemplateFieldConfig[]
): number {
  const fieldAliases = buildRepeatableParserFieldAliases(fieldNames, templateFields);
  const normalizedSource = normalizeFallbackEvidenceText(sourceText);
  const timeFieldNames = new Set(fieldNames.slice(0, 2).map((fieldName) => normalizeFallbackEvidenceText(fieldName)));
  return fieldNames
    .filter((fieldName) => !timeFieldNames.has(normalizeFallbackEvidenceText(fieldName)))
    .filter((fieldName) => {
      const labels = uniqueLabels([fieldName, ...(fieldAliases[fieldName] ?? [])]);
      return labels.some((label) => {
        const escaped = escapeRegExp(normalizeFallbackEvidenceText(label));
        return escaped.length > 0 &&
          new RegExp(`(^|[\\s,，;；。.!！?？、])${escaped}(?:\\s+(?=\\S)|\\s*(?:是|为|=|:|：))`, "u").test(normalizedSource);
      });
    }).length;
}

function resolveSpokenRepeatableWholeSourceDecision(
  section: TemplateSectionConfig,
  sectionBody: string,
  sourceText: string,
  behavior: TemplateSectionRepeatableBehaviorConfig,
  parserId: TemplateSectionParserId | undefined,
  repeatableFieldNames: string[],
  templateFields?: TemplateFieldContext | TemplateFieldConfig[]
): SectionSourceDecision | undefined {
  if (
    sectionBody.trim() ||
    !behavior.allowSpokenWholeSourceFallback ||
    section.kind !== "repeatable_entries" ||
    parserId !== "repeatable_inline_fields" ||
    repeatableFieldNames.length < 4
  ) {
    return undefined;
  }

  const timeRangeCount = countSpokenRepeatableTimeRanges(sourceText);
  const fieldLabelCount = countSpokenRepeatableFieldLabelEvidence(sourceText, repeatableFieldNames, templateFields);
  const hasIdentityEvidence = hasSpokenRepeatableIdentityEvidence(sourceText, section, behavior, parserId);
  if (timeRangeCount < 2 || fieldLabelCount < 3 || !hasIdentityEvidence) {
    return undefined;
  }

  return {
    source: sourceText,
    scope: "whole_source",
    fallbackReason: "section_body_missing_with_spoken_repeatable_whole_source_fallback",
    warnings: ["未命中明确区块范围，已按显式启用的 repeatable 口述回补从整篇源文本解析，请确认未串入其他区块。"]
  };
}

function buildSectionContinuationLabels(section: TemplateSectionConfig, sectionDescriptor: SectionStructureDescriptor): string[] {
  return uniqueLabels([
    ...(section.fieldNames ?? []),
    ...buildRepeatableParserFieldNames(section, sectionDescriptor),
    ...collectSectionBehaviorLabels(section),
    ...(section.behavior?.kind === "grouped_field_block"
      ? section.behavior.groups.flatMap((group) => [group.id, ...buildGroupedBehaviorGroupLabels(group)])
      : [])
  ]);
}

function cloneFieldBlockDraft(entries: Record<string, string>): Record<string, string> {
  return Object.entries(entries).reduce<Record<string, string>>((next, [key, value]) => {
    next[key] = value;
    return next;
  }, {});
}

function mergeMissingDraftValues(
  primary: Record<string, string>,
  fallback: Record<string, string>
): Record<string, string> {
  const next = { ...primary };
  Object.entries(fallback).forEach(([key, value]) => {
    if ((next[key] ?? "").trim()) {
      return;
    }

    if (value.trim()) {
      next[key] = value;
    }
  });
  return next;
}

function cloneGroupedFieldBlockDraft(
  groups: Record<string, Record<string, string>>
): Record<string, Record<string, string>> {
  return Object.entries(groups).reduce<Record<string, Record<string, string>>>((next, [groupId, entries]) => {
    next[groupId] = cloneFieldBlockDraft(entries);
    return next;
  }, {});
}

function readTableCellValue(row: Record<string, string>, column: TemplateSectionBehaviorFieldConfig): string {
  return row[column.id] ?? row[column.label] ?? "";
}

function isTemplatePlaceholderValue(value: string): boolean {
  return /^\s*\{\{\s*[^{}\r\n]+?\s*\}\}\s*$/.test(value);
}

function cloneTableBlockDraft(rows: Array<Record<string, string>>): Array<Record<string, string>> {
  return rows.map((row) => cloneFieldBlockDraft(row));
}

function buildFieldLabelSet(fields: TemplateSectionBehaviorFieldConfig[]): string[] {
  return uniqueLabels(
    expandLabelVariants(fields.flatMap((field) => [field.id, field.label, ...(field.aliases ?? [])]))
  );
}

function buildFieldCandidateLabels(field: TemplateSectionBehaviorFieldConfig): string[] {
  return uniqueLabels(expandLabelVariants([field.id, field.label, ...(field.aliases ?? [])]));
}

function buildFieldIdentityLabels(field: TemplateSectionBehaviorFieldConfig): string[] {
  return uniqueLabels(expandLabelVariants([field.id, field.label]));
}

function buildSectionFieldCandidateLabels(
  section: TemplateSectionConfig,
  templateFields?: TemplateFieldContext | TemplateFieldConfig[]
): string[] {
  const fieldMap = new Map(
    resolveTemplateFieldContextFields(templateFields ?? []).map((field) => [field.name, field] as const)
  );
  return uniqueLabels(
    (section.fieldNames ?? []).flatMap((fieldName) => {
      const field = fieldMap.get(fieldName);
            return expandLabelVariants([fieldName, ...(field?.aliases ?? [])]);
    })
  );
}

function buildTemplateFieldAliasMap(
  fields: TemplateFieldContext | TemplateFieldConfig[] | undefined
): Map<string, string[]> {
  const currentFields = resolveTemplateFieldContextFields(fields ?? []);
  const aliasMap = new Map<string, string[]>();
  currentFields.forEach((field) => {
    const fieldName = field.name.trim();
    if (!fieldName) {
      return;
    }

    aliasMap.set(fieldName, uniqueLabels(field.aliases ?? []));
  });
  return aliasMap;
}

function findTemplateFieldByName(
  fields: TemplateFieldContext | TemplateFieldConfig[] | undefined,
  fieldName: string | undefined
): TemplateFieldConfig | undefined {
  const normalizedFieldName = fieldName?.trim() ?? "";
  if (!normalizedFieldName) {
    return undefined;
  }

  return resolveTemplateFieldContextFields(fields ?? []).find((field) => field.name.trim() === normalizedFieldName);
}

function resolveLinkedTemplateFields(
  fields: TemplateFieldContext | TemplateFieldConfig[] | undefined,
  fieldName: string | undefined,
  aliases: string[] = []
): TemplateFieldConfig[] {
  const currentFields = resolveTemplateFieldContextFields(fields ?? []);
  const identityLabels = uniqueLabels([fieldName ?? "", ...aliases]);
  const identityTokens = new Set(identityLabels.map(normalizeLooseCompareValue).filter(Boolean));
  return currentFields.filter((field) => {
    const fieldTokens = uniqueLabels([field.name, ...(field.aliases ?? [])])
      .map(normalizeLooseCompareValue)
      .filter(Boolean);
    return fieldTokens.some((token) => identityTokens.has(token));
  });
}

function applyLinkedOptionAliasesToMixedCheckboxItem(
  item: Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "checkbox_enum" }>,
  templateFields: TemplateFieldContext | TemplateFieldConfig[] | undefined
): Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "checkbox_enum" }> {
  const targetField = findTemplateFieldByName(templateFields, item.targetFieldName ?? item.label);
  const linkedFields = resolveLinkedTemplateFields(templateFields, targetField?.name ?? item.targetFieldName ?? item.label, [
    item.id,
    item.label,
    ...(item.aliases ?? []),
    ...(targetField?.aliases ?? [])
  ]).filter((field) => field.name.trim() !== targetField?.name.trim());
  const linkedOptionSets = linkedFields
    .map((field) => field.checkboxOptions ?? [])
    .filter((options) => options.length === item.options.length);
  if (linkedOptionSets.length === 0) {
    return item;
  }

  return {
    ...item,
    options: item.options.map((option, optionIndex) => ({
      ...option,
      aliases: uniqueLabels([
        ...(option.aliases ?? []),
        ...linkedOptionSets.map((options) => options[optionIndex] ?? "").filter(Boolean)
      ])
    }))
  };
}

function buildSectionDescriptorMap(
  descriptor: TemplateStructureDescriptor | undefined
): Map<string, SectionStructureDescriptor> {
  return new Map((descriptor?.sections ?? []).map((section) => [section.id, section] as const));
}

function resolveSectionDescriptor(
  section: TemplateSectionConfig,
  descriptorMap: Map<string, SectionStructureDescriptor>
): SectionStructureDescriptor {
  return descriptorMap.get(section.id) ?? buildSectionStructureDescriptor(section);
}

function buildSectionDraftTrace(
  section: TemplateSectionConfig,
  descriptor: SectionStructureDescriptor,
  kind: TemplateSectionDraftTraceKind,
  sourceDecision?: SectionSourceDecision
): TemplateSectionDraftTrace {
  return {
    sectionId: section.id,
    sectionTitle: descriptor.title,
    kind,
    sectionKind: descriptor.kind,
    behaviorKind: descriptor.behaviorKind,
    parserId: descriptor.parserId,
    sourceScope: sourceDecision?.scope,
    fallbackReason: sourceDecision?.fallbackReason,
    features: [...descriptor.features],
    evidence: descriptor.evidence.map((item) => ({ ...item }))
  };
}

function matchMixedOptionLabel(
  rawValue: string,
  options: TemplateSectionMixedFieldBlockOptionConfig[],
  mode: "single" | "multi" = "multi"
): string {
  const normalizedRaw = normalizeLooseCompareValue(rawValue);
  if (!normalizedRaw) {
    return rawValue.trim();
  }

  const matched = options
    .map((option) => {
      const candidates = [option.label, option.value, ...(option.aliases ?? [])]
        .map(normalizeLooseCompareValue)
        .filter(Boolean);
      const matchIndex = candidates.reduce<number>((bestIndex, candidate) => {
        if (candidate === normalizedRaw || candidate.includes(normalizedRaw)) {
          return Math.min(bestIndex, 0);
        }

        const index = normalizedRaw.indexOf(candidate);
        return index >= 0 ? Math.min(bestIndex, index) : bestIndex;
      }, Number.POSITIVE_INFINITY);
      return Number.isFinite(matchIndex) ? { option, matchIndex } : null;
    })
    .filter((entry): entry is { option: TemplateSectionMixedFieldBlockOptionConfig; matchIndex: number } => entry !== null)
    .sort((left, right) => left.matchIndex - right.matchIndex);

  if (matched.length === 0) {
    return rawValue.trim();
  }

  if (mode === "single") {
    return matched[0]?.option.label ?? rawValue.trim();
  }

  return matched.map((entry) => entry.option.label).join("；");
}

function extractCompletedOptionText(rawValue: string): string {
  const trimmed = rawValue.trim();
  const match = trimmed.match(
    /(?:已完成|完成了?|做完了?|结束了?)(?:[：:]\s*|\s+|(?![，,]))([^。.!！?？\n]+)/
  );
  return match?.[1]?.trim() ?? "";
}

function stripCompletedOptionText(rawValue: string): string {
  return rawValue
    .replace(
      /(?:已完成|完成了?|做完了?|结束了?)(?:[：:]\s*|\s+|(?![，,]))[^。.!！?？\n]+/g,
      ""
    )
    .trim();
}

function buildPrefixPattern(prefix: string): string {
  return prefix
    .trim()
    .split(/\s+/)
    .map((part) => escapeRegExp(part))
    .join("\\s*");
}

interface TaskMetadataDefinition {
  key: string;
  symbols: string[];
  valuePattern: string;
  forceChecked?: boolean;
  naturalLabels?: string[];
}

interface ExtractedTaskMetadataToken {
  key: string;
  token: string;
  value: string;
  forceChecked?: boolean;
}

interface NormalizedTaskItem {
  content: string;
  checked: boolean;
  tokens: ExtractedTaskMetadataToken[];
  line: string;
  matchKey: string;
}

const TASK_METADATA_DEFINITIONS: TaskMetadataDefinition[] = [
  {
    key: "created",
    symbols: ["➕"],
    valuePattern: "\\d{4}-\\d{2}-\\d{2}",
    naturalLabels: ["创建", "记录于", "created"]
  },
  {
    key: "start",
    symbols: ["🛫"],
    valuePattern: "\\d{4}-\\d{2}-\\d{2}",
    naturalLabels: ["开始", "开工", "start", "started"]
  },
  {
    key: "scheduled",
    symbols: ["⏳"],
    valuePattern: "\\d{4}-\\d{2}-\\d{2}",
    naturalLabels: ["计划", "安排", "scheduled"]
  },
  {
    key: "due",
    symbols: ["📅", "🗓️"],
    valuePattern: "\\d{4}-\\d{2}-\\d{2}",
    naturalLabels: ["截止", "到期", "due", "deadline"]
  },
  {
    key: "cancelled",
    symbols: ["❌"],
    valuePattern: "\\d{4}-\\d{2}-\\d{2}",
    naturalLabels: ["取消", "作废", "cancelled", "canceled"]
  },
  {
    key: "done",
    symbols: ["✅"],
    valuePattern: "\\d{4}-\\d{2}-\\d{2}",
    forceChecked: true,
    naturalLabels: ["已完成", "完成于", "完成", "done", "completed"]
  },
  {
    key: "reminder",
    symbols: ["⏰"],
    valuePattern: "\\d{4}-\\d{2}-\\d{2}(?:\\s+\\d{2}:\\d{2})?"
  }
];

const COMPLETED_ONLY_TASK_LINE_LABELS = [
  "已完成",
  "完成",
  "做完",
  "搞定",
  "done",
  "completed"
];
const COMPLETED_ONLY_TASK_HINT_SEPARATOR_PATTERN = "[：:\\s]+";
const COMPLETED_ONLY_TASK_HINT_LINE_SEPARATOR_PATTERN = "[：:]|\\s+";
const COMPLETED_OPTION_HINT_SEPARATOR_PATTERN = "[：:]\\s*|\\s+";

function normalizeTaskPrefix(prefix: string): string {
  return /\s$/.test(prefix) ? prefix : `${prefix.trimEnd()} `;
}

function buildCheckedTaskPrefix(prefix: string): string {
  return normalizeTaskPrefix(prefix).replace(/\[(?: |x|X)\]/, "[x]");
}

function buildTaskMetadataTokenId(token: ExtractedTaskMetadataToken): string {
  return `${token.key}:${token.value}`;
}

function appendUniqueMetadata(target: ExtractedTaskMetadataToken[], token: ExtractedTaskMetadataToken): void {
  const tokenId = buildTaskMetadataTokenId(token);
  if (!target.some((item) => buildTaskMetadataTokenId(item) === tokenId)) {
    target.push(token);
  }
}

function collapseInlineWhitespace(value: string): string {
  return value.replace(/\s{2,}/g, " ").trim();
}

function formatTaskLine(
  content: string,
  checked: boolean,
  tokens: ExtractedTaskMetadataToken[],
  taskPrefix: string
): string {
  const uncheckedPrefix = normalizeTaskPrefix(taskPrefix);
  const checkedPrefix = buildCheckedTaskPrefix(taskPrefix);
  const metadataSuffix = tokens.map((token) => token.token).join(" ").trim();
  const finalContent = collapseInlineWhitespace(
    [content.trim(), metadataSuffix].filter((part) => part.length > 0).join(" ")
  );

  if (!finalContent) {
    return "";
  }

  return `${checked ? checkedPrefix : uncheckedPrefix}${finalContent}`;
}

function buildTaskMetadataRegex(definition: TaskMetadataDefinition): RegExp {
  const symbolsPattern = definition.symbols.map((symbol) => escapeRegExp(symbol)).join("|");
  return new RegExp(`(?:^|\\s)(${symbolsPattern})\\s*(${definition.valuePattern})(?=$|\\s)`, "gu");
}

function buildNaturalTaskMetadataRegex(definition: TaskMetadataDefinition): RegExp | null {
  if (!definition.naturalLabels || definition.naturalLabels.length === 0) {
    return null;
  }

  const labelsPattern = definition.naturalLabels.map((label) => escapeRegExp(label)).join("|");
  return new RegExp(`(?:^|\\s)(?:${labelsPattern})\\s*[:：]?\\s*(${definition.valuePattern})(?=$|\\s)`, "giu");
}

function extractTaskMetadataTokens(
  rawContent: string
): { content: string; tokens: ExtractedTaskMetadataToken[]; checked: boolean } {
  let content = rawContent;
  const tokens: ExtractedTaskMetadataToken[] = [];
  let checked = false;

  TASK_METADATA_DEFINITIONS.forEach((definition) => {
    content = content.replace(buildTaskMetadataRegex(definition), (_match, symbol: string, value: string) => {
      appendUniqueMetadata(tokens, {
        key: definition.key,
        token: `${symbol} ${value}`.trim(),
        value,
        forceChecked: definition.forceChecked
      });
      if (definition.forceChecked) {
        checked = true;
      }
      return " ";
    });

    const naturalRegex = buildNaturalTaskMetadataRegex(definition);
    if (!naturalRegex) {
      return;
    }

    content = content.replace(naturalRegex, (_match, value: string) => {
      appendUniqueMetadata(tokens, {
        key: definition.key,
        token: `${definition.symbols[0]} ${value}`.trim(),
        value,
        forceChecked: definition.forceChecked
      });
      if (definition.forceChecked) {
        checked = true;
      }
      return " ";
    });
  });

  return {
    content: collapseInlineWhitespace(content),
    tokens,
    checked
  };
}

function stripPostfixedCompletedTaskMarker(rawContent: string, enabled: boolean = false): { content: string; checked: boolean } {
  if (!enabled) {
    return { content: rawContent, checked: false };
  }

  const labelsPattern = COMPLETED_ONLY_TASK_LINE_LABELS.map((label) => escapeRegExp(label)).join("|");
  if (!labelsPattern) {
    return { content: rawContent, checked: false };
  }

  const pattern = new RegExp(`([。.!！?？]+)(?:${labelsPattern})\\s*$`, "i");
  const content = rawContent.replace(pattern, "").trim();
  return {
    content: content || rawContent,
    checked: content.length > 0 && content !== rawContent.trim()
  };
}

function splitPostfixedCompletedTaskFragments(rawContent: string, enabled: boolean = false): string[] {
  if (!enabled) {
    return [rawContent];
  }

  const labelsPattern = COMPLETED_ONLY_TASK_LINE_LABELS.map((label) => escapeRegExp(label)).join("|");
  if (!labelsPattern) {
    return [rawContent];
  }

  const match = rawContent.match(new RegExp(`^(.+?)([。.!！?？]+)(?:${labelsPattern})(?![\\s，,：:])(.+)$`, "i"));
  if (!match) {
    return [rawContent];
  }

  const firstTask = match[1]?.trim() ?? "";
  const nextTask = match[3]?.trim() ?? "";
  return [
    firstTask ? `${firstTask}。已完成` : "",
    nextTask ? `已完成：${nextTask}` : ""
  ].filter(Boolean);
}

function splitFieldBackedTaskFragments(rawContent: string, enabled: boolean = false): string[] {
  const postfixedFragments = splitPostfixedCompletedTaskFragments(rawContent, enabled);
  if (!enabled) {
    return postfixedFragments;
  }

  const labelsPattern = COMPLETED_ONLY_TASK_LINE_LABELS.map((label) => escapeRegExp(label)).join("|");
  if (!labelsPattern) {
    return postfixedFragments;
  }

  return postfixedFragments.flatMap((fragment) => {
    const match = fragment.match(new RegExp(`^(.+?)[。.!！?？]+\\s*((?:${labelsPattern})(?:[：:]\\s*|\\s+).+)$`, "i"));
    if (!match) {
      return [fragment];
    }

    return [match[1]?.trim() ?? "", match[2]?.trim() ?? ""].filter(Boolean);
  });
}

function splitTaskDraftTextPreservingCompletedHints(value: string): string[] {
  const labelsPattern = COMPLETED_ONLY_TASK_LINE_LABELS.map((label) => escapeRegExp(label)).join("|");
  if (!labelsPattern) {
    return splitTaskSelectionText(value);
  }

  const markerPattern = new RegExp(`(?:${labelsPattern})(?:[：:]\\s*|\\s+|(?=\\S))`, "giu");
  const parts: string[] = [];
  let segmentStart = 0;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(value)) !== null) {
    const markerStart = match.index;
    const markerText = match[0] ?? "";
    const previousChar = markerStart > 0 ? value.charAt(markerStart - 1) : "";
    if (markerStart > 0 && !/[。.!！?？；;\n]/u.test(previousChar)) {
      continue;
    }
    const isTightMarker = !/[：:\s]$/u.test(markerText);
    if (isTightMarker) {
      const nextChar = value.charAt(markerPattern.lastIndex);
      if (!nextChar || /[，,：:\s]/u.test(nextChar)) {
        continue;
      }
    }

    const beforeMarker = value.slice(segmentStart, markerStart);
    parts.push(...splitTaskSelectionText(beforeMarker));
    const nextMarkerMatch = value.slice(markerPattern.lastIndex).search(
      new RegExp(`[。.!！?？；;\\n]\\s*(?:${labelsPattern})(?:[：:]\\s*|\\s+)`, "iu")
    );
    const markerLabel = markerText.match(new RegExp(`^(?:${labelsPattern})`, "iu"))?.[0] ?? markerText;
    if (nextMarkerMatch >= 0) {
      const hintEnd = markerPattern.lastIndex + nextMarkerMatch + 1;
      const hintText = value.slice(markerPattern.lastIndex, hintEnd).trim();
      parts.push(isTightMarker ? `${markerLabel}：${hintText}` : value.slice(markerStart, hintEnd).trim());
      segmentStart = hintEnd;
      markerPattern.lastIndex = hintEnd;
      continue;
    }

    const hintText = value.slice(markerPattern.lastIndex).trim();
    parts.push(isTightMarker ? `${markerLabel}：${hintText}` : value.slice(markerStart).trim());
    segmentStart = value.length;
    break;
  }

  if (segmentStart < value.length) {
    parts.push(...splitTaskSelectionText(value.slice(segmentStart)));
  }

  return parts.map((part) => part.trim()).filter(Boolean);
}

function buildNormalizedTaskItem(
  rawContent: string,
  checked: boolean,
  taskPrefix: string,
  allowPostfixedCompletedMarker: boolean = false
): NormalizedTaskItem | null {
  const markdownTaskMatch = rawContent.trim().match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
  const taskContent = markdownTaskMatch ? markdownTaskMatch[2]?.trim() ?? "" : rawContent;
  const markdownChecked = markdownTaskMatch ? markdownTaskMatch[1]?.toLowerCase() === "x" : false;
  const postfixedCompletion = stripPostfixedCompletedTaskMarker(taskContent, allowPostfixedCompletedMarker);
  const extraction = extractTaskMetadataTokens(postfixedCompletion.content);
  const content = extraction.content.trim();
  const resolvedChecked = checked || markdownChecked || postfixedCompletion.checked || extraction.checked;
  const line = formatTaskLine(content, resolvedChecked, extraction.tokens, taskPrefix);

  if (!content || !line) {
    return null;
  }

  return {
    content,
    checked: resolvedChecked,
    tokens: extraction.tokens,
    line,
    matchKey: normalizeLooseCompareValue(content)
  };
}

function parseMarkdownTaskLine(line: string, taskPrefix: string): NormalizedTaskItem | null {
  const taskMatch = line.trim().match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (!taskMatch) {
    return null;
  }

  return buildNormalizedTaskItem(taskMatch[2]?.trim() ?? "", taskMatch[1]?.toLowerCase() === "x", taskPrefix);
}

function parsePlainTaskLine(line: string, taskPrefix: string, allowPostfixedCompletedMarker: boolean = false): NormalizedTaskItem[] {
  const taskMatch = line.trim().match(/^[-*+]\s+(?!\[[ xX]\]\s+)(.+)$/);
  if (!taskMatch) {
    return [];
  }

  const item = buildNormalizedTaskItem(taskMatch[1]?.trim() ?? "", false, taskPrefix, allowPostfixedCompletedMarker);
  return item ? [item] : [];
}

function splitTaskSelectionText(value: string): string[] {
  return value
    .split(/[，,;；、]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function lineStartsWithCompletedOnlyTaskHint(line: string): boolean {
  const labelsPattern = COMPLETED_ONLY_TASK_LINE_LABELS.map((label) => escapeRegExp(label)).join("|");
  return new RegExp(`^\\s*(?:${labelsPattern})(?:${COMPLETED_ONLY_TASK_HINT_LINE_SEPARATOR_PATTERN})`, "i").test(line);
}

function extractCompletedOnlyTaskHintTexts(
  sourceText: string,
  options: { includeCommaHints?: boolean } = {}
): string[] {
  const labelsPattern = COMPLETED_ONLY_TASK_LINE_LABELS.map((label) => escapeRegExp(label)).join("|");
  const separatorPattern = options.includeCommaHints
    ? `${COMPLETED_ONLY_TASK_HINT_LINE_SEPARATOR_PATTERN}|[，,]\\s*`
    : COMPLETED_ONLY_TASK_HINT_LINE_SEPARATOR_PATTERN;
  const pattern = new RegExp(
    `(?:^|[\\r\\n。.!！?？；;])\\s*(?:${labelsPattern})(?:${separatorPattern})\\s*([^\\r\\n。.!！?？；;]+)`,
    "gi"
  );
  const hints: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sourceText)) !== null) {
    const value = match[1]?.trim() ?? "";
    if (value) {
      hints.push(value);
    }
  }
  return hints;
}

function stripCompletedOnlyTaskHintLines(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !lineStartsWithCompletedOnlyTaskHint(line))
    .join("\n");
}

function matchTemplateTaskSelections(value: string, templateItems: NormalizedTaskItem[], taskPrefix: string): NormalizedTaskItem[] {
  if (templateItems.length === 0) {
    return [];
  }

  const fragments = splitTaskSelectionText(value);
  if (fragments.length === 0) {
    return [];
  }

  const matchedItems: NormalizedTaskItem[] = [];
  const remainingItems = [...templateItems];
  fragments.forEach((fragment) => {
    const candidate = buildNormalizedTaskItem(fragment, true, taskPrefix);
    if (!candidate) {
      return;
    }

    const matchedIndex = remainingItems.findIndex((item) => matchTaskItems(candidate, item));
    if (matchedIndex < 0) {
      return;
    }

    const matchedItem = remainingItems.splice(matchedIndex, 1)[0];
    if (!matchedItem) {
      return;
    }

    matchedItems.push({
      ...matchedItem,
      checked: true,
      line: formatTaskLine(matchedItem.content, true, matchedItem.tokens, taskPrefix)
    });
  });

  return matchedItems;
}

function matchMentionedTemplateTaskItems(
  content: string,
  templateItems: NormalizedTaskItem[],
  taskPrefix: string,
  existingItems: NormalizedTaskItem[] = []
): NormalizedTaskItem[] {
  if (templateItems.length === 0) {
    return [];
  }

  const normalizedContent = normalizeLooseCompareValue(content);
  if (!normalizedContent) {
    return [];
  }

  return templateItems
    .filter((item) => {
      if (!item.matchKey || !normalizedContent.includes(item.matchKey)) {
        return false;
      }

      return !existingItems.some((existingItem) => matchTaskItems(existingItem, item));
    })
    .map((item) => ({
      ...item,
      checked: true,
      line: formatTaskLine(item.content, true, item.tokens, taskPrefix)
    }));
}

function stripUnsupportedCommaCompletedHintFragments(value: string): string {
  return value.replace(
    /(^|[。.!！?？；;\n]\s*)(已完成|完成了?|做完了?|结束了?)\s*[，,][^。.!！?？；;\n]*/g,
    (_match, prefix: string) => prefix ?? ""
  );
}

function joinDanglingCompletedHintContinuations(value: string): string {
  const labelsPattern = COMPLETED_ONLY_TASK_LINE_LABELS.map((label) => escapeRegExp(label)).join("|");
  if (!labelsPattern) {
    return value;
  }

  return value.replace(
    new RegExp(`((?:${labelsPattern})(?:[：:]\\s*|\\s+))\\r?\\n\\s*([^\\r\\n：:]+)`, "giu"),
    (_match, prefix: string, continuation: string) => `${prefix}${continuation.trim()}`
  );
}

function parseCompletedOnlyTaskLine(
  line: string,
  taskPrefix: string,
  templateItems: NormalizedTaskItem[] = [],
  allowTightHint: boolean = true,
  allowPostfixedCompletedMarker: boolean = false
): NormalizedTaskItem[] {
  const labelsPattern = COMPLETED_ONLY_TASK_LINE_LABELS.map((label) => escapeRegExp(label)).join("|");
  const separatorPattern = allowTightHint ? COMPLETED_ONLY_TASK_HINT_SEPARATOR_PATTERN : COMPLETED_ONLY_TASK_HINT_LINE_SEPARATOR_PATTERN;
  const match = line.trim().match(new RegExp(`^(?:${labelsPattern})(?:${separatorPattern})(.+)$`, "i"));
  if (!match) {
    return [];
  }

  const matchedTemplateItems = matchTemplateTaskSelections(match[1] ?? "", templateItems, taskPrefix);
  const fragments = splitTaskSelectionText(match[1] ?? "");
  if (matchedTemplateItems.length > 0 && matchedTemplateItems.length === fragments.length) {
    return matchedTemplateItems;
  }

  return fragments
    .map((part) => buildNormalizedTaskItem(part.trim(), true, taskPrefix, allowPostfixedCompletedMarker))
    .filter((item): item is NormalizedTaskItem => item !== null);
}

function parseCompactTaskSelectionLine(line: string, taskPrefix: string, templateItems: NormalizedTaskItem[] = []): NormalizedTaskItem[] {
  const normalizedLine = line.trim();
  if (!normalizedLine || !/[;；、]/.test(normalizedLine)) {
    return [];
  }

  if (/[。！？!?]/.test(normalizedLine)) {
    return [];
  }

  const matchedTemplateItems = matchTemplateTaskSelections(normalizedLine, templateItems, taskPrefix);
  if (matchedTemplateItems.length > 0 && matchedTemplateItems.length === splitTaskSelectionText(normalizedLine).length) {
    return matchedTemplateItems;
  }

  if (templateItems.length > 0 && /^[^\r\n：:]{2,40}[：:]/u.test(normalizedLine)) {
    return matchedTemplateItems;
  }

  return normalizedLine
    .split(/[;；、]+/)
    .map((part) => buildNormalizedTaskItem(part.trim(), true, taskPrefix))
    .filter((item): item is NormalizedTaskItem => item !== null);
}

function parseTaskListDraftItems(
  content: string,
  taskPrefix: string,
  templateItems: NormalizedTaskItem[] = [],
  options: { allowPostfixedCompletedMarker?: boolean } = {}
): NormalizedTaskItem[] {
  const taskContent = joinDanglingCompletedHintContinuations(content);
  const normalizedContentForMentionedOptions = stripUnsupportedCommaCompletedHintFragments(taskContent);
  const parsedItems = taskContent
    .split(/\r?\n/)
    .flatMap((line) =>
      splitCompactSourceLine(line, {
        boundaryPatterns: [COMPACT_MARKDOWN_TASK_BOUNDARY, COMPACT_PLAIN_BULLET_BOUNDARY]
      })
    )
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const completedOnlyItems = parseCompletedOnlyTaskLine(
        line,
        taskPrefix,
        templateItems,
        content.trim() === line,
        options.allowPostfixedCompletedMarker ?? false
      );
      if (completedOnlyItems.length > 0) {
        return completedOnlyItems;
      }

      const compactItems = parseCompactTaskSelectionLine(line, taskPrefix, templateItems);
      if (compactItems.length > 0) {
        return compactItems;
      }

      const markdownItem = parseMarkdownTaskLine(line, taskPrefix);
      if (markdownItem) {
        return [markdownItem];
      }

      return parsePlainTaskLine(line, taskPrefix, options.allowPostfixedCompletedMarker ?? false);
    });
  if (parsedItems.length > 0) {
    return [
      ...parsedItems,
      ...matchMentionedTemplateTaskItems(normalizedContentForMentionedOptions, templateItems, taskPrefix, parsedItems)
    ];
  }

  if (templateItems.length > 0) {
    const matchedTemplateItems = matchMentionedTemplateTaskItems(normalizedContentForMentionedOptions, templateItems, taskPrefix);
    if (matchedTemplateItems.length > 0) {
      return matchedTemplateItems;
    }
  }

  const meaningfulLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (meaningfulLines.length < 2 || meaningfulLines.some((line) => !/[。.!！?？]$/.test(line))) {
    return [];
  }

  return meaningfulLines
    .map((line) => buildNormalizedTaskItem(line, false, taskPrefix, options.allowPostfixedCompletedMarker ?? false))
    .filter((item): item is NormalizedTaskItem => item !== null);
}

function normalizeTaskListDraft(
  content: string,
  taskPrefix: string,
  templateItems: NormalizedTaskItem[] = [],
  options: { allowPostfixedCompletedMarker?: boolean } = {}
): string {
  return parseTaskListDraftItems(content, taskPrefix, templateItems, options)
    .map((item) => item.line)
    .join("\n")
    .trim();
}

function normalizeFieldBackedTaskListDraft(content: string, taskPrefix: string): string {
  return normalizeMixedTaskListDraft(content, taskPrefix, [], { allowPostfixedCompletedMarker: true });
}

function uniqueTaskItemsPreferChecked(items: NormalizedTaskItem[], taskPrefix: string): NormalizedTaskItem[] {
  const byKey = new Map<string, NormalizedTaskItem>();
  items.forEach((item) => {
    const key = item.matchKey || item.content;
    const existing = byKey.get(key);
    if (!existing || (!existing.checked && item.checked)) {
      const nextChecked = existing?.checked || item.checked;
      const existingContent = existing?.content;
      const content = existingContent && existingContent.length < item.content.length
        ? existingContent
        : item.content;
      byKey.set(key, {
        ...item,
        content,
        checked: nextChecked,
        line: formatTaskLine(content, nextChecked, mergeTaskMetadataTokens(existing?.tokens ?? [], item.tokens), taskPrefix)
      });
    }
  });
  return [...byKey.values()];
}

function normalizeMixedTaskListDraft(
  content: string,
  taskPrefix: string,
  templateItems: NormalizedTaskItem[] = [],
  options: { allowPostfixedCompletedMarker?: boolean } = {}
): string {
  const taskContent = joinDanglingCompletedHintContinuations(content);
  const parseFallbackItems = (): NormalizedTaskItem[] => {
    const fallbackContent = options.allowPostfixedCompletedMarker
      ? stripUnsupportedCommaCompletedHintFragments(taskContent)
      : taskContent;

    return fallbackContent
      .split(/\r?\n/)
      .map((line) => stripCompletedOnlyTaskHintLines(line))
      .join("\n")
      .split(/\n+/)
      .flatMap((line) => splitTaskDraftTextPreservingCompletedHints(line))
      .map((part) => part.trim())
      .filter(Boolean)
      .flatMap((part) => splitFieldBackedTaskFragments(part, options.allowPostfixedCompletedMarker ?? false))
      .flatMap((part) => {
        const completedOnlyItems = parseCompletedOnlyTaskLine(
          part,
          taskPrefix,
          [],
          false,
          options.allowPostfixedCompletedMarker ?? false
        );
        return completedOnlyItems.length > 0
          ? completedOnlyItems
          : [buildNormalizedTaskItem(part, false, taskPrefix, options.allowPostfixedCompletedMarker ?? false)];
      })
      .filter((item): item is NormalizedTaskItem => item !== null)
      .filter((item) => !(options.allowPostfixedCompletedMarker && isCompletedOnlyTaskHintItem(item)));
  };

  const parsedItems = parseTaskListDraftItems(taskContent, taskPrefix, templateItems, options);
  if (parsedItems.length > 0) {
    if (templateItems.length > 0) {
      return uniqueTaskItemsPreferChecked([...templateItems, ...parsedItems], taskPrefix)
        .filter((item) => !(options.allowPostfixedCompletedMarker && isCompletedOnlyTaskHintItem(item)))
        .map((item) => item.line)
        .join("\n")
        .trim();
    }

    const fallbackItems = options.allowPostfixedCompletedMarker && templateItems.length === 0
      ? parseFallbackItems()
      : [];
    return uniqueTaskItemsPreferChecked([...fallbackItems, ...parsedItems], taskPrefix)
      .filter((item) => !(options.allowPostfixedCompletedMarker && isCompletedOnlyTaskHintItem(item)))
      .map((item) => item.line)
      .join("\n")
      .trim();
  }

  return parseFallbackItems()
    .reduce<NormalizedTaskItem[]>((items, item) => uniqueTaskItemsPreferChecked([...items, item], taskPrefix), [])
    .map((item) => item.line)
    .join("\n")
    .trim();
}

function appendTaskCompletionHintsToDraftContent(
  content: string,
  sourceText: string,
  templateItems: NormalizedTaskItem[] = [],
  taskPrefix: string = "- [ ] "
): string {
  const labelsPattern = COMPLETED_ONLY_TASK_LINE_LABELS.map((label) => escapeRegExp(label)).join("|");
  if (!labelsPattern) {
    return content;
  }

  const hints = extractCompletedOnlyTaskHintTexts(sourceText, {
    includeCommaHints: false
  });
  if (hints.length === 0) {
    return content;
  }

  const normalizedContent = normalizeLooseCompareValue(content);
  const matchingHints = templateItems.length > 0
    ? hints.flatMap((hint) =>
      matchTemplateTaskSelections(hint, templateItems, taskPrefix)
        .map((item) => `已完成：${item.content}`)
    )
    : content.trim().length === 0
    ? hints.map((hint) => `已完成：${hint.trim()}`)
    : hints.flatMap((hint) => {
      const fragments = splitTaskSelectionText(hint);
      return fragments
        .filter((fragment) => {
          const normalizedFragment = normalizeLooseCompareValue(fragment);
          return normalizedFragment.length > 0 && (
            normalizedContent.includes(normalizedFragment) ||
            normalizedFragment.includes(normalizedContent)
          );
        })
        .map((fragment) => `已完成：${fragment}`);
    });

  return [content.trim(), ...matchingHints]
    .filter((part) => part.length > 0)
    .join("\n");
}

function trimMixedTextFieldValue(value: string): string {
  return value.trim().replace(/[。．.]+$/u, "").trim();
}

function stripLeadingInlineLabel(value: string, labels: string[]): string {
  const normalizedLabels = uniqueLabels(labels).sort((left, right) => right.length - left.length);
  const trimmed = value.trim();
  const matchedLabel = normalizedLabels.find((label) =>
    new RegExp(`^${escapeRegExp(label)}\\s*[：:，,。.;；、|｜/\\\\\\-—–~·]?\\s*`).test(trimmed)
  );
  if (!matchedLabel) {
    return trimmed;
  }

  return normalizeInlineLabelValue(
    trimmed.replace(
      new RegExp(`^${escapeRegExp(matchedLabel)}\\s*[：:，,。.;；、|｜/\\\\\\-—–~·]?\\s*`),
      ""
    )
  );
}

function truncateMixedTextFieldAtTaskCompletionHint(value: string, taskLabels: string[]): string {
  const labels = uniqueLabels([...COMPLETED_ONLY_TASK_LINE_LABELS, ...taskLabels])
    .sort((left, right) => right.length - left.length);
  let nextValue = value.trim();
  labels.forEach((label) => {
    nextValue = truncateSectionBlockAtNextKnownLabel(nextValue, [label], label);
  });
  return nextValue.trim();
}

function parsePlainBulletFragments(content: string): string[] {
  return splitCompactSourceText(content, {
    boundaryPatterns: [COMPACT_PLAIN_BULLET_BOUNDARY]
  })
    .replace(/\r?\n/g, "\n")
    .split(/(?:^|[\n，,；;])\s*[-*+](?!\s*\[)\s*/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizePlainRepeatableTextDraft(content: string): string {
  const fragments = parsePlainBulletFragments(content);
  if (fragments.length > 0) {
    return fragments.map((item) => `- ${item}`).join("\n");
  }

  return content.trim();
}

function hasOnlyRepeatablePlaceholderLines(lines: string[]): boolean {
  const meaningfulLines = lines.filter((line) => line.trim().length > 0);
  if (meaningfulLines.length === 0) {
    return false;
  }

  return meaningfulLines.every((line) => {
    const trimmed = line.trim();
    if (!/^\s*>?\s*[-*+]\s+/.test(line)) {
      return false;
    }

    const inlineFields = Array.from(trimmed.matchAll(/\[[^\]]+::\s*([^\]]*)\]/g));
    return inlineFields.length > 0 && inlineFields.every((match) => (match[1] ?? "").trim().length === 0);
  });
}

function isRepeatableInlinePlaceholderLine(line: string): boolean {
  const trimmed = line.trim();
  if (!/^\s*>?\s*[-*+]\s+/.test(line)) {
    return false;
  }

  const inlineFields = Array.from(trimmed.matchAll(/\[[^\]]+::\s*([^\]]*)\]/g));
  return inlineFields.length > 0 && inlineFields.every((match) => (match[1] ?? "").trim().length === 0);
}

function hasReplaceableRepeatablePlaceholderLine(lines: string[]): boolean {
  let hasPlaceholder = false;
  const hasRealRepeatableLine = lines.some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(">") || trimmed.startsWith("```") || isMarkdownThematicBreak(trimmed)) {
      return false;
    }

    if (isRepeatableInlinePlaceholderLine(line)) {
      hasPlaceholder = true;
      return false;
    }

    return /^\s*[-*+]\s+/.test(line) && /\[[^\]]+::\s*[^\]\s][^\]]*\]/u.test(line);
  });

  return hasPlaceholder && !hasRealRepeatableLine;
}

function replaceRepeatablePlaceholderLines(lines: string[], content: string): string {
  const contentLines = content.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  const nextLines: string[] = [];
  let inserted = false;

  lines.forEach((line) => {
    if (!isRepeatableInlinePlaceholderLine(line)) {
      nextLines.push(line);
      return;
    }

    if (inserted) {
      return;
    }

    nextLines.push(...contentLines);
    inserted = true;
  });

  return nextLines.join("\n").trim();
}

function mergeTaskMetadataTokens(
  baseTokens: ExtractedTaskMetadataToken[],
  incomingTokens: ExtractedTaskMetadataToken[]
): ExtractedTaskMetadataToken[] {
  const merged = [...baseTokens];
  incomingTokens.forEach((token) => appendUniqueMetadata(merged, token));
  return merged;
}

function matchTaskItems(left: NormalizedTaskItem, right: NormalizedTaskItem): boolean {
  if (!left.matchKey || !right.matchKey) {
    return false;
  }

  return (
    left.matchKey === right.matchKey ||
    left.matchKey.includes(right.matchKey) ||
    right.matchKey.includes(left.matchKey)
  );
}

function uniqueTaskItems(items: NormalizedTaskItem[]): NormalizedTaskItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.matchKey || item.content;
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isLikelyStructuredTaskFragment(item: NormalizedTaskItem): boolean {
  const content = item.content.trim();
  return /^[^\r\n：:]{2,40}[：:]/u.test(content);
}

function isCompletedOnlyTaskHintItem(item: NormalizedTaskItem): boolean {
  const labelsPattern = COMPLETED_ONLY_TASK_LINE_LABELS.map((label) => escapeRegExp(label)).join("|");
  return Boolean(labelsPattern) && new RegExp(`^(?:${labelsPattern})\\s*[：:]`, "i").test(item.content.trim());
}

function isStructuredTaskLeakItem(item: NormalizedTaskItem): boolean {
  return /^[^\r\n：:]{2,24}[：:]/u.test(item.content.trim());
}

function isFieldBackedTaskTemplateLines(lines: string[]): boolean {
  const taskLines = lines.filter((line) => /^\s*[-*+]\s+\[(?: |x|X)\]\s+/.test(line ?? ""));
  return taskLines.length > 0 && taskLines.every((line) => /\{\{\s*[^{}\r\n]+?\s*\}\}/.test(line));
}

function isPlaceholderTaskItem(item: NormalizedTaskItem): boolean {
  return /\{\{\s*[^{}\r\n]+?\s*\}\}/.test(item.content.trim());
}

function mergeTaskListIntoTemplateLines(
  lines: string[],
  draftContent: string,
  taskPrefix: string,
  templateContent = "",
  section?: TemplateSectionConfig,
  options: { allowPostfixedCompletedMarker?: boolean } = {}
): string[] {
  const templateTaskLines = lines
    .map((line, index) => {
      const item = parseMarkdownTaskLine(line, taskPrefix);
      return item ? { index, item } : null;
    })
    .filter((entry): entry is { index: number; item: NormalizedTaskItem } => entry !== null);
  const templateItems = section
    ? uniqueTaskItems([
      ...templateTaskLines.map((entry) => entry.item),
      ...extractTemplateTaskItems(section, templateContent, taskPrefix)
    ])
    : templateTaskLines.map((entry) => entry.item);
  const allowPostfixedCompletedMarker =
    options.allowPostfixedCompletedMarker ?? isFieldBackedTaskTemplateLines(lines);
  const draftItems = parseTaskListDraftItems(draftContent, taskPrefix, templateItems, {
    allowPostfixedCompletedMarker
  });
  const normalizedDraftText = normalizeLooseCompareValue(draftContent);

  if (draftItems.length === 0 && templateTaskLines.length === 0) {
    return [];
  }

  if (templateTaskLines.length === 0) {
    return draftItems.map((item) => item.line);
  }

  const remainingDraftItems = [...draftItems];
  let matchedCount = 0;
  templateTaskLines.forEach(({ index, item }) => {
    const matchedIndex = remainingDraftItems.findIndex((draftItem) => matchTaskItems(draftItem, item));
    if (matchedIndex < 0) {
      if (item.matchKey && normalizedDraftText.includes(item.matchKey)) {
        matchedCount += 1;
        lines[index] = formatTaskLine(
          item.content,
          true,
          item.tokens,
          taskPrefix
        );
        return;
      }

      lines[index] = item.line;
      return;
    }

    const matchedDraft = remainingDraftItems.splice(matchedIndex, 1)[0];
    if (!matchedDraft) {
      lines[index] = item.line;
      return;
    }

    matchedCount += 1;
    lines[index] = formatTaskLine(
      item.content,
      matchedDraft.checked,
      mergeTaskMetadataTokens(item.tokens, matchedDraft.tokens),
      taskPrefix
    );
  });

  if (matchedCount === 0) {
    if (allowPostfixedCompletedMarker && isFieldBackedTaskTemplateLines(lines)) {
      return draftItems
        .filter((item) => !isCompletedOnlyTaskHintItem(item) && !isStructuredTaskLeakItem(item))
        .map((item) => item.line);
    }

    return draftItems.map((item) => item.line);
  }

  const hasStructuredRemainder = remainingDraftItems.some((item) => isLikelyStructuredTaskFragment(item));
  const appendableRemainingItems = hasStructuredRemainder
    ? []
    : remainingDraftItems.filter((item) =>
      !isLikelyStructuredTaskFragment(item) &&
      !(allowPostfixedCompletedMarker && (isCompletedOnlyTaskHintItem(item) || isStructuredTaskLeakItem(item)))
    );
  if (appendableRemainingItems.length > 0) {
    const insertIndex = templateTaskLines[templateTaskLines.length - 1]!.index + 1;
    lines.splice(
      insertIndex,
      0,
      ...appendableRemainingItems.map((item) => item.line)
    );
  }

  return lines;
}

function buildStructuredLinePattern(prefix: string, label: string, separator: string): RegExp {
  const prefixPattern = buildPrefixPattern(prefix);
  const escapedLabel = escapeRegExp(label);
  const normalizedSeparator = separator.trim();

  if (!normalizedSeparator) {
    return new RegExp(`^(\\s*${prefixPattern}\\s*${escapedLabel})(?:\\s+(.*))?$`);
  }

  return new RegExp(
    `^(\\s*${prefixPattern}\\s*${escapedLabel}\\s*${escapeRegExp(normalizedSeparator)})\\s*(.*)$`
  );
}

function lineContainsStructuredLabel(line: string, prefix: string, label: string, separator: string): boolean {
  return buildStructuredLinePattern(prefix, label, separator).test(line);
}

function buildGroupHeadingPattern(prefix: string, label?: string): RegExp {
  if (/#/.test(prefix)) {
    const labelPattern = label ? `\\s+${escapeRegExp(label)}\\s*` : "\\s+.+";
    return new RegExp(`^\\s*>?\\s*#{2,6}${labelPattern}$`, "i");
  }

  const prefixPattern = buildPrefixPattern(prefix);
  if (label) {
    return new RegExp(`^\\s*${prefixPattern}\\s*${escapeRegExp(label)}\\s*$`, "i");
  }

  return new RegExp(`^\\s*${prefixPattern}\\s+.+$`, "i");
}

function buildGroupHeadingLabelsPattern(prefix: string, labels: string[]): RegExp {
  const labelPattern = uniqueLabels(labels).map((label) => escapeRegExp(label)).join("|");
  if (!labelPattern) {
    return buildGroupHeadingPattern(prefix);
  }

  if (/#/.test(prefix)) {
    return new RegExp(`^\\s*>?\\s*#{2,6}\\s+(?:${labelPattern})\\s*$`, "i");
  }

  const prefixPattern = buildPrefixPattern(prefix);
  return new RegExp(`^\\s*${prefixPattern}\\s*(?:${labelPattern})\\s*$`, "i");
}

function getGroupedTemplateBlockFieldIds(
  blockLines: string[],
  behavior: TemplateSectionGroupedFieldBlockBehaviorConfig,
  linePrefix: string,
  separator: string
): Set<string> {
  const fieldIds = new Set<string>();
  behavior.fields.forEach((field) => {
    if (blockLines.some((line) => lineContainsStructuredLabel(line ?? "", linePrefix, field.label, separator))) {
      fieldIds.add(field.id);
    }
  });
  return fieldIds;
}

function buildGroupedTemplateFieldIdsByGroup(
  rawContent: string,
  behavior: TemplateSectionGroupedFieldBlockBehaviorConfig
): Map<string, Set<string>> {
  const lines = rawContent.split(/\r?\n/);
  const headingPrefix = behavior.groupHeadingPrefix ?? "> ## ";
  const linePrefix = behavior.linePrefix ?? "> - ";
  const separator = behavior.separator ?? "：";
  const anyGroupHeadingPattern = buildGroupHeadingPattern(headingPrefix);
  const result = new Map<string, Set<string>>();

  behavior.groups.forEach((group) => {
    const headingPattern = buildGroupHeadingLabelsPattern(headingPrefix, buildGroupedBehaviorGroupLabels(group));
    const startIndex = lines.findIndex((line) => headingPattern.test(line ?? ""));
    if (startIndex < 0) {
      result.set(group.id, new Set<string>());
      return;
    }

    let endIndex = lines.length;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (anyGroupHeadingPattern.test(line)) {
        endIndex = index;
        break;
      }
    }

    result.set(
      group.id,
      getGroupedTemplateBlockFieldIds(lines.slice(startIndex + 1, endIndex), behavior, linePrefix, separator)
    );
  });

  return result;
}

function buildGroupedFieldIdsByOrderFallback(
  behavior: TemplateSectionGroupedFieldBlockBehaviorConfig
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const assigned = new Set<string>();
  behavior.groups.forEach((group, index) => {
    const nextGroup = behavior.groups[index + 1];
    const startIndex = behavior.fields.findIndex((field) =>
      field.label.trim() === group.label.trim() || field.id.trim() === group.id.trim()
    );
    const nextStartIndex = nextGroup
      ? behavior.fields.findIndex((field) =>
        field.label.trim() === nextGroup.label.trim() || field.id.trim() === nextGroup.id.trim()
      )
      : -1;
    const sliceStart = startIndex >= 0 ? startIndex + 1 : 0;
    const sliceEnd = nextStartIndex > sliceStart ? nextStartIndex : behavior.fields.length;
    const fieldIds = new Set<string>();
    behavior.fields.slice(sliceStart, sliceEnd).forEach((field) => {
      if (assigned.has(field.id)) {
        return;
      }
      fieldIds.add(field.id);
      assigned.add(field.id);
    });
    result.set(group.id, fieldIds);
  });
  return result;
}

function buildGroupedFieldIdsByTemplateOrOrder(
  rawContent: string,
  behavior: TemplateSectionGroupedFieldBlockBehaviorConfig
): Map<string, Set<string>> {
  const fromTemplate = buildGroupedTemplateFieldIdsByGroup(rawContent, behavior);
  if (
    [...fromTemplate.values()].some((fieldIds) => fieldIds.size > 0) &&
    behavior.groups.every((group) => (fromTemplate.get(group.id)?.size ?? 0) > 0)
  ) {
    return fromTemplate;
  }
  return new Map();
}

function filterGroupedFieldIdsForUngroupedFallback(
  templateFieldIdsByGroup: Map<string, Set<string>>,
  behavior: TemplateSectionGroupedFieldBlockBehaviorConfig,
  explicitGroupRecords: Set<string>,
  groupsWithSourceBlocks: Set<string>,
  hasDraftContent: (groupId: string) => boolean
): Map<string, Set<string>> {
  const fieldOwnerCounts = new Map<string, number>();
  templateFieldIdsByGroup.forEach((fieldIds) => {
    fieldIds.forEach((fieldId) => {
      fieldOwnerCounts.set(fieldId, (fieldOwnerCounts.get(fieldId) ?? 0) + 1);
    });
  });

  return new Map(
    behavior.groups.flatMap((group) => {
      if (explicitGroupRecords.has(group.id)) {
        return [];
      }

      const fieldIds = templateFieldIdsByGroup.get(group.id);
      if (!fieldIds || fieldIds.size === 0) {
        return [];
      }

      if (groupsWithSourceBlocks.has(group.id)) {
        return [[group.id, fieldIds] as const];
      }

      const canSafelyInferGroupFromFields =
        !hasDraftContent(group.id) &&
        [...fieldIds].every((fieldId) => (fieldOwnerCounts.get(fieldId) ?? 0) === 1);

      return canSafelyInferGroupFromFields ? [[group.id, fieldIds] as const] : [];
    })
  );
}

function normalizeSpeechLikeGroupedFieldLabelFlow(sourceText: string, labels: string[]): string {
  return uniqueLabels(labels)
    .sort((left, right) => right.length - left.length)
    .reduce((text, label) => {
      const pattern = new RegExp(
        `(^|[\\r\\n。.!！?？；;，,]\\s*)(${escapeRegExp(label)})\\s*([：:，,。；;])`,
        "gu"
      );
      return text.replace(pattern, (_match, prefix: string, currentLabel: string, delimiter: string) =>
        `${prefix}\n${currentLabel}${delimiter}`
      );
    }, sourceText);
}

function stitchSplitNumberedGroupHeadingLines(
  lines: string[],
  behavior: TemplateSectionGroupedFieldBlockBehaviorConfig
): string[] {
  const groupLabelSet = new Set(
    behavior.groups
      .flatMap((group) => buildGroupedBehaviorGroupLabels(group))
      .map((label) => label.trim())
      .filter(Boolean)
  );
  const stitched: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const nextLine = lines[index + 1] ?? "";
    const nextTrimmed = nextLine.trim();
    const normalizedNextTrimmed = nextTrimmed.replace(/[：:]\s*$/u, "");
    const trailingOrdinalMatch = trimmed.match(/^([\s\S]*?)(第?\s*[一二三四五六七八九十百千万\d]+[.)．、]?)\s*$/u);
    if (
      trailingOrdinalMatch &&
      (trailingOrdinalMatch[1] ?? "").trim().length > 0 &&
      normalizedNextTrimmed &&
      groupLabelSet.has(normalizedNextTrimmed)
    ) {
      stitched.push(line.slice(0, line.length - (trailingOrdinalMatch[2] ?? "").length).trimEnd());
      stitched.push(normalizedNextTrimmed);
      index += 1;
      continue;
    }

    if (/^(?:第?\s*[一二三四五六七八九十百千万\d]+[.)．、]?)\s*$/.test(trimmed) && nextTrimmed) {
      const candidate = `${trimmed} ${normalizedNextTrimmed}`.trim();
      if (groupLabelSet.has(candidate) || groupLabelSet.has(normalizedNextTrimmed)) {
        stitched.push(normalizedNextTrimmed);
        index += 1;
        continue;
      }
    }

    stitched.push(line);
  }

  return stitched;
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  if (!trimmed) {
    return [];
  }

  return trimmed.split("|").map((cell) => cell.trim());
}

function isMarkdownTableSeparatorRow(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function extractMarkdownTable(
  content: string,
  columns: TemplateSectionBehaviorFieldConfig[]
): Array<Record<string, string>> {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerLine = lines[index] ?? "";
    const separatorLine = lines[index + 1] ?? "";
    if (!headerLine.includes("|") || !separatorLine.includes("|") || !isMarkdownTableSeparatorRow(separatorLine)) {
      continue;
    }

    const headerCells = splitMarkdownTableRow(headerLine);
    const rowLines: string[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowLine = lines[rowIndex] ?? "";
      if (!rowLine.includes("|")) {
        break;
      }
      rowLines.push(rowLine);
    }

    const rows = rowLines.map((rowLine) => {
      const values = splitMarkdownTableRow(rowLine);
      return columns.reduce<Record<string, string>>((record, column) => {
        const headerIndex = headerCells.findIndex(
          (header) => header === column.label || (column.aliases ?? []).includes(header)
        );
        record[column.id] = headerIndex >= 0 ? values[headerIndex] ?? "" : "";
        return record;
      }, {});
    });

    if (rows.length > 0) {
      return rows;
    }
  }

  return [];
}

function isLeadingShortValueTableColumn(column: TemplateSectionBehaviorFieldConfig): boolean {
  const labels = buildFieldCandidateLabels(column).map((label) => label.trim().toLocaleLowerCase());
  return labels.some((label) =>
    /^(时段|时间段|阶段|区间|活动区间|时间|period|slot|phase|range|time)$/i.test(label)
  );
}

function matchPunctuationSeparatedLeadingTableValue(line: string): { firstValue: string; remainder: string } | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const punctuatedMatch = trimmed.match(/^([^\s。.!！?？]{1,12})[。.!！?？]\s*([\s\S]+)$/u);
  if (punctuatedMatch) {
    return {
      firstValue: punctuatedMatch[1] ?? "",
      remainder: punctuatedMatch[2] ?? ""
    };
  }

  return null;
}

function splitNaturalTableRemainderAcrossColumns(
  remainder: string,
  targetColumnCount: number
): string[] {
  const normalizedRemainder = normalizeInlineLabelValue(remainder).replace(/[。.!！?？]+$/u, "").trim();
  if (!normalizedRemainder) {
    return [];
  }

  const sentenceParts = normalizedRemainder
    .split(/(?:[。！？]+|[.!?]+(?=\s|$))/u)
    .map((part) => normalizeInlineLabelValue(part))
    .filter(Boolean);
  return sentenceParts.length > 1 && sentenceParts.length <= targetColumnCount
    ? sentenceParts
    : [normalizedRemainder];
}

function extractStructuredTableRows(
  content: string,
  columns: TemplateSectionBehaviorFieldConfig[],
  boundaryPolicy: TemplateSectionBoundaryPolicyConfig = {},
  sectionStopLabels: string[] = [],
  sectionStopRules: SectionStopRule[] = []
): Array<Record<string, string>> {
  const tableSectionStopLabels = sectionStopRules.flatMap((rule) => rule.labels);
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("|"))
    .flatMap((line) => splitCompactStructuredTableRowLine(line, columns));
  if (lines.length === 0) {
    return [];
  }

  const allColumnLabels = buildFieldLabelSet(columns);
  const normalizeExtractedCellValue = (
    value: string,
    currentColumn?: TemplateSectionBehaviorFieldConfig
  ): string => {
    const truncatedValue = currentColumn && tableSectionStopLabels.length > 0
      ? truncateSectionBlockAtStructuralStopLabel(
        value,
        tableSectionStopLabels,
        currentColumn.label || currentColumn.id,
        sectionStopRules,
        { allowTightStructuralStops: true }
      )
      : value;
    return /^[：:]+$/.test(truncatedValue.trim()) ? "" : truncatedValue;
  };
  const emptyRow = (): Record<string, string> =>
    columns.reduce<Record<string, string>>((record, column) => {
      record[column.id] = "";
      return record;
    }, {});
  const countMatchedColumns = (row: Record<string, string>): number =>
    columns.filter((column) => (row[column.id] ?? "").trim().length > 0).length;
  const lastMatchedColumnId = (row: Record<string, string>): string | null => {
    const column = [...columns].reverse().find((column) => (row[column.id] ?? "").trim().length > 0);
    return column?.id ?? null;
  };
  const normalizePendingRowValues = (row: Record<string, string>): Record<string, string> =>
    columns.reduce<Record<string, string>>((record, column) => {
      record[column.id] = normalizeInlineLabelValue(row[column.id] ?? "");
      return record;
    }, {});
  const joinPendingContinuationValue = (previousValue: string, nextLine: string): string => {
    const previous = previousValue.trim();
    const next = nextLine.trim();
    if (!previous) {
      return next;
    }
    if (!next) {
      return previous;
    }

    return /[\p{Script=Han}A-Za-z0-9）)]$/u.test(previous) && /^[\p{Script=Han}（(]/u.test(next)
      ? `${previous}${next}`
      : `${previous} ${next}`;
  };
  const mergeRowValues = (target: Record<string, string>, incoming: Record<string, string>): void => {
    columns.forEach((column) => {
      const value = (incoming[column.id] ?? "").trim();
      if (value) {
        target[column.id] = value;
      }
    });
  };
  const rows: Array<Record<string, string>> = [];
  let pendingRow: Record<string, string> | null = null;
  let pendingContinuationColumnId: string | null = null;
  const flushPendingRow = () => {
    if (pendingRow && countMatchedColumns(pendingRow) >= 2) {
      rows.push(normalizePendingRowValues(pendingRow));
    }
    pendingRow = null;
    pendingContinuationColumnId = null;
  };
  const parseDelimitedRow = (line: string): Record<string, string> | null => {
    if (columns.length < 2 || columns.length > 6) {
      return null;
    }

    const timeRangeMatch = line.match(/^\s*(\d{1,2}[:：]\d{2}\s*(?:-|~|–|—|至|到)\s*\d{1,2}[:：]\d{2})\s*[，,；;。.!！?？]\s*([\s\S]+)$/u);
    if (!timeRangeMatch) {
      return null;
    }

    const remainder = timeRangeMatch[2] ?? "";
    const [firstColumn, ...restColumns] = columns;
    const structuredRemainderRow = restColumns.length > 0
      ? extractOrderedStructuredTableRow(remainder, restColumns, restColumns[0]!, tableSectionStopLabels, sectionStopRules)
      : null;
    if (structuredRemainderRow && countMatchedColumns(structuredRemainderRow) >= 2) {
      const row = emptyRow();
      row[firstColumn?.id ?? ""] = normalizeInlineLabelValue(timeRangeMatch[1] ?? "");
      restColumns.forEach((column) => {
        row[column.id] = structuredRemainderRow[column.id] ?? "";
      });
      return countMatchedColumns(row) >= 2 ? row : null;
    }

    const sentenceParts = remainder
      .split(/[。.!！?？]+/u)
      .map((part) => part.trim())
      .filter(Boolean);
    const fallbackParts = sentenceParts.length > 1 && sentenceParts.length <= restColumns.length
      ? sentenceParts
      : [remainder.trim()].filter(Boolean);
    if (fallbackParts.length === 0) {
      return null;
    }

    const row = emptyRow();
    row[firstColumn?.id ?? ""] = normalizeInlineLabelValue(timeRangeMatch[1] ?? "");
    restColumns.forEach((column, index) => {
      row[column.id] = normalizeInlineLabelValue(fallbackParts[index] ?? "");
    });

    return countMatchedColumns(row) >= 2 ? row : null;
  };
  const parsePunctuationSeparatedLeadingValueRow = (line: string): Record<string, string> | null => {
    if (columns.length < 2 || columns.length > 4) {
      return null;
    }

    const firstColumn = columns[0];
    const secondColumn = columns[1];
    if (!firstColumn || !secondColumn || !isLeadingShortValueTableColumn(firstColumn)) {
      return null;
    }

    if (hasStructuralLabelStart(line, allColumnLabels, { allowQuotePrefix: true, allowTightLabel: true })) {
      return null;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^#{1,6}\s+/.test(line) || /[|[\]：:]/.test(line)) {
      return null;
    }

    const match = matchPunctuationSeparatedLeadingTableValue(line);
    if (!match) {
      return null;
    }

    const firstValue = normalizeInlineLabelValue(match.firstValue);
    const remainderParts = splitNaturalTableRemainderAcrossColumns(match.remainder, columns.length - 1);
    if (!firstValue || remainderParts.length === 0) {
      return null;
    }

    const row = emptyRow();
    row[firstColumn.id] = firstValue;
    columns.slice(1).forEach((column, index) => {
      row[column.id] = remainderParts[index] ?? "";
    });
    return countMatchedColumns(row) >= 2 ? row : null;
  };
  const parsePunctuationOnlyFirstColumnRow = (line: string): Record<string, string> | null => {
    const firstColumn = columns[0];
    if (!firstColumn || !isLeadingShortValueTableColumn(firstColumn)) {
      return null;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^#{1,6}\s+/.test(line) || /[|[\]：:]/.test(line)) {
      return null;
    }

    const match = line.trim().match(/^([^\s。.!！?？]{1,12})[。.!！?？]\s*$/u);
    if (!match) {
      return null;
    }

    const firstValue = normalizeInlineLabelValue(match[1] ?? "");
    if (!firstValue) {
      return null;
    }

    const row = emptyRow();
    row[firstColumn.id] = firstValue;
    return row;
  };
  const fillPendingPunctuationSeparatedCells = (line: string): boolean => {
    if (!pendingRow || !columns[0] || !isLeadingShortValueTableColumn(columns[0])) {
      return false;
    }

    const firstColumnValue = (pendingRow[columns[0].id] ?? "").trim();
    if (!firstColumnValue || countMatchedColumns(pendingRow) !== 1) {
      return false;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^#{1,6}\s+/.test(line) || /[|[\]：:]/.test(line)) {
      return false;
    }

    const parts = splitNaturalTableRemainderAcrossColumns(line, columns.length - 1);
    if (parts.length === 0) {
      return false;
    }

    columns.slice(1).forEach((column, index) => {
      const rawPart = parts[index] ?? "";
      pendingRow![column.id] = rawPart ? rawPart.replace(/[。.!！?？]+$/u, "").trim() : "";
    });
    return countMatchedColumns(pendingRow) >= 2;
  };

  let stoppedAtSectionBoundary = false;
  lines.forEach((line, index) => {
    if (stoppedAtSectionBoundary) {
      return;
    }

    if (isSectionStopBoundaryLine(line, tableSectionStopLabels, sectionStopRules)) {
      flushPendingRow();
      stoppedAtSectionBoundary = true;
      return;
    }

    const delimitedRow = parseDelimitedRow(line);
    if (delimitedRow) {
      flushPendingRow();
      rows.push(delimitedRow);
      return;
    }

    const punctuationSeparatedLeadingValueRow = parsePunctuationSeparatedLeadingValueRow(line);
    if (punctuationSeparatedLeadingValueRow) {
      flushPendingRow();
      rows.push(punctuationSeparatedLeadingValueRow);
      return;
    }

    if (fillPendingPunctuationSeparatedCells(line)) {
      flushPendingRow();
      return;
    }

    const startedColumn = columns.find((column) =>
      hasStructuralLabelStart(line, buildFieldCandidateLabels(column), {
        allowQuotePrefix: true,
        allowTightLabel: true
      })
    );
    if (!startedColumn) {
      const punctuationOnlyFirstColumnRow = parsePunctuationOnlyFirstColumnRow(line);
      if (punctuationOnlyFirstColumnRow) {
        flushPendingRow();
        pendingRow = punctuationOnlyFirstColumnRow;
        pendingContinuationColumnId = columns[0]?.id ?? null;
        return;
      }

      if (
        pendingRow &&
        pendingContinuationColumnId &&
        (
          countMatchedColumns(pendingRow) < 2 ||
          pendingContinuationColumnId === columns[0]?.id
        )
      ) {
        const previousValue = pendingRow[pendingContinuationColumnId]?.trim() ?? "";
        pendingRow[pendingContinuationColumnId] = joinPendingContinuationValue(previousValue, line);
        return;
      }

      flushPendingRow();
      return;
    }

    const orderedRow = extractOrderedStructuredTableRow(line, columns, startedColumn, tableSectionStopLabels, sectionStopRules);
    if (orderedRow && countMatchedColumns(orderedRow) >= 2) {
      const startedColumnIndex = columns.findIndex((column) => column.id === startedColumn.id);
      if (pendingRow && startedColumnIndex > 0) {
        mergeRowValues(pendingRow, orderedRow);
        pendingContinuationColumnId = lastMatchedColumnId(orderedRow);
        return;
      }

      if (startedColumnIndex === 0 && countMatchedColumns(orderedRow) < columns.length) {
        flushPendingRow();
        pendingRow = orderedRow;
        pendingContinuationColumnId = lastMatchedColumnId(orderedRow);
        return;
      }

      flushPendingRow();
      rows.push(orderedRow);
      pendingContinuationColumnId = null;
      return;
    }

    const row = columns.reduce<Record<string, string>>((record, column) => {
      const labels = buildFieldCandidateLabels(column);
      const stopLabels = allColumnLabels.filter((label) => !labels.includes(label));
      record[column.id] = normalizeExtractedCellValue(
        collectBlockForLabels(line, labels, stopLabels, stopLabels, [], boundaryPolicy),
        column
      );
      return record;
    }, emptyRow());

    const matchedColumnCount = countMatchedColumns(row);
    if (isTightColumnLabelWithoutLaterColumnEvidence(line, startedColumn, columns)) {
      const matchedColumnIndex = columns.findIndex((column) => (row[column.id] ?? "").trim().length > 0);
      const matchedColumn = columns[matchedColumnIndex];
      if (
        pendingRow &&
        matchedColumn &&
        matchedColumnIndex > 0 &&
        !(pendingRow[matchedColumn.id] ?? "").trim() &&
        countMatchedColumns(row) === 1
      ) {
        pendingRow[matchedColumn.id] = row[matchedColumn.id] ?? "";
        pendingContinuationColumnId = matchedColumn.id;
        return;
      }

      flushPendingRow();
      return;
    }

    if (matchedColumnCount >= 2) {
      flushPendingRow();
      rows.push(row);
      pendingContinuationColumnId = null;
      return;
    }

    if (matchedColumnCount === 0) {
      if (startedColumn === columns[0]) {
        if (pendingRow && countMatchedColumns(pendingRow) > 0) {
          flushPendingRow();
        }
        pendingRow = pendingRow ?? emptyRow();
        pendingContinuationColumnId = startedColumn.id;
      }
      return;
    }

    const matchedColumnIndex = columns.findIndex((column) => (row[column.id] ?? "").trim().length > 0);
    if (matchedColumnIndex > 0 && !pendingRow) {
      const previousRow = rows[rows.length - 1];
      const matchedColumn = columns[matchedColumnIndex];
      if (
        previousRow &&
        matchedColumn &&
        (previousRow[columns[0]?.id ?? ""] ?? "").trim() &&
        !(previousRow[matchedColumn.id] ?? "").trim() &&
        countMatchedColumns(previousRow) < columns.length
      ) {
        mergeRowValues(previousRow, row);
        return;
      }
    }

    if (matchedColumnIndex > 0 && (!pendingRow || !(pendingRow[columns[0]?.id ?? ""] ?? "").trim())) {
      const previousLine = lines[index - 1] ?? "";
      const firstColumn = columns[0];
      if (
        isCompleteStructuredTableBoundaryLine(
          previousLine,
          columns,
          firstColumn,
          tableSectionStopLabels,
          sectionStopRules
        )
      ) {
        return;
      }

      const previousFirstValue = firstColumn
        && hasStructuralLabelStart(previousLine, buildFieldCandidateLabels(firstColumn), {
          allowQuotePrefix: true,
          allowTightLabel: true
        })
        ? collectBlockForLabels(
          previousLine,
          buildFieldCandidateLabels(firstColumn),
          allColumnLabels.filter((label) => !buildFieldCandidateLabels(firstColumn).includes(label)),
          allColumnLabels.filter((label) => !buildFieldCandidateLabels(firstColumn).includes(label)),
          [],
          boundaryPolicy
        )
        : "";
      if (firstColumn && previousFirstValue) {
        pendingRow = pendingRow ?? emptyRow();
        pendingRow[firstColumn.id] = previousFirstValue;
      }
    }

    if (matchedColumnIndex > 0 && !pendingRow) {
      return;
    }

    if (matchedColumnIndex === 0 && pendingRow && countMatchedColumns(pendingRow) > 0) {
      flushPendingRow();
    }

    pendingRow = pendingRow ?? emptyRow();
    columns.forEach((column) => {
      const value = (row[column.id] ?? "").trim();
      if (value) {
        pendingRow![column.id] = value;
      }
    });
    pendingContinuationColumnId = columns[matchedColumnIndex]?.id ?? null;
  });

  flushPendingRow();
  return mergeAdjacentTableContinuationRows(
    fillMissingLeadingTableCellsFromSource(content, rows, columns),
    columns
  );
}

function mergeAdjacentTableContinuationRows(
  rows: Array<Record<string, string>>,
  columns: TemplateSectionBehaviorFieldConfig[]
): Array<Record<string, string>> {
  const firstColumn = columns[0];
  if (!firstColumn || columns.length < 2) {
    return rows;
  }

  return rows.reduce<Array<Record<string, string>>>((mergedRows, row) => {
    const previousRow = mergedRows[mergedRows.length - 1];
    if (!previousRow) {
      mergedRows.push(row);
      return mergedRows;
    }

    const currentFilledLaterColumns = columns
      .slice(1)
      .filter((column) => (row[column.id] ?? "").trim().length > 0);
    const targetColumnIndex = columns.findIndex((column) => column.id === currentFilledLaterColumns[0]?.id);
    const previousCanAcceptContinuation =
      (previousRow[firstColumn.id] ?? "").trim().length > 0 &&
      currentFilledLaterColumns.length === 1 &&
      targetColumnIndex > 1 &&
      !(previousRow[currentFilledLaterColumns[0]!.id] ?? "").trim() &&
      columns
        .slice(1, targetColumnIndex)
        .every((column) => (previousRow[column.id] ?? "").trim().length > 0);

    if (previousCanAcceptContinuation) {
      const targetColumn = currentFilledLaterColumns[0]!;
      previousRow[targetColumn.id] = row[targetColumn.id] ?? "";
      return mergedRows;
    }

    mergedRows.push(row);
    return mergedRows;
  }, []);
}

function extractOrderedStructuredTableRow(
  line: string,
  columns: TemplateSectionBehaviorFieldConfig[],
  startedColumn: TemplateSectionBehaviorFieldConfig,
  sectionStopLabels: string[] = [],
  sectionStopRules: SectionStopRule[] = []
): Record<string, string> | null {
  const startedColumnIndex = columns.findIndex((column) => column.id === startedColumn.id);
  if (startedColumnIndex < 0) {
    return null;
  }

  const firstMatch = findOrderedColumnLabelMatch(line, startedColumn);
  if (!firstMatch || firstMatch.start > 0) {
    return null;
  }

  const orderedMatches: Array<{
    column: TemplateSectionBehaviorFieldConfig;
    start: number;
    valueStart: number;
  }> = [];
  let cursor = 0;
  columns.slice(startedColumnIndex).forEach((column) => {
    const match = findOrderedColumnLabelMatch(line, column, cursor);
    if (!match) {
      return;
    }

    orderedMatches.push({
      column,
      start: match.start,
      valueStart: match.valueStart
    });
    cursor = match.valueStart;
  });

  if (orderedMatches.length < 2) {
    return null;
  }

  const row = columns.reduce<Record<string, string>>((record, column) => {
    record[column.id] = "";
    return record;
  }, {});

  orderedMatches.forEach((match, index) => {
    const nextMatch = orderedMatches[index + 1];
    const rawValue = line.slice(match.valueStart, nextMatch?.start ?? line.length);
    const normalizedValue = normalizeInlineLabelValue(
      stripInvalidOrderedTableLabelFragment(rawValue, columns, match.column, nextMatch?.column)
    );
    row[match.column.id] = sectionStopLabels.length > 0
      ? truncateSectionBlockAtStructuralStopLabel(
        normalizedValue,
        sectionStopLabels,
        match.column.label || match.column.id,
        sectionStopRules,
        { allowTightStructuralStops: true }
      )
      : normalizedValue;
  });

  return row;
}

function stripInvalidOrderedTableLabelFragment(
  value: string,
  columns: TemplateSectionBehaviorFieldConfig[],
  currentColumn: TemplateSectionBehaviorFieldConfig,
  nextMatchedColumn?: TemplateSectionBehaviorFieldConfig
): string {
  if (!nextMatchedColumn) {
    return value;
  }

  const currentLabels = new Set(buildFieldCandidateLabels(currentColumn));
  const nextLabels = new Set(buildFieldCandidateLabels(nextMatchedColumn));
  const skippedLabels = columns
    .flatMap((column) => buildFieldCandidateLabels(column))
    .filter((label) => !currentLabels.has(label) && !nextLabels.has(label))
    .filter((label) => label.trim().length >= 2)
    .sort((left, right) => right.length - left.length);
  let endIndex = value.length;

  skippedLabels.forEach((label) => {
    const pattern = new RegExp(`(?:^|[\\s，,。；;、])${escapeRegExp(label)}(?=\\S)`, "gu");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const matchedText = match[0] ?? "";
      const labelOffset = matchedText.lastIndexOf(label);
      const labelStart = match.index + Math.max(labelOffset, 0);
      if (labelStart > 0) {
        endIndex = Math.min(endIndex, labelStart);
      }
    }
  });

  return value.slice(0, endIndex);
}

function splitCompactStructuredTableRowLine(
  line: string,
  columns: TemplateSectionBehaviorFieldConfig[]
): string[] {
  const firstColumn = columns[0];
  if (!firstColumn || columns.length < 2) {
    return [line];
  }

  const matches = findOrderedColumnLabelMatches(line, firstColumn);
  if (matches.length < 2) {
    return [line];
  }

  const splitIndexes = matches
    .slice(1)
    .filter((match) => line.slice(match.start).trimStart().length > 0)
    .filter((match) =>
      columns
        .slice(1)
        .some((column) => findOrderedColumnLabelMatch(line, column, match.valueStart) !== null)
    )
    .map((match) => match.start);

  if (splitIndexes.length === 0) {
    return [line];
  }

  const fragments: string[] = [];
  let cursor = 0;
  splitIndexes.forEach((splitIndex) => {
    const fragment = line.slice(cursor, splitIndex).trim();
    if (fragment) {
      fragments.push(fragment);
    }
    cursor = splitIndex;
  });

  const tail = line.slice(cursor).trim();
  if (tail) {
    fragments.push(tail);
  }

  return fragments.length > 1 ? fragments : [line];
}

function findOrderedColumnLabelMatch(
  line: string,
  column: TemplateSectionBehaviorFieldConfig,
  fromIndex = 0
): { start: number; valueStart: number } | null {
  return findOrderedColumnLabelMatches(line, column, fromIndex)[0] ?? null;
}

function findOrderedColumnLabelMatches(
  line: string,
  column: TemplateSectionBehaviorFieldConfig,
  fromIndex = 0
): Array<{ start: number; valueStart: number }> {
  const labels = buildFieldCandidateLabels(column);
  const matches: Array<{ start: number; valueStart: number }> = [];

  labels.forEach((label) => {
    let searchIndex = Math.max(0, fromIndex);
    while (searchIndex < line.length) {
      const start = line.indexOf(label, searchIndex);
      if (start < 0) {
        break;
      }

      const valueStart = resolveOrderedColumnValueStart(line, start, label);
      if (valueStart !== null) {
        matches.push({ start, valueStart });
      }

      searchIndex = start + Math.max(1, label.length);
    }
  });

  return matches
    .sort((left, right) => left.start - right.start)
    .filter((match, index, allMatches) =>
      index === 0 || allMatches[index - 1]?.start !== match.start
    );
}

function resolveOrderedColumnValueStart(line: string, labelStart: number, label: string): number | null {
  const before = line.slice(0, labelStart);
  const previousChar = labelStart > 0 ? line.charAt(labelStart - 1) : "";
  if (
    labelStart > 0 &&
    !/[\s，,。；;、|｜/\\\-—–~·:：]/u.test(previousChar) &&
    !/\p{Script=Han}/u.test(previousChar)
  ) {
    return null;
  }

  if (/^\s*#{1,6}\s*$/.test(before)) {
    return null;
  }

  let valueStart = labelStart + label.length;
  const separatorMatch = line.slice(valueStart).match(/^(?:\s*[：:，,。.;；、|｜/\\\-—–~·]\s*|\s+)/u);
  if (!separatorMatch) {
    return null;
  }
  valueStart += separatorMatch?.[0]?.length ?? 0;
  return valueStart;
}

function isTightColumnLabelWithoutLaterColumnEvidence(
  line: string,
  column: TemplateSectionBehaviorFieldConfig,
  columns: TemplateSectionBehaviorFieldConfig[]
): boolean {
  const match = findOrderedColumnLabelMatch(line, column);
  if (!match || match.start !== 0) {
    return false;
  }

  const label = buildFieldCandidateLabels(column)
    .find((candidate) => line.startsWith(candidate.trim()));
  if (!label) {
    return false;
  }

  const nextChar = line.charAt(label.length);
  if (!/\p{Script=Han}/u.test(nextChar)) {
    return false;
  }

  return !columns
    .filter((candidate) => candidate.id !== column.id)
    .some((candidate) => findOrderedColumnLabelMatch(line, candidate, match.valueStart) !== null);
}

function fillMissingLeadingTableCellsFromSource(
  content: string,
  rows: Array<Record<string, string>>,
  columns: TemplateSectionBehaviorFieldConfig[]
): Array<Record<string, string>> {
  const firstColumn = columns[0];
  if (!firstColumn) {
    return rows;
  }

  const firstLabels = buildFieldCandidateLabels(firstColumn);
  const laterColumns = columns.slice(1);
  return rows.map((row) => {
    if ((row[firstColumn.id] ?? "").trim()) {
      return row;
    }

    const laterAnchor = laterColumns
      .map((column) => {
        const value = (row[column.id] ?? "").trim();
        if (!value) {
          return -1;
        }

        return buildFieldCandidateLabels(column).reduce((bestIndex, label) => {
          const index = content.indexOf(label);
          return index >= 0 ? Math.min(bestIndex, index) : bestIndex;
        }, Number.POSITIVE_INFINITY);
      })
      .filter((index) => Number.isFinite(index) && index >= 0)
      .sort((left, right) => left - right)[0];
    if (laterAnchor === undefined) {
      return row;
    }

    const prefix = content.slice(0, laterAnchor);
    const leadingValue = firstLabels
      .map((label) => {
        const index = prefix.lastIndexOf(label);
        if (index < 0) {
          return "";
        }

        const rawValue = prefix.slice(index + label.length).trim().split(/\r?\n/).pop()?.trim() ?? "";
        return truncateTableCellAtNextKnownLabel(rawValue, allColumnLabelsFor(columns, firstColumn), label);
      })
      .find((value) => value.trim().length > 0);
    if (!leadingValue) {
      return row;
    }

    return {
      ...row,
      [firstColumn.id]: leadingValue
    };
  });
}

function allColumnLabelsFor(
  columns: TemplateSectionBehaviorFieldConfig[],
  currentColumn: TemplateSectionBehaviorFieldConfig
): string[] {
  const currentLabels = buildFieldCandidateLabels(currentColumn);
  return buildFieldLabelSet(columns).filter((label) => !currentLabels.includes(label));
}

function normalizeSectionSourceInput(source: TemplateSectionSourceInput): TemplateSectionExtractionContext {
  if (typeof source === "string") {
    return {
      rawSourceText: source,
      normalizedSourceText: source
    };
  }

  return {
    rawSourceText: source.rawSourceText,
    normalizedSourceText: source.normalizedSourceText,
    labelSets: source.labelSets,
    normalizationVersion: source.normalizationVersion
  };
}

function hasExplicitSectionFieldEvidence(
  sourceText: string,
  section: TemplateSectionConfig
): boolean {
  if (section.behavior?.kind === "table_block") {
    const matchedColumnCount = section.behavior.columns.filter((column) =>
      buildFieldCandidateLabels(column).some((label) => {
        const escaped = escapeRegExp(label.trim());
        return escaped.length > 0 &&
          new RegExp(`(^|[\\s,，;；。.!！?？\\n])${escaped}(?:\\s*[：:，,。.;；、]|\\s+)\\S`, "u").test(sourceText);
      })
    ).length;
    return matchedColumnCount >= 2;
  }

  if (section.behavior?.kind === "mixed_field_block") {
    const itemLabelGroups = section.behavior.items
      .filter((item) => item.kind !== "static_note")
      .map((item) => buildMixedItemContentLabels(item));
    const hasExplicitLabelValue = (label: string): boolean => {
      const escaped = escapeRegExp(label.trim());
      return escaped.length > 0 &&
        new RegExp(`(^|[\\s,，;；。.!！?？\\n])${escaped}(?:\\s*[：:，,。.;；、]|\\s+)\\S`, "u").test(sourceText);
    };
    const matchedItemCount = itemLabelGroups.filter((labels) =>
      labels.some((label) => hasExplicitLabelValue(label))
    ).length;
    const hasStrongItemEvidence = section.behavior.items.some((item) => {
      if (item.kind === "static_note") {
        return false;
      }

      if (item.kind === "inline_field_group") {
        return item.fields.some((field) =>
          uniqueLabels([field.fieldName, field.id, field.label, ...(field.aliases ?? [])]).some(hasExplicitLabelValue)
        );
      }

      return buildMixedItemLabels(item).some((label) => {
        const escaped = escapeRegExp(label.trim());
        return escaped.length > 0 &&
          new RegExp(`(^|[\\s,，;；。.!！?？\\n])${escaped}\\s*[：:]`, "u").test(sourceText);
      });
    });
    return hasStrongItemEvidence || matchedItemCount >= Math.min(2, itemLabelGroups.length);
  }

  const labels = uniqueLabels(collectSectionBehaviorLabels(section));
  if (labels.length === 0) {
    return false;
  }

  return labels.some((label) => {
    const escaped = escapeRegExp(label.trim());
    if (escaped.length === 0) {
      return false;
    }

    const explicitSeparator = new RegExp(`(^|[\\s,，;；。.!！?？\\n])${escaped}\\s*[:：]`, "u").test(sourceText);
    const spokenAssignment = section.behavior?.kind === "field_block" &&
      new RegExp(`(^|\\n)\\s*${escaped}\\s*(?:是|为)\\s*\\S`, "u").test(sourceText);
    const structuralFieldBlockLabel = section.behavior?.kind === "field_block" &&
      new RegExp(`(^|[\\s,，;；。.!！?？\\n])${escaped}(?:\\s+|[。．.])\\S`, "u").test(sourceText);
    return explicitSeparator || spokenAssignment || structuralFieldBlockLabel;
  });
}

function collectRuntimeOwnedSectionWarnings(
  descriptor: TemplateStructureDescriptor | undefined,
  sectionId: string
): string[] {
  const runtimeOwnedFields = descriptor?.fields.filter((field) =>
    field.runtimeOwnedBySectionId === sectionId || (
      field.runtimeOwnedBySectionId === undefined &&
      field.features.includes("runtime_owned") &&
      descriptor.sections.find((section) => section.id === sectionId)?.behaviorFieldNames.includes(field.fieldName)
    )
  ) ?? [];
  if (runtimeOwnedFields.length === 0) {
    return [];
  }

  return ["运行时字段会在生成时确认，预览保留模板占位。"];
}

function resolveSectionSourceDecision(
  section: TemplateSectionConfig,
  sectionBody: string,
  sourceText: string,
  policy: ExtractionFallbackPolicy
): SectionSourceDecision {
  if (sectionBody.trim()) {
    return {
      source: sectionBody,
      scope: "section_body",
      warnings: []
    };
  }

  if (policy === "whole-source-with-warning" && hasExplicitSectionFieldEvidence(sourceText, section)) {
    return {
      source: sourceText,
      scope: "whole_source",
      fallbackReason: "section_body_missing_with_explicit_field_labels",
      warnings: ["已按字段线索尝试填充，请快速确认。"]
    };
  }

  if (policy === "manual-review") {
    return {
      source: "",
      scope: "none",
      fallbackReason: "section_body_missing_manual_review",
      warnings: ["源随笔里没有明显对应内容，已留空。"]
    };
  }

  return {
    source: "",
    scope: "none",
    fallbackReason: "section_body_missing",
    warnings: []
  };
}

function collectFallbackWarnings(
  warnings: Map<string, string[]>,
  sectionId: string,
  sourceDecision: SectionSourceDecision
): void {
  if (sourceDecision.warnings.length === 0) {
    return;
  }

  warnings.set(sectionId, [
    ...(warnings.get(sectionId) ?? []),
    ...sourceDecision.warnings
  ]);
}

function resolveStructuredSectionSourceDecision(
  section: TemplateSectionConfig,
  sectionBody: string,
  sourceText: string
): SectionSourceDecision {
  const sectionOnly = resolveSectionSourceDecision(section, sectionBody, sourceText, "section-only");
  if (sectionOnly.source.trim()) {
    return sectionOnly;
  }

  const fieldLabelFallback = resolveSectionSourceDecision(section, sectionBody, sourceText, "whole-source-with-warning");
  if (fieldLabelFallback.source.trim()) {
    return fieldLabelFallback;
  }

  return resolveSectionSourceDecision(section, sectionBody, sourceText, "manual-review");
}

function extractTableFieldEvidenceSource(
  sourceText: string,
  section: TemplateSectionConfig
): string {
  const behavior = section.behavior?.kind === "table_block" ? section.behavior : null;
  const firstColumn = behavior?.columns[0];
  if (!behavior || !firstColumn) {
    return "";
  }

  const lines = sourceText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const firstMatch = findOrderedColumnLabelMatch(line, firstColumn);
    if (!firstMatch) {
      continue;
    }

    const remainingColumns = behavior.columns.slice(1);
    const evidenceWindow = [line.slice(firstMatch.valueStart), ...lines.slice(index + 1, index + 4)].join("\n");
    const hasLaterColumnEvidence = remainingColumns.some((column) =>
      findOrderedColumnLabelMatch(line, column, firstMatch.valueStart) !== null ||
      findOrderedColumnLabelMatch(evidenceWindow, column) !== null
    );
    if (!hasLaterColumnEvidence) {
      continue;
    }

    return [
      line.slice(firstMatch.start).trim(),
      ...lines.slice(index + 1)
    ].join("\n").trim();
  }

  return "";
}

function normalizeSectionLocalLabelFlow(
  sourceText: string,
  labels: string[],
  stopLabels: string[],
  externalStopLabels: string[]
): string {
  return normalizeCompactSourceLabelFlow(
    sourceText,
    uniqueLabels(labels),
    uniqueLabels(stopLabels),
    uniqueLabels(externalStopLabels)
  );
}

function isCompleteStructuredTableBoundaryLine(
  line: string,
  columns: TemplateSectionBehaviorFieldConfig[],
  firstColumn: TemplateSectionBehaviorFieldConfig | undefined,
  tableSectionStopLabels: string[],
  sectionStopRules: SectionStopRule[]
): boolean {
  if (!firstColumn) {
    return false;
  }

  const previousCompleteRow = extractOrderedStructuredTableRow(
    line,
    columns,
    firstColumn,
    tableSectionStopLabels,
    sectionStopRules
  );
  const matchedColumnCount = previousCompleteRow
    ? Object.values(previousCompleteRow).filter((value) => value.trim().length > 0).length
    : 0;
  return matchedColumnCount >= 2;
}

function isSectionStopBoundaryLine(
  line: string,
  sectionStopLabels: string[],
  sectionStopRules: SectionStopRule[]
): boolean {
  if (sectionStopLabels.length === 0) {
    return false;
  }

  return decideSectionBoundaryLine(line, sectionStopLabels, sectionStopRules, {
    allowTightLabels: true,
    allowMarkdownHeadings: true
  }).matched;
}

function buildParserBoundaryContext(
  stopLabels: string[],
  stopRules: SectionStopRule[],
  boundaryPolicy: TemplateSectionBoundaryPolicyConfig
) {
  return {
    shouldStopAtLine: (line: string) => isSectionStopBoundaryLine(line, stopLabels, stopRules),
    truncateAtBoundary: (value: string, currentLabel: string) =>
      truncateSectionBlockAtStructuralStopLabel(value, stopLabels, currentLabel, stopRules, {
        allowTightStructuralStops: boundaryPolicy.allowTightLabels !== false
      })
  };
}

export class TemplateSectionDraftService {
  extract(
    source: TemplateSectionSourceInput,
    sections: TemplateSectionConfig[],
    options?: TemplateSectionExtractOptions
  ): TemplateSectionDraftExtraction {
    const extractionContext = normalizeSectionSourceInput(source);
    const sourceText = extractionContext.normalizedSourceText;
    const effectiveSections = this.applyTemplateFieldAliases(sections, options?.templateFields);
    const repeatableDrafts = new Map<string, string>();
    const repeatableWarnings = new Map<string, string[]>();
    const fieldBlockDrafts = new Map<string, Record<string, string>>();
    const groupedFieldBlockDrafts = new Map<string, Record<string, Record<string, string>>>();
    const tableBlockDrafts = new Map<string, Array<Record<string, string>>>();
    const mixedFieldBlockDrafts = new Map<string, Record<string, string>>();
    const sectionDraftTraces = new Map<string, TemplateSectionDraftTrace>();
    const descriptorMap = buildSectionDescriptorMap(options?.structureDescriptor);
    const allSectionLabels = extractionContext.labelSets?.sectionLabels?.length
      ? extractionContext.labelSets.sectionLabels
      : this.buildAllSectionLabels(effectiveSections);
    const allFieldLabels = extractionContext.labelSets?.fieldLabels?.length
      ? extractionContext.labelSets.fieldLabels
      : buildAllFieldLabels(effectiveSections, options?.templateFields);
    const allExtractionLabels = uniqueLabels([
      ...allFieldLabels,
      ...effectiveSections.flatMap(collectSectionBehaviorLabels)
    ]);

    effectiveSections
      .filter((section) => resolveSectionDescriptor(section, descriptorMap).mode === "generate")
      .forEach((section) => {
        const sectionDescriptor = resolveSectionDescriptor(section, descriptorMap);
        const sectionLabels = this.getSectionLabels(section);
        const sectionStopRules = buildSectionStopRules(effectiveSections, sectionLabels);
        const localContinuationLabels = uniqueLabels([
          ...buildSectionContinuationLabels(section, sectionDescriptor),
          ...collectSectionMixedItemLabels(section)
        ]);
        const sectionBody = collectBlockForLabels(
          sourceText,
          sectionLabels,
          buildSectionBodyStopLabels(section, sectionLabels, allSectionLabels, allFieldLabels),
          [...allSectionLabels, ...allFieldLabels],
          localContinuationLabels,
          createSectionBodyBoundaryPolicy(section),
          sectionStopRules
        );
        const sectionOnlySource = resolveSectionSourceDecision(section, sectionBody, sourceText, "section-only");
        const structuredSource = resolveStructuredSectionSourceDecision(section, sectionBody, sourceText);
        const runtimeOwnedWarnings = collectRuntimeOwnedSectionWarnings(options?.structureDescriptor, section.id);
        if (runtimeOwnedWarnings.length > 0) {
          repeatableWarnings.set(section.id, [
            ...(repeatableWarnings.get(section.id) ?? []),
            ...runtimeOwnedWarnings
          ]);
        }

        if (sectionDescriptor.kind === "repeatable_entries" && sectionBody) {
          const behavior = section.behavior?.kind === "repeatable_text" ? section.behavior : undefined;
          const parser = resolveTemplateSectionParser(resolveRepeatableSectionParserId(section, sectionDescriptor, behavior));
          const repeatableFieldNames = buildRepeatableParserFieldNames(section, sectionDescriptor);
          const stopLabels = buildSectionBodyStopLabels(section, sectionLabels, allSectionLabels, allFieldLabels);
          const entryLabel = buildRepeatableParserEntryLabel(behavior, section);
          const entrySchemas = buildRepeatableParserEntrySchemas(behavior, section);
          sectionDraftTraces.set(
            section.id,
            buildSectionDraftTrace(section, sectionDescriptor, "repeatable_entries", sectionOnlySource)
          );
          if (parser) {
            const boundaryPolicy = createBoundaryPolicy(behavior, parser.boundaryPolicy);
            const parsed = parser.parse(sectionBody, {
              fieldNames: repeatableFieldNames,
              entryLabel,
              entrySchemas,
              fieldAliases: buildRepeatableParserFieldAliases(repeatableFieldNames, options?.templateFields),
              boundaryPolicy,
              sectionLabels,
              stopLabels,
              ...buildParserBoundaryContext(stopLabels, sectionStopRules, boundaryPolicy)
            });
            repeatableDrafts.set(
              section.id,
              repairRepeatableInlineFieldDraft(parsed.content, repeatableFieldNames, {
                entryLabel,
                entrySchemas
              }) ?? parsed.content
            );
            if (parsed.warnings.length > 0) {
              repeatableWarnings.set(section.id, parsed.warnings);
            }
          } else {
            const implicitParsed = parseImplicitRepeatableInlineFieldDraft(sectionBody, section, repeatableFieldNames, {
              behavior,
              sectionLabels,
              stopLabels,
              templateFields: options?.templateFields
            });
            if (implicitParsed) {
              repeatableDrafts.set(
                section.id,
                repairRepeatableInlineFieldDraft(implicitParsed.content, repeatableFieldNames, {
                  entryLabel,
                  entrySchemas
                }) ?? implicitParsed.content
              );
              if (implicitParsed.warnings.length > 0) {
                repeatableWarnings.set(section.id, implicitParsed.warnings);
              }
              return;
            }

            repeatableDrafts.set(
              section.id,
              repairRepeatableInlineFieldDraft(sectionBody, repeatableFieldNames, {
                entryLabel,
                entrySchemas
              }) ?? sectionBody
            );
          }
          return;
        }

        if (section.behavior?.kind === "repeatable_text") {
          const behavior = section.behavior;
          const parserId = resolveRepeatableSectionParserId(section, sectionDescriptor, behavior);
          const parser = resolveTemplateSectionParser(parserId);
          const repeatableFieldNames = buildRepeatableParserFieldNames(section, sectionDescriptor);
          const stopLabels = buildSectionBodyStopLabels(section, sectionLabels, allSectionLabels, allFieldLabels);
          const entryLabel = buildRepeatableParserEntryLabel(behavior, section);
          const entrySchemas = buildRepeatableParserEntrySchemas(behavior, section);
          const spokenSource = !structuredSource.source.trim()
            ? resolveSpokenRepeatableWholeSourceDecision(
                section,
                sectionBody,
                sourceText,
                behavior,
                parserId,
                repeatableFieldNames,
                options?.templateFields
              )
            : undefined;
          const sourceDecision = spokenSource ?? structuredSource;
          collectFallbackWarnings(repeatableWarnings, section.id, sourceDecision);
          if (!sourceDecision.source.trim()) {
            return;
          }
          const source = sourceDecision.source;
          const implicitParsed = !parser
            ? parseImplicitRepeatableInlineFieldDraft(source, section, repeatableFieldNames, {
                behavior,
                sectionLabels,
                stopLabels,
                templateFields: options?.templateFields
              })
            : undefined;
          const boundaryPolicy = parser
            ? createBoundaryPolicy(behavior, parser.boundaryPolicy)
            : createBoundaryPolicy(behavior);
          const parsed = parser
            ? parser.parse(source, {
                fieldNames: repeatableFieldNames,
                entryLabel,
                entrySchemas,
                fieldAliases: buildRepeatableParserFieldAliases(repeatableFieldNames, options?.templateFields),
                boundaryPolicy,
                sectionLabels,
                stopLabels,
                ...buildParserBoundaryContext(stopLabels, sectionStopRules, boundaryPolicy)
              })
            : implicitParsed ?? { content: normalizePlainRepeatableTextDraft(source), warnings: [] };
          if (parsed.content.trim()) {
            repeatableDrafts.set(section.id, parsed.content);
            if (parsed.warnings.length > 0) {
              repeatableWarnings.set(section.id, parsed.warnings);
            }
            sectionDraftTraces.set(
              section.id,
              buildSectionDraftTrace(section, sectionDescriptor, "repeatable_entries", sourceDecision)
            );
          }
          return;
        }

        if (this.isTaskListSection(section)) {
          const behavior = section.behavior as TemplateSectionTaskListBehaviorConfig;
          const compactTaskSectionSource = sectionBody
            ? ""
            : extractCompactTaskSectionFallbackBlock(sourceText, section, sectionLabels);
          const fieldBackedSource = sectionBody
            ? ""
            : this.extractSectionFieldFallbackBlock(
              sourceText,
              section,
              allSectionLabels,
              allExtractionLabels,
              options?.templateFields,
              sectionStopRules
            );
          const templateTaskItems = extractTemplateTaskItems(section, "", behavior.taskPrefix ?? "- [ ] ");
          const effectiveTemplateTaskItems = templateTaskItems.length > 0
            ? templateTaskItems
            : sectionBody
              ? extractTemplateTaskItemsFromText(sectionBody, behavior.taskPrefix ?? "- [ ] ")
              : [];
          const concreteTemplateTaskItems = effectiveTemplateTaskItems.filter((item) => !isPlaceholderTaskItem(item));
          const hasExternalCompletionHints =
            fieldBackedSource && !sectionBody && extractCompletedOnlyTaskHintTexts(sourceText).length > 0;
          const preparedFieldBackedSource = fieldBackedSource && !sectionBody
            ? appendTaskCompletionHintsToDraftContent(
              hasExternalCompletionHints
                ? stripPostfixedCompletedTaskMarker(fieldBackedSource, true).content
                : fieldBackedSource,
              sourceText,
              concreteTemplateTaskItems,
              behavior.taskPrefix ?? "- [ ] "
            )
            : fieldBackedSource;
          const sourceDecision = sectionBody
            ? sectionOnlySource
            : compactTaskSectionSource
              ? {
                  source: compactTaskSectionSource,
                  scope: "whole_source" as const,
                  fallbackReason: "section_body_missing_with_compact_task_title",
                  warnings: ["已按 checklist 标题后的内容尝试填充，请快速确认。"]
                }
            : preparedFieldBackedSource
              ? {
                  source: preparedFieldBackedSource,
                  scope: "whole_source" as const,
                  fallbackReason: "section_body_missing_with_task_field_fallback",
                  warnings: ["已按任务线索尝试填充，请快速确认。"]
                }
              : resolveSectionSourceDecision(section, sectionBody, sourceText, "manual-review");
          collectFallbackWarnings(repeatableWarnings, section.id, sourceDecision);
          if (!sourceDecision.source.trim()) {
            return;
          }
          const source = sourceDecision.source;
          const shouldUseTemplateTaskItems =
            effectiveTemplateTaskItems.length > 0 &&
            (source.includes("[") || sourceDecision.fallbackReason === "section_body_missing_with_compact_task_title");
          const allowPostfixedCompletedMarker =
            Boolean(fieldBackedSource && !sectionBody) ||
            isFieldBackedTaskTemplateLines(
              this.getTemplateSectionBodyLines(getRuntimeSectionRawContent(section), section.title)
            );
          const normalized = fieldBackedSource && !sectionBody
            ? normalizeFieldBackedTaskListDraft(source, behavior.taskPrefix ?? "- [ ] ")
            : normalizeTaskListDraft(
              source,
              behavior.taskPrefix ?? "- [ ] ",
              shouldUseTemplateTaskItems ? effectiveTemplateTaskItems : [],
              { allowPostfixedCompletedMarker }
            );
          const candidate = normalized || sectionBody.trim();
          if (candidate) {
            repeatableDrafts.set(section.id, candidate);
            sectionDraftTraces.set(section.id, buildSectionDraftTrace(section, sectionDescriptor, "task_list", sourceDecision));
          }
          return;
        }

        if (this.isFieldBlockSection(section)) {
          const sourceDecision = structuredSource;
          collectFallbackWarnings(repeatableWarnings, section.id, sourceDecision);
          if (!sourceDecision.source.trim()) {
            return;
          }
          fieldBlockDrafts.set(
            section.id,
            this.extractFieldBlock(
              sourceDecision.source,
              section,
              allSectionLabels,
              allExtractionLabels,
              uniqueLabels([
                ...buildSectionBodyStopLabels(section, sectionLabels, allSectionLabels, allFieldLabels),
                ...allExtractionLabels
              ]),
              sectionStopRules
            )
          );
          sectionDraftTraces.set(section.id, buildSectionDraftTrace(section, sectionDescriptor, "field_block", sourceDecision));
          return;
        }

        if (this.isGroupedFieldBlockSection(section)) {
          const sourceDecision = structuredSource;
          collectFallbackWarnings(repeatableWarnings, section.id, sourceDecision);
          if (!sourceDecision.source.trim()) {
            return;
          }
          groupedFieldBlockDrafts.set(
            section.id,
            this.extractGroupedFieldBlock(sourceDecision.source, section, allSectionLabels, allExtractionLabels, sectionStopRules)
          );
          sectionDraftTraces.set(section.id, buildSectionDraftTrace(section, sectionDescriptor, "grouped_field_block", sourceDecision));
          return;
        }

        if (this.isTableBlockSection(section)) {
          const tableEvidenceSource = structuredSource.scope === "section_body"
            ? ""
            : extractTableFieldEvidenceSource(sourceText, section);
          const sourceDecision = tableEvidenceSource
            ? {
                source: tableEvidenceSource,
                scope: "whole_source" as const,
                fallbackReason: "section_body_missing_with_explicit_field_labels",
                warnings: ["已按字段线索尝试填充，请快速确认。"]
              }
            : structuredSource;
          collectFallbackWarnings(repeatableWarnings, section.id, sourceDecision);
          if (!sourceDecision.source.trim()) {
            return;
          }
          tableBlockDrafts.set(
            section.id,
            this.extractTableBlock(
              sourceDecision.source,
              section,
              buildSectionBodyStopLabels(section, sectionLabels, allSectionLabels, allFieldLabels),
              sectionStopRules
            )
          );
          sectionDraftTraces.set(section.id, buildSectionDraftTrace(section, sectionDescriptor, "table_block", sourceDecision));
          return;
        }

        if (this.isMixedFieldBlockSection(section)) {
          const sourceDecision = structuredSource;
          collectFallbackWarnings(repeatableWarnings, section.id, sourceDecision);
          if (!sourceDecision.source.trim()) {
            return;
          }
          const primaryDraft = this.extractMixedFieldBlock(sourceDecision.source, section, allSectionLabels, allExtractionLabels, sectionStopRules);
          const fallbackDraft = {};
          mixedFieldBlockDrafts.set(section.id, mergeMissingDraftValues(primaryDraft, fallbackDraft));
          sectionDraftTraces.set(section.id, buildSectionDraftTrace(section, sectionDescriptor, "mixed_field_block", sourceDecision));
        }
      });

    return {
      repeatableDrafts,
      repeatableWarnings,
      fieldBlockDrafts,
      groupedFieldBlockDrafts,
      tableBlockDrafts,
      mixedFieldBlockDrafts,
      sectionDraftTraces
    };
  }

  isFieldBlockSection(section: TemplateSectionConfig): boolean {
    const descriptor = buildSectionStructureDescriptor(section);
    return descriptor.mode === "generate" && descriptor.behaviorKind === "field_block";
  }

  isTaskListSection(section: TemplateSectionConfig): boolean {
    const descriptor = buildSectionStructureDescriptor(section);
    return descriptor.mode === "generate" && descriptor.behaviorKind === "task_list";
  }

  isRepeatableTextSection(section: TemplateSectionConfig): boolean {
    const descriptor = buildSectionStructureDescriptor(section);
    return descriptor.mode === "generate" && descriptor.behaviorKind === "repeatable_text";
  }

  isGroupedFieldBlockSection(section: TemplateSectionConfig): boolean {
    const descriptor = buildSectionStructureDescriptor(section);
    return descriptor.mode === "generate" && descriptor.behaviorKind === "grouped_field_block";
  }

  isTableBlockSection(section: TemplateSectionConfig): boolean {
    const descriptor = buildSectionStructureDescriptor(section);
    return descriptor.mode === "generate" && descriptor.behaviorKind === "table_block";
  }

  isMixedFieldBlockSection(section: TemplateSectionConfig): boolean {
    const descriptor = buildSectionStructureDescriptor(section);
    return descriptor.mode === "generate" && descriptor.behaviorKind === "mixed_field_block";
  }

  getSectionLabels(section: TemplateSectionConfig): string[] {
    const entryLabel = section.behavior?.kind === "repeatable_text" ? section.behavior.entryLabel : undefined;
    return uniqueLabels([section.title, entryLabel ?? "", ...(section.behavior?.sourceAliases ?? [])]);
  }

  createFieldBlockDraft(
    section: TemplateSectionConfig,
    extracted?: Record<string, string>,
    existing?: Record<string, string>
  ): Record<string, string> {
    const behavior = section.behavior?.kind === "field_block" ? section.behavior : null;
    if (!behavior) {
      return {};
    }

    const nextDraft = behavior.fields.reduce<Record<string, string>>((draft, field) => {
      draft[field.id] = "";
      return draft;
    }, {});

    return {
      ...nextDraft,
      ...(extracted ? cloneFieldBlockDraft(extracted) : {}),
      ...(existing ? cloneFieldBlockDraft(existing) : {})
    };
  }

  createGroupedFieldBlockDraft(
    section: TemplateSectionConfig,
    extracted?: Record<string, Record<string, string>>,
    existing?: Record<string, Record<string, string>>
  ): Record<string, Record<string, string>> {
    const behavior = section.behavior?.kind === "grouped_field_block" ? section.behavior : null;
    if (!behavior) {
      return {};
    }

    const nextDraft = behavior.groups.reduce<Record<string, Record<string, string>>>((draft, group) => {
      draft[group.id] = behavior.fields.reduce<Record<string, string>>((entries, field) => {
        entries[field.id] = "";
        return entries;
      }, {});
      return draft;
    }, {});

    const extractedDraft = extracted ? cloneGroupedFieldBlockDraft(extracted) : {};
    const existingDraft = existing ? cloneGroupedFieldBlockDraft(existing) : {};

    Object.keys(nextDraft).forEach((groupId) => {
      nextDraft[groupId] = {
        ...nextDraft[groupId],
        ...(extractedDraft[groupId] ?? {}),
        ...(existingDraft[groupId] ?? {})
      };
    });

    return nextDraft;
  }

  createTableBlockDraft(
    section: TemplateSectionConfig,
    extracted?: Array<Record<string, string>>,
    existing?: Array<Record<string, string>>
  ): Array<Record<string, string>> {
    const behavior = section.behavior?.kind === "table_block" ? section.behavior : null;
    if (!behavior) {
      return [];
    }

    const normalizeRows = (rows: Array<Record<string, string>> | undefined): Array<Record<string, string>> =>
      (rows ?? []).map((row) =>
        behavior.columns.reduce<Record<string, string>>((nextRow, column) => {
          nextRow[column.id] = readTableCellValue(row, column);
          return nextRow;
        }, {})
      );

    const existingRows = normalizeRows(existing);
    const extractedRows = normalizeRows(extracted);
    const hasExistingContent = existingRows.some((row) =>
      behavior.columns.some((column) => {
        const value = (row[column.id] ?? "").trim();
        return value.length > 0 && !isTemplatePlaceholderValue(value);
      })
    );
    if (extractedRows.length > 0 && existingRows.length > 0 && extractedRows.length !== existingRows.length) {
      return extractedRows;
    }

    if (hasExistingContent) {
      return existingRows.map((existingRow, rowIndex) => {
        const extractedRow = extractedRows[rowIndex] ?? {};
        return behavior.columns.reduce<Record<string, string>>((nextRow, column) => {
          const existingValue = existingRow[column.id] ?? "";
          nextRow[column.id] = existingValue.trim().length > 0 && !isTemplatePlaceholderValue(existingValue)
            ? existingValue
            : extractedRow[column.id] ?? "";
          return nextRow;
        }, {});
      });
    }

    return extractedRows;
  }

  createMixedFieldBlockDraft(
    section: TemplateSectionConfig,
    extracted?: Record<string, string>,
    existing?: Record<string, string>,
    templateContent?: string
  ): Record<string, string> {
    const behavior = section.behavior?.kind === "mixed_field_block" ? section.behavior : null;
    if (!behavior) {
      return {};
    }

    const nextDraft = {
      ...(extracted ? cloneFieldBlockDraft(extracted) : {}),
      ...(existing ? cloneFieldBlockDraft(existing) : {})
    };

    if (!templateContent?.trim()) {
      return nextDraft;
    }

    const lines = this.getTemplateSectionBodyLines(templateContent, section.title);
    if (lines.length === 0) {
      return nextDraft;
    }

    return this.buildMixedFieldValueMapForWrite(lines, behavior, nextDraft);
  }

  hasFieldBlockContent(section: TemplateSectionConfig, draft: Record<string, string> | undefined): boolean {
    const behavior = section.behavior?.kind === "field_block" ? section.behavior : null;
    if (!behavior || !draft) {
      return false;
    }

    return behavior.fields.some((field) => (draft[field.id] ?? "").trim().length > 0);
  }

  hasGroupedFieldBlockContent(
    section: TemplateSectionConfig,
    draft: Record<string, Record<string, string>> | undefined
  ): boolean {
    const behavior = section.behavior?.kind === "grouped_field_block" ? section.behavior : null;
    if (!behavior || !draft) {
      return false;
    }

    return behavior.groups.some((group) =>
      behavior.fields.some((field) => (draft[group.id]?.[field.id] ?? "").trim().length > 0)
    );
  }

  hasTableBlockContent(section: TemplateSectionConfig, draft: Array<Record<string, string>> | undefined): boolean {
    const behavior = section.behavior?.kind === "table_block" ? section.behavior : null;
    if (!behavior || !draft) {
      return false;
    }

    return draft.some((row) => behavior.columns.some((column) => (row[column.id] ?? "").trim().length > 0));
  }

  hasMixedFieldBlockContent(section: TemplateSectionConfig, draft: Record<string, string> | undefined): boolean {
    const behavior = section.behavior?.kind === "mixed_field_block" ? section.behavior : null;
    if (!behavior || !draft) {
      return false;
    }

    return behavior.items.some((item) => {
      if (item.kind === "text_field" || item.kind === "checkbox_enum" || item.kind === "task_list") {
        return (draft[item.targetFieldName ?? item.label] ?? "").trim().length > 0;
      }
      return false;
    });
  }

  isFieldBackedTaskListSection(section: TemplateSectionConfig, templateContent: string): boolean {
    if (!this.isTaskListSection(section)) {
      return false;
    }

    return isFieldBackedTaskTemplateLines(this.getTemplateSectionBodyLines(templateContent, section.title));
  }

  buildSectionOverride(
    templateContent: string,
    section: TemplateSectionConfig,
    draft:
      | string
      | Record<string, string>
      | Record<string, Record<string, string>>
      | Array<Record<string, string>>
  ): { title: string; content: string; mode: "append" | "replace" } | null {
    if (typeof draft === "string") {
      const content = draft.trim();
      if (!content) {
        return null;
      }

      if (this.isTaskListSection(section)) {
        const behavior = section.behavior as TemplateSectionTaskListBehaviorConfig;
        const lines = this.getTemplateSectionBodyLines(templateContent, section.title);
        const allowPostfixedCompletedMarker = isFieldBackedTaskTemplateLines(lines);
        const mergedLines = mergeTaskListIntoTemplateLines(
          lines,
          content,
          behavior.taskPrefix ?? "- [ ] ",
          templateContent,
          section,
          { allowPostfixedCompletedMarker }
        );
        const nextContent = mergedLines.length > 0
          ? mergedLines.join("\n").trim()
          : normalizeTaskListDraft(content, behavior.taskPrefix ?? "- [ ] ", [], { allowPostfixedCompletedMarker });
        if (!nextContent) {
          return null;
        }

        return {
          title: section.title,
          content: nextContent,
          mode: behavior.overrideMode ?? "replace"
        };
      }

      const behavior = section.behavior?.kind === "repeatable_text" ? section.behavior : undefined;
      const bodyLines = this.getTemplateSectionBodyLines(templateContent, section.title);
      const hasGuidedRepeatablePlaceholder = hasReplaceableRepeatablePlaceholderLine(bodyLines);
      return {
        title: section.title,
        content: hasGuidedRepeatablePlaceholder
          ? replaceRepeatablePlaceholderLines(bodyLines, content)
          : content,
        mode: hasOnlyRepeatablePlaceholderLines(bodyLines) || hasGuidedRepeatablePlaceholder
          ? "replace"
          : behavior?.overrideMode ?? "append"
      };
    }

    if (this.isFieldBlockSection(section)) {
      const behavior = section.behavior as TemplateSectionFieldBlockBehaviorConfig;
      const content = this.buildFieldBlockSectionContent(templateContent, section, draft as Record<string, string>);
      if (!content.trim()) {
        return null;
      }

      return {
        title: section.title,
        content,
        mode: behavior.overrideMode ?? "replace"
      };
    }

    if (this.isGroupedFieldBlockSection(section)) {
      const behavior = section.behavior as TemplateSectionGroupedFieldBlockBehaviorConfig;
      const content = this.buildGroupedFieldBlockSectionContent(
        templateContent,
        section,
        draft as Record<string, Record<string, string>>
      );
      if (!content.trim()) {
        return null;
      }

      return {
        title: section.title,
        content,
        mode: behavior.overrideMode ?? "replace"
      };
    }

    if (this.isTableBlockSection(section)) {
      const behavior = section.behavior as TemplateSectionTableBlockBehaviorConfig;
      const content = this.buildTableBlockSectionContent(templateContent, section, draft as Array<Record<string, string>>);
      if (!content.trim()) {
        return null;
      }

      return {
        title: section.title,
        content,
        mode: behavior.overrideMode ?? "replace"
      };
    }

    if (this.isMixedFieldBlockSection(section)) {
      const behavior = section.behavior as TemplateSectionMixedFieldBlockBehaviorConfig;
      const content = this.buildMixedFieldBlockSectionContent(templateContent, section, draft as Record<string, string>);
      if (!content.trim()) {
        return null;
      }

      return {
        title: section.title,
        content,
        mode: behavior.overrideMode ?? "replace"
      };
    }

    return null;
  }

  buildFrontmatterOverrides(
    sections: TemplateSectionConfig[],
    groupedDrafts: Map<string, Record<string, Record<string, string>>>
  ): Record<string, number> {
    const overrides: Record<string, number> = {};

    sections
      .filter((section) => this.isGroupedFieldBlockSection(section))
      .forEach((section) => {
        const behavior = section.behavior as TemplateSectionGroupedFieldBlockBehaviorConfig;
        const draft = groupedDrafts.get(section.id);
        if (!draft) {
          return;
        }

        behavior.groups.forEach((group) => {
          if (!group.presenceFieldName) {
            return;
          }

          const completionFieldId = behavior.fallbackFieldId ?? behavior.fields[0]?.id;
          const completionValue = completionFieldId ? (draft[group.id]?.[completionFieldId] ?? "").trim() : "";
          if (/^(?:0|false|no|否|未|没有|未完成)$/iu.test(completionValue)) {
            overrides[group.presenceFieldName] = 0;
            return;
          }
          if (/^(?:1|true|yes|是|完成|已完成)$/iu.test(completionValue)) {
            overrides[group.presenceFieldName] = 1;
            return;
          }

          const hasContent = behavior.fields.some(
            (field) => (draft[group.id]?.[field.id] ?? "").trim().length > 0
          );
          if (hasContent) {
            overrides[group.presenceFieldName] = 1;
          }
        });
      });

    return overrides;
  }

  private buildAllSectionLabels(sections: TemplateSectionConfig[]): string[] {
    return uniqueLabels(sections.flatMap((section) => this.getSectionLabels(section)));
  }

  private extractSectionFieldFallbackBlock(
    sourceText: string,
    section: TemplateSectionConfig,
    allSectionLabels: string[],
    allExtractionLabels: string[],
    templateFields?: TemplateFieldContext | TemplateFieldConfig[],
    sectionStopRules: SectionStopRule[] = []
  ): string {
    const labels = buildSectionFieldCandidateLabels(section, templateFields);
    if (labels.length === 0) {
      return "";
    }

    return collectBlockForLabels(
      sourceText,
      labels,
      allExtractionLabels.filter((label) => !labels.includes(label)),
      [...allExtractionLabels, ...allSectionLabels],
      [],
      createFieldBlockBoundaryPolicy(section.behavior),
      sectionStopRules
    );
  }

  private extractFieldBlock(
    sourceText: string,
    section: TemplateSectionConfig,
    allSectionLabels: string[],
    allFieldLabels: string[],
    externalStopLabels: string[] = [],
    sectionStopRules: SectionStopRule[] = []
  ): Record<string, string> {
    const behavior = section.behavior as TemplateSectionFieldBlockBehaviorConfig;
    const fieldLabels = buildFieldLabelSet(behavior.fields);
    const fieldIdentityLabelSet = new Set(behavior.fields.flatMap(buildFieldIdentityLabels));
    const entries = behavior.fields.reduce<Record<string, string>>((nextEntries, field) => {
      const identityLabels = buildFieldIdentityLabels(field);
      const labels = uniqueLabels([
        ...identityLabels,
        ...(field.aliases ?? []).filter((alias) => identityLabels.includes(alias) || !fieldIdentityLabelSet.has(alias))
      ]);
      const stopLabels = fieldLabels.filter((label) => !identityLabels.includes(label));
      const otherFieldLabels = allFieldLabels.filter((label) => !identityLabels.includes(label));
      const effectiveStopLabels = [
        ...stopLabels,
        ...otherFieldLabels,
        ...allSectionLabels,
        ...allFieldLabels,
        ...externalStopLabels
      ];
      const boundaryPolicy = createFieldBlockBoundaryPolicy(behavior);
      const structuredValue = collectBlockForLabels(sourceText, labels, effectiveStopLabels, [
        ...stopLabels,
        ...otherFieldLabels,
        ...allSectionLabels,
        ...allFieldLabels,
        ...externalStopLabels
      ], [], boundaryPolicy, sectionStopRules);
      const spokenValue = structuredValue || collectSpokenFieldBlockValue(
        sourceText,
        labels,
        effectiveStopLabels,
        boundaryPolicy,
        sectionStopRules
      );
      nextEntries[field.id] = spokenValue
        ? trimFieldBlockValueAtStopLine(
            truncateSectionBlockAtStructuralStopLabel(spokenValue, effectiveStopLabels, field.label || field.id, sectionStopRules, {
              allowTightStructuralStops: true
            }),
            effectiveStopLabels,
            sectionStopRules,
            boundaryPolicy
          )
        : "";
      return nextEntries;
    }, {});

    const hasExplicitField = Object.values(entries).some((value) => value.trim().length > 0);
    if (!hasExplicitField && behavior.fallbackFieldId && sourceText.trim()) {
      entries[behavior.fallbackFieldId] = sourceText.trim();
    }

    return entries;
  }

  private extractGroupedFieldBlock(
    sourceText: string,
    section: TemplateSectionConfig,
    allSectionLabels: string[],
    allFieldLabels: string[],
    sectionStopRules: SectionStopRule[] = []
  ): Record<string, Record<string, string>> {
    const behavior = section.behavior as TemplateSectionGroupedFieldBlockBehaviorConfig;
    let draft = behavior.groups.reduce<Record<string, Record<string, string>>>((nextDraft, group) => {
      nextDraft[group.id] = behavior.fields.reduce<Record<string, string>>((record, field) => {
        record[field.id] = "";
        return record;
      }, {});
      return nextDraft;
    }, {});

    const explicitGroupRecords = this.extractExplicitGroupedFieldRecords(
      sourceText,
      behavior,
      allSectionLabels,
      allFieldLabels,
      sectionStopRules
    );
    explicitGroupRecords.forEach((record, groupId) => {
      draft[groupId] = this.mergeGroupedRecordPreferComplete(
        draft[groupId] ?? {},
        this.compactGroupedRecord(record)
      );
    });

    const groupLabels = uniqueLabels(
      behavior.groups.flatMap((group) => buildGroupedBehaviorGroupLabels(group))
    );
    const fieldLabels = buildFieldLabelSet(behavior.fields);
    const templateFieldIdsByGroup = buildGroupedFieldIdsByTemplateOrOrder(
      getRuntimeSectionRawContent(section),
      behavior
    );
    const groupsWithSourceBlocks = new Set<string>();
    behavior.groups.forEach((group) => {
      const currentRecord = draft[group.id] ?? {};
      const hasContent = this.hasGroupedRecordContent(behavior, currentRecord);
      const labels = buildGroupedBehaviorGroupLabels(group);
      const groupBlock = collectBlockForLabels(
        sourceText,
        labels,
        [...groupLabels.filter((label) => !labels.includes(label)), ...allSectionLabels],
        [...groupLabels.filter((label) => !labels.includes(label)), ...allSectionLabels],
        [],
        createFieldBlockBoundaryPolicy(behavior),
        sectionStopRules
      );
      if (!groupBlock.trim()) {
        return;
      }
      groupsWithSourceBlocks.add(group.id);

      const groupPrefixPattern = new RegExp(
        `(?:^|\\n)\\s*(?:${labels.map((label) => escapeRegExp(label)).join("|")})\\s+(?=${fieldLabels.map((label) => escapeRegExp(label)).join("|")})`,
        "gu"
      );
      const normalizedGroupBlock = groupBlock.replace(groupPrefixPattern, "\n");
      const entries = behavior.fields.reduce<Record<string, string>>((nextEntries, field) => {
        const currentLabels = buildFieldCandidateLabels(field);
        const stopLabels = fieldLabels.filter((label) => !currentLabels.includes(label));
        const otherFieldLabels = allFieldLabels.filter((label) => !currentLabels.includes(label));
        nextEntries[field.id] = collectBlockForLabels(normalizedGroupBlock, currentLabels, [
          ...stopLabels,
          ...otherFieldLabels
        ], [
          ...stopLabels,
          ...otherFieldLabels
        ], [], createFieldBlockBoundaryPolicy(behavior), sectionStopRules);
        return nextEntries;
      }, {});

      const normalizedEntries = this.normalizeGroupedRecord(entries);
      if (this.hasGroupedRecordContent(behavior, normalizedEntries)) {
        draft[group.id] = this.mergeGroupedRecordPreferComplete(currentRecord, normalizedEntries);
        return;
      }

      if (!hasContent && behavior.fallbackFieldId) {
        draft[group.id] = {
          ...currentRecord,
          [behavior.fallbackFieldId]: groupBlock.trim()
        };
      }
    });

    draft = this.mergeUngroupedGroupedFieldValuesByTemplateMembership(
      draft,
      sourceText,
      behavior,
      filterGroupedFieldIdsForUngroupedFallback(
        templateFieldIdsByGroup,
        behavior,
        new Set(explicitGroupRecords.keys()),
        groupsWithSourceBlocks,
        (groupId) => this.hasGroupedRecordContent(behavior, draft[groupId] ?? {})
      ),
      allSectionLabels,
      allFieldLabels,
      sectionStopRules
    );

    if (explicitGroupRecords.size === 0) {
      const sequentialRecords = this.extractSequentialGroupedFieldRecords(
        sourceText,
        behavior,
        allSectionLabels,
        allFieldLabels,
        sectionStopRules
      );
      const writableGroups = behavior.groups.filter((group) => group.label.trim() !== section.title.trim());
      sequentialRecords.forEach((record, index) => {
        const group = writableGroups[index] ?? behavior.groups[index];
        if (!group) {
          return;
        }

        if (this.hasGroupedRecordContent(behavior, draft[group.id] ?? {})) {
          return;
        }

        draft[group.id] = {
          ...(draft[group.id] ?? {}),
          ...record
        };
      });
    }

    return draft;
  }

  private mergeUngroupedGroupedFieldValuesByTemplateMembership(
    draft: Record<string, Record<string, string>>,
    sourceText: string,
    behavior: TemplateSectionGroupedFieldBlockBehaviorConfig,
    templateFieldIdsByGroup: Map<string, Set<string>>,
    allSectionLabels: string[],
    allFieldLabels: string[],
    sectionStopRules: SectionStopRule[] = []
  ): Record<string, Record<string, string>> {
    const fieldLabels = buildFieldLabelSet(behavior.fields);
    const normalizedSource = normalizeSectionLocalLabelFlow(
      normalizeSpeechLikeGroupedFieldLabelFlow(sourceText, fieldLabels),
      fieldLabels,
      fieldLabels,
      uniqueLabels(allSectionLabels)
    );
    const extracted = behavior.fields.reduce<Record<string, string>>((entries, field) => {
      const labels = buildFieldCandidateLabels(field);
      const stopLabels = uniqueLabels([
        ...fieldLabels.filter((label) => !labels.includes(label)),
        ...allFieldLabels.filter((label) => !labels.includes(label)),
        ...allSectionLabels
      ]);
      entries[field.id] = this.normalizeGroupedFieldValue(
        collectBlockForLabels(normalizedSource, labels, stopLabels, stopLabels, [], createFieldBlockBoundaryPolicy(behavior), sectionStopRules),
        stopLabels,
        sectionStopRules
      );
      return entries;
    }, {});

    const nextDraft = { ...draft };
    behavior.groups.forEach((group) => {
      const groupFieldIds = templateFieldIdsByGroup.get(group.id);
      if (!groupFieldIds || groupFieldIds.size === 0) {
        return;
      }

      const groupDraft = { ...(nextDraft[group.id] ?? {}) };
      groupFieldIds.forEach((fieldId) => {
        const value = extracted[fieldId]?.trim() ?? "";
        if (!value || (groupDraft[fieldId] ?? "").trim()) {
          return;
        }
        groupDraft[fieldId] = value;
      });
      nextDraft[group.id] = this.normalizeGroupedRecord(groupDraft);
    });

    return nextDraft;
  }

  private extractExplicitGroupedFieldRecords(
    sourceText: string,
    behavior: TemplateSectionGroupedFieldBlockBehaviorConfig,
    allSectionLabels: string[] = [],
    allFieldLabels: string[] = [],
    sectionStopRules: SectionStopRule[] = []
  ): Map<string, Record<string, string>> {
    const groupLabels = uniqueLabels(
      behavior.groups.flatMap((group) => buildGroupedBehaviorGroupLabels(group))
    );
    const fieldLabels = buildFieldLabelSet(behavior.fields);
    const externalStopLabels = uniqueLabels([
      ...allSectionLabels,
      ...allFieldLabels.filter((label) => !fieldLabels.includes(label) && !groupLabels.includes(label))
    ]);
    const normalizedSource = normalizeSectionLocalLabelFlow(
      sourceText,
      [...groupLabels, ...fieldLabels, ...externalStopLabels],
      [...groupLabels, ...fieldLabels, ...externalStopLabels],
      externalStopLabels
    );
    const groupBlocks = new Map<string, string[]>();
    let currentGroupId: string | null = null;

    stitchSplitNumberedGroupHeadingLines(normalizedSource.split(/\r?\n/), behavior).forEach((line) => {
      const groupMatch = this.matchGroupedFieldBlockHeading(line, behavior);
      if (groupMatch) {
        const { group, value } = groupMatch;
        currentGroupId = group.id;
        groupBlocks.set(group.id, value.trim() ? [value] : []);
        return;
      }

      if (
        currentGroupId &&
        decideSectionBoundaryLine(line, externalStopLabels, sectionStopRules, {
          allowTightLabels: false,
          allowMarkdownHeadings: true
        }).matched
      ) {
        currentGroupId = null;
      }

      if (!currentGroupId) {
        return;
      }

      groupBlocks.set(currentGroupId, [...(groupBlocks.get(currentGroupId) ?? []), line]);
    });

    const records = new Map<string, Record<string, string>>();
    groupBlocks.forEach((blockLines, groupId) => {
      const entries = this.extractGroupedFieldRecordFromLines(blockLines, behavior, fieldLabels, externalStopLabels, sectionStopRules);

      if (this.hasGroupedRecordContent(behavior, entries)) {
        records.set(groupId, entries);
      }
    });
    return records;
  }

  private extractGroupedFieldRecordFromLines(
    lines: string[],
    behavior: TemplateSectionGroupedFieldBlockBehaviorConfig,
    fieldLabels: string[],
    externalStopLabels: string[],
    sectionStopRules: SectionStopRule[] = []
  ): Record<string, string> {
    const stitchedLines = this.stitchGroupedFieldContinuationLines(lines, behavior);
    return behavior.fields.reduce<Record<string, string>>((nextEntries, field) => {
      const currentLabels = buildFieldCandidateLabels(field);
      const stopLabels = [
        ...fieldLabels.filter((label) => !currentLabels.includes(label)),
        ...externalStopLabels
      ];
      const directFieldLine = stitchedLines
        .map((line) => this.extractSingleGroupedFieldLineValue(line, currentLabels, stopLabels, sectionStopRules))
        .find((value) => value.trim());
      if (directFieldLine) {
        nextEntries[field.id] = directFieldLine;
        return nextEntries;
      }

      const directLine = stitchedLines
        .map((line) => collectBlockForLabels(
          line,
          currentLabels,
          stopLabels,
          stopLabels,
          [],
          createFieldBlockBoundaryPolicy(behavior),
          sectionStopRules
        ))
        .find((value) => value.trim());
      nextEntries[field.id] = directLine ? this.normalizeGroupedFieldValue(directLine, stopLabels, sectionStopRules) : "";
      return nextEntries;
    }, {});
  }

  private stitchGroupedFieldContinuationLines(
    lines: string[],
    behavior: TemplateSectionGroupedFieldBlockBehaviorConfig
  ): string[] {
    const stitched: string[] = [];
    const fieldLabels = buildFieldLabelSet(behavior.fields);
    let canAppendContinuation = false;

    lines.forEach((line) => {
      if (!line.trim()) {
        canAppendContinuation = false;
        return;
      }

      const startsField = hasStructuralLabelStart(line, fieldLabels, {
        allowQuotePrefix: true,
        allowTightLabel: true,
        allowMarkdownHeading: true
      });
      if (!startsField && stitched.length > 0 && canAppendContinuation) {
        stitched[stitched.length - 1] = `${stitched[stitched.length - 1]}\n${line.trim()}`;
        return;
      }

      stitched.push(line);
      canAppendContinuation = true;
    });

    return stitched;
  }

  private extractSingleGroupedFieldLineValue(
    line: string,
    labels: string[],
    stopLabels: string[] = [],
    sectionStopRules: SectionStopRule[] = []
  ): string {
    const normalizedLine = line
      .trim()
      .replace(/^>\s*/, "")
      .replace(/^[-*]\s+/, "")
      .trim();
    for (const label of labels.sort((left, right) => right.length - left.length)) {
      const match = normalizedLine.match(new RegExp(`^${escapeRegExp(label)}\\s*[：:]\\s*(.*?)\\s*(?:\\n|$)`, "u"));
      if (match) {
        return this.normalizeGroupedFieldValue(
          truncateSectionBlockAtStructuralStopLabel(match[1] ?? "", stopLabels, label, sectionStopRules, {
            allowTightStructuralStops: true
          }),
          stopLabels,
          sectionStopRules
        );
      }
    }

    return "";
  }

  private matchGroupedFieldBlockHeading(
    line: string,
    behavior: TemplateSectionGroupedFieldBlockBehaviorConfig
  ): { group: TemplateSectionGroupedFieldBlockBehaviorConfig["groups"][number]; value: string } | null {
    const normalizedLine = line
      .trim()
      .replace(/^>\s*/, "")
      .replace(/^#{1,6}\s+/, "")
      .trim();
    if (!normalizedLine) {
      return null;
    }

    for (const group of behavior.groups) {
      const labels = buildGroupedBehaviorGroupLabels(group).sort((left, right) => right.length - left.length);
      for (const label of labels) {
        if (normalizedLine === label || normalizedLine === `${label}：` || normalizedLine === `${label}:`) {
          return { group, value: "" };
        }

        const prefixedValue = normalizedLine.match(new RegExp(`^${escapeRegExp(label)}\\s*[：:]\\s*(.+)$`, "u"))?.[1];
        if (prefixedValue !== undefined) {
          return { group, value: prefixedValue.trim() };
        }
      }
    }

    return null;
  }

  private hasGroupedDraftContent(
    behavior: TemplateSectionGroupedFieldBlockBehaviorConfig,
    draft: Record<string, Record<string, string>>
  ): boolean {
    return behavior.groups.some((group) =>
      this.hasGroupedRecordContent(behavior, draft[group.id] ?? {})
    );
  }

  private hasGroupedRecordContent(
    behavior: TemplateSectionGroupedFieldBlockBehaviorConfig,
    record: Record<string, string>
  ): boolean {
    return behavior.fields.some((field) => (record[field.id] ?? "").trim().length > 0);
  }

  private compactGroupedRecord(record: Record<string, string>): Record<string, string> {
    return Object.entries(record).reduce<Record<string, string>>((nextRecord, [key, value]) => {
      const normalizedValue = this.normalizeGroupedFieldValue(value);
      if (normalizedValue) {
        nextRecord[key] = normalizedValue;
      }
      return nextRecord;
    }, {});
  }

  private normalizeGroupedRecord(record: Record<string, string>): Record<string, string> {
    return Object.entries(record).reduce<Record<string, string>>((nextRecord, [key, value]) => {
      nextRecord[key] = this.normalizeGroupedFieldValue(value);
      return nextRecord;
    }, {});
  }

  private mergeGroupedRecordPreferComplete(
    existing: Record<string, string>,
    candidate: Record<string, string>
  ): Record<string, string> {
    const merged = { ...existing };
    Object.entries(candidate).forEach(([key, candidateValue]) => {
      const currentValue = this.normalizeGroupedFieldValue(merged[key] ?? "");
      const normalizedCandidate = this.normalizeGroupedFieldValue(candidateValue);
      if (!normalizedCandidate) {
        return;
      }

      if (
        !currentValue ||
        (normalizedCandidate.length > currentValue.length && normalizedCandidate.includes(currentValue))
      ) {
        merged[key] = normalizedCandidate;
      } else {
        merged[key] = currentValue;
      }
    });

    return this.normalizeGroupedRecord(merged);
  }

  private normalizeGroupedFieldValue(
    value: string,
    stopLabels: string[] = [],
    sectionStopRules: SectionStopRule[] = []
  ): string {
    const normalizedValue = normalizeInlineLabelValue(
      stripValueAfterKnownSectionLabelFragments(
        stripGroupedValueAfterKnownStopLabelFragments(value, stopLabels),
        sectionStopRules
      )
    ).replace(/\r?\n\s*/g, "");
    if (/^[=:：,，;；、\s]+$/u.test(normalizedValue)) {
      return "";
    }
    return this.stripTrailingGroupedStopLabelFragment(normalizedValue, stopLabels);
  }

  private stripTrailingGroupedStopLabelFragment(value: string, stopLabels: string[]): string {
    const normalizedValue = value.trim();
    if (!normalizedValue || stopLabels.length === 0) {
      return normalizedValue;
    }

    const stopFragments = uniqueLabels(stopLabels)
      .flatMap((label) => {
        const normalizedLabel = label.trim();
        if (normalizedLabel.length < 4) {
          return [];
        }

        const fragments = [normalizedLabel];
        for (let length = 4; length < normalizedLabel.length; length += 1) {
          fragments.push(normalizedLabel.slice(0, length));
        }
        return fragments;
      })
      .sort((left, right) => right.length - left.length);

    for (const fragment of stopFragments) {
      const fragmentStartIndex = normalizedValue.length - fragment.length;
      if (fragmentStartIndex <= 0 || !normalizedValue.endsWith(fragment)) {
        continue;
      }

      const previousChar = normalizedValue.charAt(fragmentStartIndex - 1);
      if (!/[，,；;、\s:：|｜/\\\-—–~·]/u.test(previousChar)) {
        continue;
      }

      const candidate = normalizedValue.slice(0, fragmentStartIndex).trimEnd();
      if (!/[，,；;、:：|｜/\\\-—–~·]$/.test(candidate)) {
        continue;
      }

      return candidate;
    }

    return normalizedValue;
  }

  private extractSequentialGroupedFieldRecords(
    sourceText: string,
    behavior: TemplateSectionGroupedFieldBlockBehaviorConfig,
    allSectionLabels: string[] = [],
    allFieldLabels: string[] = [],
    sectionStopRules: SectionStopRule[] = []
  ): Array<Record<string, string>> {
    const fieldLabels = buildFieldLabelSet(behavior.fields);
    const primaryField = behavior.fields[0];
    if (!primaryField || fieldLabels.length === 0) {
      return [];
    }

    const primaryLabels = buildFieldCandidateLabels(primaryField);
    const groupLabels = uniqueLabels(behavior.groups.flatMap((group) => buildGroupedBehaviorGroupLabels(group)));
    const groupPrefixPattern = new RegExp(
      `(^|[\\n\\s])(?:${groupLabels.map((label) => escapeRegExp(label)).join("|")})\\s*[：:]?\\s*(?=${primaryLabels.map((label) => escapeRegExp(label)).join("|")})`,
      "gu"
    );
    const standaloneGroupPattern = new RegExp(
      `(^|\\n)\\s*(?:${groupLabels.map((label) => escapeRegExp(label)).join("|")})\\s*[：:]\\s*(?=\\n\\s*(?:${primaryLabels.map((label) => escapeRegExp(label)).join("|")}))`,
      "gu"
    );
    const normalizedSource = normalizeSectionLocalLabelFlow(sourceText, fieldLabels, fieldLabels, [])
      .replace(standaloneGroupPattern, "\n")
      .replace(groupPrefixPattern, (_match, prefix: string) => prefix.includes("\n") ? prefix : "\n");
    const lines = normalizedSource.split(/\r?\n/);
    const segments: string[] = [];
    let currentSegment: string[] = [];

    lines.forEach((line) => {
      const startsPrimary = hasStructuralLabelStart(line, primaryLabels);
      if (startsPrimary && currentSegment.some((segmentLine) => segmentLine.trim().length > 0)) {
        segments.push(currentSegment.join("\n"));
        currentSegment = [];
      }
      currentSegment.push(line);
    });

    if (currentSegment.some((line) => line.trim().length > 0)) {
      segments.push(currentSegment.join("\n"));
    }

    return segments
      .map((segment) => {
        const entries = behavior.fields.reduce<Record<string, string>>((nextEntries, field) => {
          const labels = buildFieldCandidateLabels(field);
          const stopLabels = uniqueLabels([
            ...fieldLabels.filter((label) => !labels.includes(label)),
            ...allFieldLabels.filter((label) => !labels.includes(label)),
            ...allSectionLabels
          ]);
          nextEntries[field.id] = this.normalizeGroupedFieldValue(
            collectBlockForLabels(segment, labels, stopLabels, stopLabels, [], createFieldBlockBoundaryPolicy(behavior), sectionStopRules),
            stopLabels,
            sectionStopRules
          );
          return nextEntries;
        }, {});
        return entries;
      })
      .filter((record) => Object.values(record).some((value) => value.trim().length > 0));
  }

  private extractTableBlock(
    sourceText: string,
    section: TemplateSectionConfig,
    sectionStopLabels: string[] = [],
    sectionStopRules: SectionStopRule[] = []
  ): Array<Record<string, string>> {
    const behavior = section.behavior as TemplateSectionTableBlockBehaviorConfig;
    const markdownRows = extractMarkdownTable(sourceText, behavior.columns);
    if (markdownRows.length > 0) {
      return markdownRows;
    }

    return extractStructuredTableRows(
      sourceText,
      behavior.columns,
      createTableCellBoundaryPolicy(behavior),
      sectionStopLabels,
      sectionStopRules
    );
  }

  private extractMixedFieldBlock(
    sourceText: string,
    section: TemplateSectionConfig,
    allSectionLabels: string[],
    allFieldLabels: string[],
    sectionStopRules: SectionStopRule[] = []
  ): Record<string, string> {
    const behavior = section.behavior as TemplateSectionMixedFieldBlockBehaviorConfig;
    const identityLabelSet = new Set(collectMixedFieldBlockIdentityLabels(behavior));
    const extractableLabels = uniqueLabels(
      behavior.items.flatMap((item) => {
        if (item.kind === "static_note") {
          return [];
        }

        if (item.kind === "inline_field_group") {
          return [
            item.id,
            item.label,
            ...(item.aliases ?? []),
            ...item.fields.flatMap((field) => [field.fieldName, field.id, field.label, ...(field.aliases ?? [])])
          ];
        }

        return [item.label, item.targetFieldName ?? "", ...(item.aliases ?? [])];
      })
    );
    const draft = behavior.items.reduce<Record<string, string>>((draft, item) => {
      if (item.kind === "text_field" || item.kind === "checkbox_enum" || item.kind === "task_list") {
        const identityLabels = uniqueLabels([item.targetFieldName ?? "", item.id, item.label]);
        const labels = uniqueLabels([
          ...identityLabels,
          ...(item.aliases ?? []).filter((alias) => identityLabels.includes(alias) || !identityLabelSet.has(alias))
        ]);
        const stopLabels = extractableLabels.filter((label) => !identityLabels.includes(label));
        const mixedItemStopRules = buildMixedItemStopRules(section, behavior, item);
        const taskItemLabels = behavior.items
          .filter((candidateItem): candidateItem is Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "task_list" }> =>
            candidateItem.kind === "task_list"
          )
          .flatMap((candidateItem) => [candidateItem.targetFieldName ?? "", candidateItem.id, candidateItem.label, ...(candidateItem.aliases ?? [])]);
        const rawValue = collectBlockForLabels(sourceText, labels, [
          ...stopLabels,
          ...(item.kind === "text_field" ? COMPLETED_ONLY_TASK_LINE_LABELS : []),
          ...allFieldLabels.filter((label) => !identityLabels.includes(label)),
          ...allSectionLabels
        ], [
          ...stopLabels,
          ...(item.kind === "text_field" ? COMPLETED_ONLY_TASK_LINE_LABELS : []),
          ...allFieldLabels.filter((label) => !identityLabels.includes(label)),
          ...allSectionLabels
        ], [], createFieldBlockBoundaryPolicy(behavior), [...mixedItemStopRules, ...sectionStopRules]);
        const targetKey = item.targetFieldName ?? item.label;
        if (item.kind === "checkbox_enum") {
          const optionSource = item.selectMode === "single"
            ? stripCompletedOptionText(rawValue) || rawValue
            : rawValue;
          const optionMode =
            item.checkedValueFieldName || (item.selectMode === "single" && !/[;；、/]/.test(optionSource))
              ? "single"
              : "multi";
          draft[targetKey] = matchMixedOptionLabel(
            optionSource,
            item.options,
            optionMode
          );
          if (item.checkedValueFieldName) {
            const completedOptionText = extractCompletedOptionText(rawValue);
            draft[item.checkedValueFieldName] = completedOptionText
              ? matchMixedOptionLabel(completedOptionText, item.options, "multi")
              : "";
          }
          return draft;
        }

        const mixedTaskTemplateItems =
          item.kind === "task_list"
            ? extractTemplateTaskItems(section, "", item.taskPrefix ?? "- [ ] ")
            : [];
        const hasConcreteMixedTaskTemplateItems = mixedTaskTemplateItems.some((taskItem) => !isPlaceholderTaskItem(taskItem));
        draft[targetKey] = item.kind === "task_list"
          ? normalizeMixedTaskListDraft(
            appendTaskCompletionHintsToDraftContent(
              stripLeadingInlineLabel(rawValue, [item.targetFieldName ?? ""]),
              sourceText,
              hasConcreteMixedTaskTemplateItems ? mixedTaskTemplateItems : [],
              item.taskPrefix ?? "- [ ] "
            ),
            item.taskPrefix ?? "- [ ] ",
            hasConcreteMixedTaskTemplateItems ? mixedTaskTemplateItems : [],
            { allowPostfixedCompletedMarker: !hasConcreteMixedTaskTemplateItems }
          )
          : trimMixedTextFieldValue(truncateMixedTextFieldAtTaskCompletionHint(rawValue, taskItemLabels));
        return draft;
      }

      if (item.kind === "inline_field_group") {
        const groupLabels = uniqueLabels([item.label, ...(item.aliases ?? [])]);
        const childLabels = uniqueLabels(
          item.fields.flatMap((field) => [field.fieldName, field.id, field.label, ...(field.aliases ?? [])])
        );
        const groupStopLabels = extractableLabels.filter(
          (label) => !groupLabels.includes(label) && !childLabels.includes(label)
        );
        const mixedItemStopRules = buildMixedItemStopRules(section, behavior, item);
        const groupBlock = collectInlineFieldGroupBlock(sourceText, groupLabels, childLabels, [
          ...groupStopLabels,
          ...allFieldLabels.filter((label) => !groupLabels.includes(label) && !childLabels.includes(label)),
          ...allSectionLabels
        ], createFieldBlockBoundaryPolicy(behavior), [...mixedItemStopRules, ...sectionStopRules]);
        const inlineGroupSource = groupBlock.trim() ? groupBlock : sourceText;

        item.fields.forEach((field) => {
          const identityLabels = uniqueLabels([field.fieldName, ...buildFieldIdentityLabels(field)]);
          const labels = uniqueLabels([field.fieldName, field.id, field.label, ...(field.aliases ?? [])]);
          const stopLabels = extractableLabels.filter((label) => !identityLabels.includes(label));
          const rawValue = collectBlockForLabels(inlineGroupSource, labels, [
            ...stopLabels,
            ...allFieldLabels.filter((label) => !identityLabels.includes(label)),
            ...allSectionLabels
          ], [
            ...stopLabels,
            ...allFieldLabels.filter((label) => !identityLabels.includes(label)),
            ...allSectionLabels
          ], [], createFieldBlockBoundaryPolicy(behavior), [...mixedItemStopRules, ...sectionStopRules]);
          if (rawValue.trim()) {
            draft[field.fieldName] = rawValue;
          }
        });
      }

      return draft;
    }, {});

    return draft;
  }

  private getTemplateSectionBodyLines(templateContent: string, title: string): string[] {
    const lines = templateContent.split(/\r?\n/);
    let startIndex = -1;
    let endIndex = lines.length;
    let headingLevel = 1;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (startIndex >= 0 && isMarkdownThematicBreak(line)) {
        endIndex = index;
        break;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (!headingMatch) {
        continue;
      }

      const headingTitle = headingMatch[2]?.trim() ?? "";
      if (startIndex < 0 && headingTitle === title) {
        headingLevel = headingMatch[1]?.length ?? 1;
        startIndex = index + 1;
        continue;
      }

      if (startIndex >= 0) {
        const nextHeadingLevel = headingMatch[1]?.length ?? 1;
        if (nextHeadingLevel > headingLevel) {
          continue;
        }
        endIndex = index;
        break;
      }
    }

    if (startIndex < 0) {
      return [];
    }

    return lines.slice(startIndex, endIndex);
  }

  buildMixedFieldBlockSectionOverrideFromFieldValues(
    templateContent: string,
    section: TemplateSectionConfig,
    fieldValues: Record<string, string>,
    activeFieldNames?: Set<string>
  ): { title: string; content: string; mode: "append" | "replace" } | null {
    if (!this.isMixedFieldBlockSection(section)) {
      return null;
    }

    const behavior = section.behavior as TemplateSectionMixedFieldBlockBehaviorConfig;
    const content = this.buildMixedFieldBlockSectionContent(
      templateContent,
      section,
      fieldValues,
      activeFieldNames
    );
    if (!content.trim()) {
      return null;
    }

    return {
      title: section.title,
      content,
      mode: behavior.overrideMode ?? "replace"
    };
  }

  private replaceStructuredLine(
    lines: string[],
    label: string,
    value: string,
    linePrefix: string,
    separator: string
  ): void {
    const pattern = buildStructuredLinePattern(linePrefix, label, separator);
    const nextValue = value.trim();
    let replaced = false;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!pattern.test(line)) {
        continue;
      }

      const prefix = line.replace(pattern, "$1");
      lines[index] = nextValue.length > 0 ? `${prefix} ${nextValue}` : prefix;
      replaced = true;
      break;
    }

    if (!nextValue.length) {
      return;
    }

    if (!replaced) {
      const normalizedSeparator = separator.trim();
      const lineBase = normalizedSeparator
        ? `${linePrefix}${label}${normalizedSeparator}`
        : `${linePrefix}${label}`;
      lines.push(`${lineBase}${nextValue ? ` ${nextValue}` : ""}`);
    }
  }

  private buildFieldBlockSectionContent(
    templateContent: string,
    section: TemplateSectionConfig,
    draft: Record<string, string>
  ): string {
    const behavior = section.behavior as TemplateSectionFieldBlockBehaviorConfig;
    const lines = this.getTemplateSectionBodyLines(templateContent, section.title);
    const linePrefix = behavior.linePrefix ?? "> - ";
    const separator = behavior.separator ?? "：";

    behavior.fields.forEach((field) => {
      this.replaceStructuredLine(lines, field.label, draft[field.id] ?? "", linePrefix, separator);
    });

    return lines.join("\n").trim();
  }

  private buildGroupedFieldBlockSectionContent(
    templateContent: string,
    section: TemplateSectionConfig,
    draft: Record<string, Record<string, string>>
  ): string {
    const behavior = section.behavior as TemplateSectionGroupedFieldBlockBehaviorConfig;
    const lines = this.getTemplateSectionBodyLines(templateContent, section.title);
    const headingPrefix = behavior.groupHeadingPrefix ?? "> ## ";
    const linePrefix = behavior.linePrefix ?? "> - ";
    const separator = behavior.separator ?? "：";
    const anyGroupHeadingPattern = buildGroupHeadingPattern(headingPrefix);

    behavior.groups.forEach((group) => {
      const headingPattern = buildGroupHeadingPattern(headingPrefix, group.label);
      const startIndex = lines.findIndex((line) => headingPattern.test(line ?? ""));
      if (startIndex < 0) {
        return;
      }

      let endIndex = lines.length;
      for (let index = startIndex + 1; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (anyGroupHeadingPattern.test(line)) {
          endIndex = index;
          break;
        }
      }

      const blockLines = lines.slice(startIndex + 1, endIndex);
      const blockFieldIds = getGroupedTemplateBlockFieldIds(blockLines, behavior, linePrefix, separator);
      behavior.fields.forEach((field) => {
        if (!blockFieldIds.has(field.id)) {
          return;
        }

        this.replaceStructuredLine(
          blockLines,
          field.label,
          draft[group.id]?.[field.id] ?? "",
          linePrefix,
          separator
        );
      });
      lines.splice(startIndex + 1, endIndex - startIndex - 1, ...blockLines);
    });

    return lines.join("\n").trim();
  }

  private buildMixedFieldBlockSectionContent(
    templateContent: string,
    section: TemplateSectionConfig,
    fieldValues: Record<string, string>,
    activeFieldNames?: Set<string>
  ): string {
    const behavior = section.behavior as TemplateSectionMixedFieldBlockBehaviorConfig;
    const lines = this.getTemplateSectionBodyLines(templateContent, section.title);
    if (lines.length === 0) {
      return "";
    }

    const resolvedFieldValues = this.buildMixedFieldValueMapForWrite(
      lines,
      behavior,
      fieldValues,
      activeFieldNames
    );

    behavior.items.forEach((item) => {
      if (item.kind === "text_field") {
        const value = resolvedFieldValues[item.targetFieldName ?? item.label] ?? "";
        this.replaceMixedTextLine(lines, item.label, value);
        return;
      }

      if (item.kind === "inline_field_group") {
        this.replaceMixedInlineFieldGroup(lines, item, resolvedFieldValues, activeFieldNames);
        return;
      }

      if (item.kind === "checkbox_enum") {
        const value = resolvedFieldValues[item.targetFieldName ?? item.label] ?? "";
        const checkedValue = item.checkedValueFieldName
          ? resolvedFieldValues[item.checkedValueFieldName] ?? value
          : value;
        this.replaceMixedCheckboxGroup(lines, item, value, checkedValue);
        return;
      }

      if (item.kind === "task_list") {
        const value = resolvedFieldValues[item.targetFieldName ?? item.label] ?? "";
        this.replaceMixedTaskListBlock(lines, item, value);
      }
    });

    return lines.join("\n").trim();
  }

  private buildMixedFieldValueMapForWrite(
    lines: string[],
    behavior: TemplateSectionMixedFieldBlockBehaviorConfig,
    fieldValues: Record<string, string>,
    activeFieldNames?: Set<string>
  ): Record<string, string> {
    const nextValues = { ...fieldValues };
    const visibleItems = behavior.items.filter(
      (
        item
      ): item is Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "text_field" | "checkbox_enum" | "task_list" }> =>
        (item.kind === "text_field" || item.kind === "checkbox_enum" || item.kind === "task_list") &&
        (!activeFieldNames || activeFieldNames.has((item.targetFieldName ?? item.label).trim()))
    );
    const visibleCandidates = visibleItems.map((item) => ({
      key: item.targetFieldName ?? item.label,
      item,
      labels: uniqueLabels([item.label, item.targetFieldName ?? "", ...(item.aliases ?? [])])
    }));

    behavior.items.forEach((item) => {
      if (item.kind !== "inline_field_group") {
        return;
      }

      item.fields.forEach((field) => {
        if (activeFieldNames && !activeFieldNames.has(field.fieldName.trim())) {
          delete nextValues[field.fieldName];
          return;
        }

        const existingValue = nextValues[field.fieldName]?.trim() ?? "";
        const fallbackCandidate = visibleCandidates
          .map((candidate) => ({
            candidate,
            score: scoreFieldLinkCandidate(field.fieldName, candidate.labels)
          }))
          .filter(
            ({ candidate, score }) => score > 0 && (nextValues[candidate.key] ?? "").trim().length > 0
          )
          .sort((left, right) => {
            if (left.score !== right.score) {
              return right.score - left.score;
            }

            return left.candidate.key.length - right.candidate.key.length;
          })[0]?.candidate;

        if (existingValue) {
          if (fallbackCandidate?.item.kind === "checkbox_enum") {
            const normalizedExistingValue = this.mapMixedCheckboxValueToInlineValue(
              lines,
              item,
              field.fieldName,
              fallbackCandidate.item,
              existingValue
            );
            nextValues[field.fieldName] = normalizedExistingValue || existingValue;
          }
          return;
        }
      });
    });

    return nextValues;
  }

  private applyTemplateFieldAliases(
    sections: TemplateSectionConfig[],
    templateFields: TemplateFieldContext | TemplateFieldConfig[] | undefined
  ): TemplateSectionConfig[] {
    const aliasMap = buildTemplateFieldAliasMap(templateFields);
    if (aliasMap.size === 0) {
      return sections;
    }

    return sections.map((section) => {
      const rawContent = getRuntimeSectionRawContent(section);
      if (!section.behavior) {
        return section;
      }

      if (section.behavior.kind === "field_block") {
        return {
          ...section,
          rawContent,
          behavior: {
            ...section.behavior,
            fields: section.behavior.fields.map((field) => ({
              ...field,
              aliases: this.resolveAliasedLabels(aliasMap, field.aliases, field.id, field.label)
            }))
          }
        };
      }

      if (section.behavior.kind === "grouped_field_block") {
        return {
          ...section,
          rawContent,
          behavior: {
            ...section.behavior,
            fields: section.behavior.fields.map((field) => ({
              ...field,
              aliases: this.resolveAliasedLabels(aliasMap, field.aliases, field.id, field.label)
            }))
          }
        };
      }

      if (section.behavior.kind === "table_block") {
        return {
          ...section,
          rawContent,
          behavior: {
            ...section.behavior,
            columns: section.behavior.columns.map((column) => ({
              ...column,
              aliases: this.resolveAliasedLabels(aliasMap, column.aliases, column.id, column.label)
            }))
          }
        };
      }

      if (section.behavior.kind !== "mixed_field_block") {
        return section;
      }

      return {
        ...section,
        rawContent,
        behavior: {
          ...section.behavior,
          items: section.behavior.items.map((item) => {
            if (item.kind === "static_note") {
              return item;
            }

            if (item.kind === "inline_field_group") {
              return {
                ...item,
                fields: item.fields.map((field) => ({
                  ...field,
                  aliases: this.resolveAliasedLabels(aliasMap, field.aliases, field.fieldName, field.id, field.label)
                }))
              };
            }

            if (item.kind === "checkbox_enum") {
              const aliasedItem = {
                ...item,
                aliases: this.resolveAliasedLabels(
                  aliasMap,
                  item.aliases,
                  item.targetFieldName ?? item.label,
                  item.id,
                  item.label
                )
              };
              return applyLinkedOptionAliasesToMixedCheckboxItem(aliasedItem, templateFields);
            }

            return {
              ...item,
              aliases: this.resolveAliasedLabels(
                aliasMap,
                item.aliases,
                item.targetFieldName ?? item.label,
                item.id,
                item.label
              )
            };
          })
        }
      };
    });
  }

  private resolveAliasedLabels(
    aliasMap: Map<string, string[]>,
    existingAliases: string[] | undefined,
    ...candidates: string[]
  ): string[] | undefined {
    const mergedAliases = uniqueLabels([
      ...(existingAliases ?? []),
      ...candidates.flatMap((candidate) => aliasMap.get(candidate.trim()) ?? [])
    ]);

    return mergedAliases.length > 0 ? mergedAliases : undefined;
  }

  private mapMixedCheckboxValueToInlineValue(
    lines: string[],
    inlineGroup: Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "inline_field_group" }>,
    fieldName: string,
    checkboxItem: Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "checkbox_enum" }>,
    rawValue: string
  ): string {
    const block = this.findMixedItemBlock(lines, inlineGroup.label);
    if (!block) {
      return rawValue;
    }

    const nestedLines = lines.slice(block.startIndex + 1, block.endIndex);
    const inlinePattern = new RegExp(`\\[${escapeRegExp(fieldName)}::\\s*([^\\]]*)\\]`);
    const inlineLine = nestedLines.find((line) => inlinePattern.test(line ?? ""));
    const inlineValue = inlineLine?.match(inlinePattern)?.[1]?.trim() ?? "";
    const inlineOptions = inlineValue
      .split(/\s*\/\s*/)
      .map((option) => option.trim())
      .filter((option) => option.length > 0);

    const matchedIndex = checkboxItem.options.findIndex((option) => {
      const normalizedRaw = normalizeLooseCompareValue(rawValue);
      const candidates = [option.label, option.value, ...(option.aliases ?? [])]
        .map(normalizeLooseCompareValue)
        .filter(Boolean);
      return candidates.some(
        (candidate) =>
          candidate === normalizedRaw ||
          normalizedRaw.includes(candidate) ||
          candidate.includes(normalizedRaw)
      );
    });

    if (matchedIndex < 0 || matchedIndex >= inlineOptions.length) {
      return rawValue;
    }

    return inlineOptions[matchedIndex] ?? rawValue;
  }

  private findMixedItemBlock(lines: string[], label: string): { startIndex: number; endIndex: number } | null {
    const escapedLabel = escapeRegExp(label.trim());
    const startPatterns = [
      new RegExp(`^(\\s*(?:>\\s*)?[-*+]\\s+)${escapedLabel}\\s*[：:]\\s*(.*)$`),
      new RegExp(`^(\\s*(?:>\\s*)?)${escapedLabel}\\s*[：:]\\s*$`),
      new RegExp(`^\\s*#{2,6}\\s+${escapedLabel}\\s*$`)
    ];
    const nextPatterns = [
      /^\s*(?:>\s*)?[-*+]\s+.+?[：:]\s*(.*)$/,
      /^\s*(?:>\s*)?(?![-*+]\s+).+?[：:]\s*$/
    ];
    const headingPattern = /^(#{1,6})\s+/;
    const startIndex = lines.findIndex((line) => startPatterns.some((pattern) => pattern.test(line ?? "")));
    if (startIndex < 0) {
      return null;
    }

    let endIndex = lines.length;
    const startIndent = (lines[startIndex]?.match(/^(\s*)/)?.[1]?.length ?? 0);
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (headingPattern.test(line)) {
        endIndex = index;
        break;
      }
      if (indent <= startIndent && nextPatterns.some((pattern) => pattern.test(line))) {
        endIndex = index;
        break;
      }
    }

    return { startIndex, endIndex };
  }

  private findMixedTaskPlaceholderBlock(
    lines: string[],
    item: Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "task_list" }>
  ): { startIndex: number; endIndex: number } | null {
    const fieldName = (item.targetFieldName ?? item.label).trim();
    if (!fieldName) {
      return null;
    }

    const placeholderPattern = new RegExp(
      `^\\s*[-*+]\\s+\\[(?: |x|X)\\]\\s+\\{\\{\\s*${escapeRegExp(fieldName)}\\s*\\}\\}\\s*$`
    );
    const startIndex = lines.findIndex((line) => placeholderPattern.test(line ?? ""));
    if (startIndex < 0) {
      return null;
    }

    let endIndex = startIndex + 1;
    while (endIndex < lines.length && placeholderPattern.test(lines[endIndex] ?? "")) {
      endIndex += 1;
    }

    return { startIndex, endIndex };
  }

  private findMixedTaskListBlock(
    lines: string[],
    item: Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "task_list" }>
  ): { startIndex: number; endIndex: number; includesLabelLine: boolean } | null {
    const labeledBlock = this.findMixedItemBlock(lines, item.label);
    if (labeledBlock) {
      return { ...labeledBlock, includesLabelLine: true };
    }

    const placeholderBlock = this.findMixedTaskPlaceholderBlock(lines, item);
    return placeholderBlock ? { ...placeholderBlock, includesLabelLine: false } : null;
  }

  private replaceMixedTextLine(lines: string[], label: string, value: string): void {
    const escapedLabel = escapeRegExp(label.trim());
    const pattern = new RegExp(`^(\\s*(?:>\\s*)?[-*+]\\s+${escapedLabel}\\s*(?:::|[：:]))\\s*(.*)$`);
    const plainLabelPattern = new RegExp(`^(\\s*(?:>\\s*)?${escapedLabel}\\s*[：:]\\s*)$`);
    const inlinePattern = new RegExp(`(\\[${escapedLabel}::)\\s*([^\\]]*)(\\])`);
    const nextValue = value.trim();
    const lineIndex = lines.findIndex((line) => pattern.test(line ?? ""));
    if (lineIndex >= 0) {
      const prefix = (lines[lineIndex] ?? "").replace(pattern, "$1");
      lines[lineIndex] = nextValue ? `${prefix} ${nextValue}` : (lines[lineIndex] ?? "");
      return;
    }

    const plainLabelIndex = lines.findIndex((line) => plainLabelPattern.test(line ?? ""));
    if (plainLabelIndex >= 0) {
      if (!nextValue) {
        return;
      }

      const nextLine = lines[plainLabelIndex + 1] ?? "";
      if (/^\s*(?:>\s*)?[-*+]\s*$/.test(nextLine)) {
        const prefix = nextLine.match(/^(\s*(?:>\s*)?[-*+]\s*)/)?.[1] ?? "- ";
        lines[plainLabelIndex + 1] = `${prefix}${nextValue}`;
        return;
      }

      lines.splice(plainLabelIndex + 1, 0, `- ${nextValue}`);
      return;
    }

    const inlineLineIndex = lines.findIndex((line) => inlinePattern.test(line ?? ""));
    if (inlineLineIndex >= 0) {
      if (!nextValue) {
        return;
      }
      lines[inlineLineIndex] = (lines[inlineLineIndex] ?? "").replace(
        inlinePattern,
        `$1 ${nextValue}$3`
      );
      return;
    }

    if (!nextValue) {
      return;
    }

    lines.push(`- ${label}：${nextValue ? ` ${nextValue}` : ""}`);
  }

  private replaceMixedInlineFieldGroup(
    lines: string[],
    item: Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "inline_field_group" }>,
    fieldValues: Record<string, string>,
    activeFieldNames?: Set<string>
  ): void {
    const block = this.findMixedItemBlock(lines, item.label);
    if (!block) {
      return;
    }

    const nestedLines = lines.slice(block.startIndex + 1, block.endIndex);
    item.fields.forEach((field) => {
      const fieldName = field.fieldName.trim();
      const isActive = !activeFieldNames || activeFieldNames.has(fieldName);
      const nextValue = fieldValues[field.fieldName]?.trim() ?? "";
      const inlinePattern = new RegExp(`(\\[${escapeRegExp(field.fieldName)}::)\\s*([^\\]]*)(\\])`);
      const nestedIndex = nestedLines.findIndex((line) => inlinePattern.test(line ?? ""));
      if (!isActive) {
        if (nestedIndex >= 0) {
          nestedLines.splice(nestedIndex, 1);
        }
        return;
      }

      if (nestedIndex >= 0) {
        if (!nextValue) {
          return;
        }
        nestedLines[nestedIndex] = (nestedLines[nestedIndex] ?? "").replace(
          inlinePattern,
          `$1 ${nextValue}$3`
        );
        return;
      }

      if (!nextValue) {
        return;
      }

      nestedLines.push(`  - [${field.fieldName}:: ${nextValue}]`);
    });

    lines.splice(block.startIndex + 1, block.endIndex - block.startIndex - 1, ...nestedLines);
  }

  private replaceMixedCheckboxGroup(
    lines: string[],
    item: Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "checkbox_enum" }>,
    value: string,
    checkedValue: string = value
  ): void {
    const block = this.findMixedItemBlock(lines, item.label);
    if (!block) {
      return;
    }

    const selectedValues = checkedValue
      .split(/[\n,;；、/]+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const isSelected = (option: TemplateSectionMixedFieldBlockOptionConfig): boolean => {
      const candidates = [option.label, option.value, ...(option.aliases ?? [])]
        .map((candidate) => candidate.trim().toLowerCase())
        .filter((candidate) => candidate.length > 0);
      return selectedValues.some((selected) => candidates.includes(selected.trim().toLowerCase()));
    };

    const nestedLines = lines.slice(block.startIndex + 1, block.endIndex);
    const startLine = lines[block.startIndex] ?? "";
    const startValuePattern = new RegExp(`^(\\s*(?:>\\s*)?[-*+]\\s+${escapeRegExp(item.label)}\\s*[：:])\\s*(.*)$`);
    if (startValuePattern.test(startLine) && /{{\s*[^{}\r\n]+?\s*}}/.test(startLine) && value.trim()) {
      lines[block.startIndex] = startLine.replace(startValuePattern, `$1 ${value.trim()}`);
    }

    item.options.forEach((option) => {
      const optionPattern = new RegExp(`^(\\s*(?:>\\s*)?[-*+]\\s+\\[)(?: |x|X)(\\]\\s+${escapeRegExp(option.label)}\\s*)$`);
      const optionIndex = nestedLines.findIndex((line) => optionPattern.test(line ?? ""));
      const checked = isSelected(option) ? "x" : " ";
      if (optionIndex >= 0) {
        nestedLines[optionIndex] = (nestedLines[optionIndex] ?? "").replace(optionPattern, `$1${checked}$2`);
        return;
      }

      nestedLines.push(`  - [${checked}] ${option.label}`);
    });

    lines.splice(block.startIndex + 1, block.endIndex - block.startIndex - 1, ...nestedLines);
  }

  private replaceMixedTaskListBlock(
    lines: string[],
    item: Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "task_list" }>,
    value: string
  ): void {
    const block = this.findMixedTaskListBlock(lines, item);
    const blockTaskLines = block
      ? lines.slice(block.includesLabelLine ? block.startIndex + 1 : block.startIndex, block.endIndex)
      : [];
    const nextTaskLines = block
      ? mergeTaskListIntoTemplateLines(
          [...blockTaskLines],
          value,
          item.taskPrefix ?? "- [ ] ",
          "",
          undefined,
          { allowPostfixedCompletedMarker: isFieldBackedTaskTemplateLines(blockTaskLines) }
        )
      : [];
    const normalized = nextTaskLines.length > 0
      ? nextTaskLines.join("\n").trim()
      : normalizeMixedTaskListDraft(value, item.taskPrefix ?? "- [ ] ", [], { allowPostfixedCompletedMarker: true });
    if (!normalized) {
      return;
    }

    const nextLines = normalized.split("\n");
    if (!block) {
      lines.push(`${item.label}：`, ...nextLines);
      return;
    }

    const replaceStartIndex = block.includesLabelLine ? block.startIndex + 1 : block.startIndex;
    lines.splice(replaceStartIndex, block.endIndex - replaceStartIndex, ...nextLines);
  }

  private buildTableBlockSectionContent(
    templateContent: string,
    section: TemplateSectionConfig,
    draft: Array<Record<string, string>>
  ): string {
    const behavior = section.behavior as TemplateSectionTableBlockBehaviorConfig;
    const rows = cloneTableBlockDraft(draft).filter((row) =>
      behavior.columns.some((column) => readTableCellValue(row, column).trim().length > 0)
    );
    if (rows.length === 0) {
      return "";
    }

    const headerLine = `| ${behavior.columns.map((column) => column.label).join(" | ")} |`;
    const separatorLine = `| ${behavior.columns.map(() => "---").join(" | ")} |`;
    const bodyLines = rows.map(
      (row) => `| ${behavior.columns.map((column) => readTableCellValue(row, column).trim()).join(" | ")} |`
    );

    const lines = this.getTemplateSectionBodyLines(templateContent, section.title);
    const tableStartIndex = lines.findIndex(
      (line, index) =>
        line.includes("|") &&
        index + 1 < lines.length &&
        isMarkdownTableSeparatorRow(lines[index + 1] ?? "")
    );

    if (tableStartIndex < 0) {
      return [headerLine, separatorLine, ...bodyLines].join("\n").trim();
    }

    let tableEndIndex = lines.length;
    for (let index = tableStartIndex + 2; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line.includes("|")) {
        tableEndIndex = index;
        break;
      }
    }

    lines.splice(tableStartIndex, tableEndIndex - tableStartIndex, headerLine, separatorLine, ...bodyLines);
    return lines.join("\n").trim();
  }
}
