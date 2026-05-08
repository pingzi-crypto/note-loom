import type { TemplateSectionConfig } from "../types/template";

export function normalizeSectionHint(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[_\-\s]/g, "")
    .replace(/[：:，,。.;；、|｜/\\\-—–~·]/g, "");
}

export function includesNormalizedHint(value: string, hints: string[]): boolean {
  return hints.some((hint) => hint.length > 0 && value.includes(hint));
}

export const FUTURE_SECTION_TITLE_HINTS = [
  normalizeSectionHint("明日"),
  normalizeSectionHint("明天"),
  normalizeSectionHint("tomorrow"),
  normalizeSectionHint("next day")
];

export const FUTURE_SECTION_PLANNING_HINTS = [
  normalizeSectionHint("校准"),
  normalizeSectionHint("计划"),
  normalizeSectionHint("planning"),
  normalizeSectionHint("plan")
];

export const FUTURE_FIELD_HINTS = [
  normalizeSectionHint("明日"),
  normalizeSectionHint("明天"),
  normalizeSectionHint("tomorrow"),
  normalizeSectionHint("next day"),
  normalizeSectionHint("next"),
  normalizeSectionHint("follow up"),
  normalizeSectionHint("follow-up"),
  normalizeSectionHint("action"),
  normalizeSectionHint("owner"),
  normalizeSectionHint("due"),
  normalizeSectionHint("deadline"),
  normalizeSectionHint("后续"),
  normalizeSectionHint("下一步"),
  normalizeSectionHint("行动"),
  normalizeSectionHint("负责人"),
  normalizeSectionHint("截止")
];

const NEXT_ACTION_SECTION_TITLE_HINTS = [
  normalizeSectionHint("下一步"),
  normalizeSectionHint("后续安排"),
  normalizeSectionHint("后续行动"),
  normalizeSectionHint("next actions"),
  normalizeSectionHint("follow up"),
  normalizeSectionHint("follow-up")
];

const NEXT_ACTION_STRUCTURE_HINTS = [
  normalizeSectionHint("下一步"),
  normalizeSectionHint("后续"),
  normalizeSectionHint("行动"),
  normalizeSectionHint("负责人"),
  normalizeSectionHint("截止"),
  normalizeSectionHint("明日"),
  normalizeSectionHint("下次"),
  normalizeSectionHint("next"),
  normalizeSectionHint("action"),
  normalizeSectionHint("owner"),
  normalizeSectionHint("due"),
  normalizeSectionHint("deadline"),
  normalizeSectionHint("follow up"),
  normalizeSectionHint("follow-up")
];

export function inferDerivedSectionAliases(title: string): string[] {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return [];
  }

  return [];
}

export function scorePresenceFieldCandidate(groupLabel: string, fieldName: string): number {
  const normalizedGroupLabel = normalizeSectionHint(groupLabel);
  const normalizedFieldName = normalizeSectionHint(fieldName);
  if (!normalizedGroupLabel || !normalizedFieldName) {
    return 0;
  }

  if (normalizedGroupLabel === normalizedFieldName) {
    return 100;
  }

  return 0;
}

export function inferPresenceFieldName(groupLabel: string, allTemplateFieldNames: string[]): string | undefined {
  const bestMatch = allTemplateFieldNames
    .map((fieldName) => ({
      fieldName,
      score: scorePresenceFieldCandidate(groupLabel, fieldName)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }

      return left.fieldName.length - right.fieldName.length;
    })[0];

  return bestMatch?.fieldName;
}

export function isFuturePlanningFieldName(fieldName: string): boolean {
  const normalized = normalizeSectionHint(fieldName);
  return FUTURE_FIELD_HINTS.some((hint) => hint.length > 0 && normalized.includes(hint));
}

function countStructuredFutureSignals(fieldNames: string[]): number {
  return fieldNames.filter((fieldName) =>
    NEXT_ACTION_STRUCTURE_HINTS.some((hint) => hint.length > 0 && fieldName.includes(hint))
  ).length;
}

export function isFuturePlanningSection(section: {
  title: string;
  kind: TemplateSectionConfig["kind"];
  fieldNames?: string[];
}): boolean {
  if (section.kind !== "inline_fields" && section.kind !== "repeatable_entries") {
    return false;
  }

  const normalizedTitle = normalizeSectionHint(section.title);
  const normalizedFieldNames = (section.fieldNames ?? [])
    .map((fieldName) => normalizeSectionHint(fieldName))
    .filter((fieldName) => fieldName.length > 0);
  const hasFutureTitleHint = includesNormalizedHint(normalizedTitle, FUTURE_SECTION_TITLE_HINTS);
  const hasPlanningTitleHint = includesNormalizedHint(normalizedTitle, FUTURE_SECTION_PLANNING_HINTS);
  const isTomorrowPlanningSection =
    hasFutureTitleHint &&
    hasPlanningTitleHint &&
    normalizedFieldNames.length > 0 &&
    normalizedFieldNames.every((fieldName) => isFuturePlanningFieldName(fieldName));
  if (isTomorrowPlanningSection) {
    return true;
  }

  const hasNextActionTitleHint = includesNormalizedHint(normalizedTitle, NEXT_ACTION_SECTION_TITLE_HINTS);
  return hasNextActionTitleHint && countStructuredFutureSignals(normalizedFieldNames) >= 2;
}
