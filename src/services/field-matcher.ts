import type { FieldMatchResult } from "../types/match";
import type { TemplateFieldConfig } from "../types/template";
import type { FieldStructureDescriptor } from "../types/template-structure-descriptor";
import {
  collectBestLabelBlock,
  compareLabelMatches,
  escapeRegExp,
  hasStructuralLabelStart,
  normalizeInlineLabelValue,
  truncateFieldValueAtNextKnownLabel,
  truncateFrontmatterShortValueAtNextKnownLabel,
  type LabelBlockMatch as BaseLabelBlockMatch
} from "../utils/label-block";
import { FieldNormalizer } from "./field-normalizer";
import type { TemplateFieldContext } from "./template-field-state-service";
import { isTemplateFieldContext, resolveTemplateFieldContextFields } from "./template-field-state-service";
import { isBooleanLikeField } from "../utils/boolean-like-field";
import { expandLabelVariants } from "../utils/label-variants";
import { normalizeCompactSourceLabelFlow } from "../utils/source-label-flow";

export type FieldMatcherInput = TemplateFieldConfig | FieldStructureDescriptor;
export type FieldMatcherCollectionInput =
  | TemplateFieldContext
  | FieldMatcherInput[];

export interface MatchOptions {
  enableAliasMatching: boolean;
  unmatchedFieldsStartEnabled: boolean;
  sourceTextAlreadyNormalized?: boolean;
}

interface LabelBlockMatch extends BaseLabelBlockMatch {
  label: string;
  matchReason: "label" | "alias";
}

export interface SourceLabelMatch {
  value: string;
  label: string;
}

function isFieldStructureDescriptor(value: FieldMatcherInput): value is FieldStructureDescriptor {
  return "fieldName" in value && "features" in value && "evidence" in value;
}

function resolveMatcherFields(fields: FieldMatcherCollectionInput): FieldMatcherInput[] {
  if (!Array.isArray(fields) && isTemplateFieldContext(fields)) {
    return fields.snapshot.matcherFields;
  }

  if (Array.isArray(fields) && fields.every(isFieldStructureDescriptor)) {
    return fields;
  }

  return resolveTemplateFieldContextFields(fields as TemplateFieldContext | TemplateFieldConfig[]);
}

function resolveStructuralBoundaryLabels(fields: FieldMatcherCollectionInput): string[] {
  return !Array.isArray(fields) && isTemplateFieldContext(fields)
    ? Array.from(fields.snapshot.structuralBoundaryLabels)
    : [];
}

function getFieldName(field: FieldMatcherInput): string {
  return isFieldStructureDescriptor(field) ? field.fieldName : field.name;
}

function isMatcherFieldEnabled(field: FieldMatcherInput): boolean {
  return field.enabledByDefault;
}

function getFieldAliases(field: FieldMatcherInput): string[] {
  return expandLabelVariants(field.aliases);
}

function getFieldSemanticTriggers(field: FieldMatcherInput): string[] {
  return field.semanticTriggers ?? [];
}

function isBooleanLikeMatcherField(field: FieldMatcherInput): boolean {
  return isFieldStructureDescriptor(field)
    ? field.features.includes("boolean_like_options")
    : isBooleanLikeField(field);
}

function hasFrontmatterPlaceholderTarget(field: FieldMatcherInput): boolean {
  if (isFieldStructureDescriptor(field)) {
    return (field.frontmatterTargets ?? []).length > 0 || field.renderTargetKinds.includes("frontmatter");
  }

  return (field.frontmatterTargets ?? []).length > 0;
}

function isStandaloneSectionHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (/^#{1,6}\s+/.test(trimmed)) {
    return true;
  }

  return /^[^\[\]<>|]+[：:]\s*$/.test(trimmed);
}

function isCompactSectionContentLine(line: string): boolean {
  return /^\s*(?![-*+]\s+)(?!#{1,6}\s+)[^\[\]<>|：:\r\n]{2,24}[：:]\s*\S/u.test(line);
}

function collectBlockForLabel(
  sourceText: string,
  label: string,
  allLabels: string[],
  matchReason: "label" | "alias",
  priority: number,
  currentFieldLabels: string[] = [label],
  truncateLabels: string[] = allLabels,
  trimFrontmatterPlaceholderValue = false
): LabelBlockMatch | null {
  const block = collectBestLabelBlock(sourceText, {
    labels: [label],
    startOptions: { allowTightLabel: true },
    shouldStopLine: ({ initialMatch, nextLine }) => {
      if (initialMatch.value.length > 0 && nextLine.trim().length === 0) {
        return true;
      }

      if (isStandaloneSectionHeadingLine(nextLine)) {
        return true;
      }

      if (trimFrontmatterPlaceholderValue && initialMatch.value.length > 0 && isCompactSectionContentLine(nextLine)) {
        return true;
      }

      return hasStructuralLabelStart(
        nextLine,
        allLabels.filter((knownLabel) => knownLabel !== label),
        { allowTightLabel: true }
      );
    },
    mapValue: (rawValue, currentLabel, initialMatch) => {
      const compactHeadingTrimmedValue = initialMatch.value.length > 0
        ? truncateAtLooseCompactHeading(rawValue)
        : rawValue;
      const truncatedValue = trimFrontmatterPlaceholderValue
        ? truncateFrontmatterShortValueAtNextKnownLabel(compactHeadingTrimmedValue, truncateLabels, currentFieldLabels)
        : truncateFieldValueAtNextKnownLabel(compactHeadingTrimmedValue, truncateLabels, currentFieldLabels);
      return normalizeInlineLabelValue(truncatedValue);
    }
  });

  if (!block) {
    return null;
  }
  return {
    ...block,
    label,
    matchReason,
    priority
  };
}

function truncateAtLooseCompactHeading(value: string): string {
  const match = value.match(/[。.!！?？]\s*[^：:\r\n]{2,24}[：:]/u);
  if (!match?.index) {
    return value;
  }

  return value.slice(0, match.index);
}

export function collectBestSourceLabelMatch(
  sourceText: string,
  candidateLabels: string[],
  allLabels: string[]
): SourceLabelMatch | null {
  const seenLabels = new Set<string>();
  const bestLabelMatch = candidateLabels
    .map((label, priority) => ({
      label: label.trim(),
      priority
    }))
    .filter((candidate) => {
      if (!candidate.label) {
        return false;
      }

      if (seenLabels.has(candidate.label)) {
        return false;
      }

      seenLabels.add(candidate.label);
      return true;
    })
    .map((candidate) =>
      collectBlockForLabel(
        sourceText,
        candidate.label,
        allLabels,
        "alias",
        candidate.priority,
        [candidate.label],
        allLabels
      )
    )
    .filter((candidate): candidate is LabelBlockMatch => Boolean(candidate))
    .sort(compareLabelMatches)[0];

  if (!bestLabelMatch) {
    return null;
  }

  return {
    value: bestLabelMatch.value,
    label: bestLabelMatch.label
  };
}

function findPatternMatch(sourceText: string, label: string, allLabels: string[]): string {
  const escapedLabel = escapeRegExp(label);
  const assignmentPattern = /\p{Script=Han}/u.test(label)
    ? `(?:是|为|我给|大概|约|[=:：])`
    : `(?:是|为|我给|大概|约|[=:：])?`;
  const patterns = [
    new RegExp(`我的\\s*${escapedLabel}\\s*是\\s*[：:]?\\s*([^\\r\\n]+)`, "i"),
    new RegExp(`(^|[\\s，,。；;、])${escapedLabel}\\s*${assignmentPattern}\\s*([^\\r\\n]+)`, "i"),
    new RegExp(`关于\\s*${escapedLabel}\\s*[，,:：]\\s*([^\\r\\n]+)`, "i")
  ];

  for (const pattern of patterns) {
    const match = sourceText.match(pattern);
    const rawValue = (match?.[2] ?? match?.[1])?.trim();
    const value = rawValue ? truncateFieldValueAtNextKnownLabel(rawValue, allLabels, label) : "";
    if (value) {
      return value;
    }
  }

  return "";
}

export class FieldMatcher {
  constructor(private readonly fieldNormalizer = new FieldNormalizer()) {}

  matchField(
    sourceText: string,
    field: FieldMatcherInput,
    options: MatchOptions,
    allFields: FieldMatcherCollectionInput = [field]
  ): FieldMatchResult {
    const fieldName = getFieldName(field);
    if (!isMatcherFieldEnabled(field)) {
      return {
        fieldName,
        enabled: false,
        matched: false,
        candidateValue: "",
        finalValue: "",
        edited: false,
        matchReason: "unmatched"
      };
    }

    const currentFields = resolveMatcherFields(allFields).filter(isMatcherFieldEnabled);
    const allLabels = Array.from(
      new Set(
        currentFields.flatMap((item) =>
          options.enableAliasMatching
            ? expandLabelVariants([getFieldName(item), ...getFieldAliases(item), ...getFieldSemanticTriggers(item)])
            : expandLabelVariants([getFieldName(item)])
        )
      )
    ).sort((left, right) => right.length - left.length);
    const structuralBoundaryLabels = resolveStructuralBoundaryLabels(allFields);
    const boundaryLabels = Array.from(
      new Set(
        [
          ...currentFields.flatMap((item) =>
            options.enableAliasMatching
              ? expandLabelVariants([getFieldName(item), ...getFieldAliases(item)])
              : expandLabelVariants([getFieldName(item)])
          ),
          ...structuralBoundaryLabels
        ]
      )
    ).sort((left, right) => right.length - left.length);
    const normalizedSourceText = options.sourceTextAlreadyNormalized
      ? sourceText
      : normalizeCompactSourceLabelFlow(sourceText, boundaryLabels, boundaryLabels, []);

    const labelCandidates: Array<{
      label: string;
      matchReason: "label" | "alias";
      priority: number;
    }> = [
      {
        label: fieldName,
        matchReason: "label",
        priority: 0
      }
    ];

    if (options.enableAliasMatching) {
      expandLabelVariants([...getFieldAliases(field), ...getFieldSemanticTriggers(field)]).forEach((alias, index) => {
        labelCandidates.push({
          label: alias,
          matchReason: "alias",
          priority: index + 1
        });
      });
    }

    const seenLabels = new Set<string>();
    const bestLabelMatch = labelCandidates
      .map((candidate) => ({
        ...candidate,
        normalizedLabel: candidate.label.trim()
      }))
      .filter((candidate) => {
        if (!candidate.normalizedLabel) {
          return false;
        }

        if (seenLabels.has(candidate.normalizedLabel)) {
          return false;
        }

        seenLabels.add(candidate.normalizedLabel);
        return true;
      })
      .map((candidate) =>
        collectBlockForLabel(
          normalizedSourceText,
          candidate.normalizedLabel,
          allLabels,
          candidate.matchReason,
          candidate.priority,
          [candidate.normalizedLabel],
          boundaryLabels,
          hasFrontmatterPlaceholderTarget(field)
        )
      )
      .filter((candidate): candidate is LabelBlockMatch => Boolean(candidate))
      .sort(compareLabelMatches)[0];

    if (bestLabelMatch) {
      const normalizedValue = this.fieldNormalizer.normalize(field, bestLabelMatch.value);
      return {
        fieldName,
        enabled: field.enabledByDefault,
        matched: true,
        candidateValue: bestLabelMatch.value,
        finalValue: normalizedValue,
        edited: false,
        matchReason: bestLabelMatch.matchReason,
        matchedLabel: bestLabelMatch.label
      };
    }

    const patternLabels = options.enableAliasMatching
      ? expandLabelVariants([fieldName, ...getFieldAliases(field), ...getFieldSemanticTriggers(field)])
      : expandLabelVariants([fieldName]);
    const matchedPattern = patternLabels
      .map((label) => ({
        label,
        value: findPatternMatch(normalizedSourceText, label, allLabels)
      }))
      .find((match) => match.value.length > 0);
    const patternValue = matchedPattern?.value ?? "";
    if (patternValue) {
      const normalizedValue = this.fieldNormalizer.normalize(field, patternValue);
      return {
        fieldName,
        enabled: field.enabledByDefault,
        matched: true,
        candidateValue: patternValue,
        finalValue: normalizedValue,
        edited: false,
        matchReason: "pattern",
        matchedLabel: matchedPattern?.label ?? fieldName
      };
    }

    const inferredValue = this.fieldNormalizer.inferNormalizedValue(field, sourceText);
    if (inferredValue) {
      return {
        fieldName,
        enabled: field.enabledByDefault,
        matched: true,
        candidateValue: inferredValue,
        finalValue: inferredValue,
        edited: false,
        matchReason: "pattern"
      };
    }

    if (isBooleanLikeMatcherField(field)) {
      return {
        fieldName,
        enabled: field.enabledByDefault,
        matched: true,
        candidateValue: "",
        finalValue: "no",
        edited: false,
        matchReason: "pattern"
      };
    }

    return {
      fieldName,
      enabled: options.unmatchedFieldsStartEnabled,
      matched: false,
      candidateValue: "",
      finalValue: "",
      edited: false,
      matchReason: "unmatched"
    };
  }

  match(
    sourceText: string,
    fields: FieldMatcherCollectionInput,
    options: MatchOptions,
    allFields: FieldMatcherCollectionInput = fields
  ): FieldMatchResult[] {
    const currentFields = resolveMatcherFields(fields).filter(isMatcherFieldEnabled);
    return currentFields.map((field) => this.matchField(sourceText, field, options, allFields));
  }
}
