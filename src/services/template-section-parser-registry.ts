import type {
  TemplateSectionBoundaryPolicyConfig,
  TemplateSectionBehaviorKind,
  TemplateSectionKind,
  TemplateSectionParserId
} from "../types/template";
import type { SectionStructureDescriptor } from "../types/template-structure-descriptor";
import {
  normalizeSectionHint
} from "./template-section-structure-hints";
import { GenericInlineFieldsParser } from "./generic-inline-fields-parser";
import { RepeatableLinesCleanupParser } from "./repeatable-lines-cleanup-parser";
import { RepeatableInlineFieldsParser } from "./repeatable-inline-fields-parser";

export interface TemplateSectionParserParseResult {
  content: string;
  warnings: string[];
}

export interface TemplateSectionParserRouteContext {
  title: string;
  fieldNames?: string[];
  kind?: TemplateSectionKind;
  rawContent?: string;
}

export interface TemplateSectionParserParseContext {
  fieldNames?: string[];
  entryLabel?: string;
  entrySchemas?: Array<{
    entryLabel?: string;
    fieldNames: string[];
  }>;
  fieldAliases?: Record<string, string[]>;
  boundaryPolicy?: TemplateSectionBoundaryPolicyConfig;
  sectionLabels?: string[];
  stopLabels?: string[];
  shouldStopAtLine?: (line: string) => boolean;
  truncateAtBoundary?: (value: string, currentLabel: string) => string;
}

export interface TemplateSectionRepeatableParserRoute {
  parserId: TemplateSectionParserId;
  sourceAliases: string[];
  overrideMode: "append" | "replace";
  boundaryPolicy?: TemplateSectionBoundaryPolicyConfig;
}

interface TemplateSectionRepeatableParserRouteConfig {
  titleHints?: string[];
  requiredFieldHints?: string[];
  anyFieldHintGroups?: string[][];
  minimumFieldCount?: number;
  requireRepeatableInlineFieldEntryPattern?: boolean;
  sourceAliases: string[];
  overrideMode: "append" | "replace";
}

export interface TemplateSectionParserDescriptor {
  id: TemplateSectionParserId;
  labelKey: string;
  descriptionKey: string;
  applicabilityKey: string;
  riskLevel: "low" | "medium" | "high";
  defaultVisible: boolean;
  behaviorKinds: TemplateSectionBehaviorKind[];
  sectionKinds: TemplateSectionKind[];
  boundaryPolicy: TemplateSectionBoundaryPolicyConfig;
  parse: (content: string, context?: TemplateSectionParserParseContext) => TemplateSectionParserParseResult;
}

interface TemplateSectionParserRegistryEntry extends TemplateSectionParserDescriptor {
  repeatableRoute?: TemplateSectionRepeatableParserRouteConfig;
}

const repeatableInlineFieldsParser = new RepeatableInlineFieldsParser();
const repeatableLinesCleanupParser = new RepeatableLinesCleanupParser();
const genericInlineFieldsParser = new GenericInlineFieldsParser();

const PARSER_REGISTRY: TemplateSectionParserRegistryEntry[] = [
  {
    id: "repeatable_inline_fields",
    labelKey: "section_behavior_parser_repeatable_inline_fields",
    descriptionKey: "section_behavior_parser_repeatable_inline_fields_desc",
    applicabilityKey: "section_behavior_parser_repeatable_inline_fields_applicability",
    riskLevel: "low",
    defaultVisible: true,
    behaviorKinds: ["repeatable_text"],
    sectionKinds: ["repeatable_entries"],
    boundaryPolicy: {
      strictness: "structural",
      allowTightLabels: true,
      allowMarkdownHeadings: true,
      allowInlineFallback: false,
      truncationStrategy: "section-block"
    },
    parse: (content: string, context?: TemplateSectionParserParseContext) =>
      repeatableInlineFieldsParser.parse(content, context),
    repeatableRoute: {
      minimumFieldCount: 2,
      requireRepeatableInlineFieldEntryPattern: true,
      sourceAliases: [],
      overrideMode: "append"
    }
  },
  {
    id: "repeatable_lines_cleanup",
    labelKey: "section_behavior_parser_repeatable_lines_cleanup",
    descriptionKey: "section_behavior_parser_repeatable_lines_cleanup_desc",
    applicabilityKey: "section_behavior_parser_repeatable_lines_cleanup_applicability",
    riskLevel: "low",
    defaultVisible: false,
    behaviorKinds: ["repeatable_text"],
    sectionKinds: ["repeatable_entries"],
    boundaryPolicy: {
      strictness: "loose",
      allowTightLabels: true,
      allowMarkdownHeadings: false,
      allowInlineFallback: true,
      truncationStrategy: "section-block"
    },
    parse: (content: string, context?: TemplateSectionParserParseContext) =>
      repeatableLinesCleanupParser.parse(content, context)
  },
  {
    id: "generic_inline_fields",
    labelKey: "section_behavior_parser_generic_inline_fields",
    descriptionKey: "section_behavior_parser_generic_inline_fields_desc",
    applicabilityKey: "section_behavior_parser_generic_inline_fields_applicability",
    riskLevel: "low",
    defaultVisible: false,
    behaviorKinds: ["repeatable_text"],
    sectionKinds: ["repeatable_entries"],
    boundaryPolicy: {
      strictness: "structural",
      allowTightLabels: true,
      allowMarkdownHeadings: true,
      allowInlineFallback: true,
      truncationStrategy: "section-block"
    },
    parse: (content: string, context?: TemplateSectionParserParseContext) =>
      genericInlineFieldsParser.parse(content, context)
  }
];

const parserRegistryMap = new Map(
  PARSER_REGISTRY.map((entry) => [entry.id, entry] as const)
);

export interface TemplateSectionParserDocumentation {
  id: TemplateSectionParserId;
  labelKey: string;
  descriptionKey: string;
  applicabilityKey: string;
  riskLevel: "low" | "medium" | "high";
  defaultVisible: boolean;
  behaviorKinds: TemplateSectionBehaviorKind[];
  sectionKinds: TemplateSectionKind[];
  boundaryPolicy: TemplateSectionBoundaryPolicyConfig;
}

function toParserDocumentation(entry: TemplateSectionParserRegistryEntry): TemplateSectionParserDocumentation {
  return {
    id: entry.id,
    labelKey: entry.labelKey,
    descriptionKey: entry.descriptionKey,
    applicabilityKey: entry.applicabilityKey,
    riskLevel: entry.riskLevel,
    defaultVisible: entry.defaultVisible,
    behaviorKinds: [...entry.behaviorKinds],
    sectionKinds: [...entry.sectionKinds],
    boundaryPolicy: { ...entry.boundaryPolicy }
  };
}

export function listRegisteredTemplateSectionParsers(): Array<Pick<TemplateSectionParserDocumentation, "id" | "labelKey">> {
  return PARSER_REGISTRY.map((entry) => ({
    id: entry.id,
    labelKey: entry.labelKey
  }));
}

export function listRegisteredTemplateSectionParsersForBehavior(
  behaviorKind: TemplateSectionBehaviorKind,
  options?: {
    includeNonDefaultVisible?: boolean;
    alwaysIncludeParserId?: TemplateSectionParserId;
  }
): Array<Pick<TemplateSectionParserDocumentation, "id" | "labelKey">> {
  const includeNonDefaultVisible = options?.includeNonDefaultVisible ?? false;
  const alwaysIncludeParserId = options?.alwaysIncludeParserId;
  return PARSER_REGISTRY
    .filter((entry) => {
      if (!entry.behaviorKinds.includes(behaviorKind)) {
        return false;
      }

      if (includeNonDefaultVisible || entry.defaultVisible) {
        return true;
      }

      return !!alwaysIncludeParserId && entry.id === alwaysIncludeParserId;
    })
    .map((entry) => ({
      id: entry.id,
      labelKey: entry.labelKey
    }));
}

export function isRegisteredTemplateSectionParserId(value: string | undefined): value is TemplateSectionParserId {
  return typeof value === "string" && parserRegistryMap.has(value as TemplateSectionParserId);
}

export function resolveTemplateSectionParser(
  parserId: TemplateSectionParserId | undefined
): TemplateSectionParserDescriptor | undefined {
  if (!parserId) {
    return undefined;
  }
  return parserRegistryMap.get(parserId);
}

export function resolveTemplateSectionParserDocumentation(
  parserId: TemplateSectionParserId | undefined
): TemplateSectionParserDocumentation | undefined {
  if (!parserId) {
    return undefined;
  }
  const entry = parserRegistryMap.get(parserId);
  return entry ? toParserDocumentation(entry) : undefined;
}

export function isTemplateSectionParserAllowedForBehavior(
  parserId: TemplateSectionParserId | undefined,
  behaviorKind: TemplateSectionBehaviorKind
): boolean {
  const parser = resolveTemplateSectionParser(parserId);
  return !!parser && parser.behaviorKinds.includes(behaviorKind);
}

export function resolveRegisteredRepeatableParserRoute(
  section: TemplateSectionParserRouteContext | SectionStructureDescriptor
): TemplateSectionRepeatableParserRoute | undefined {
  const matched = PARSER_REGISTRY.find(
    (entry) =>
      entry.sectionKinds.includes(section.kind ?? "repeatable_entries") &&
      entry.repeatableRoute &&
      matchesRepeatableRoute(section, entry.repeatableRoute)
  );
  return matched?.repeatableRoute
    ? {
        parserId: matched.id,
        sourceAliases: [...matched.repeatableRoute.sourceAliases],
        overrideMode: matched.repeatableRoute.overrideMode,
        boundaryPolicy: { ...matched.boundaryPolicy }
      }
    : undefined;
}

function normalizeHints(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => normalizeSectionHint(value))
    .filter((value) => value.length > 0);
}

function matchesRepeatableRoute(
  section: TemplateSectionParserRouteContext,
  route: TemplateSectionRepeatableParserRouteConfig
): boolean {
  const normalizedTitle = normalizeSectionHint(section.title);
  const normalizedFieldNames = new Set((section.fieldNames ?? []).map((fieldName) => normalizeSectionHint(fieldName)));
  const titleMatched = normalizeHints(route.titleHints).includes(normalizedTitle);
  const requiredFieldHints = normalizeHints(route.requiredFieldHints);
  const requiredFieldsMatched =
    requiredFieldHints.length > 0 && requiredFieldHints.every((fieldName) => normalizedFieldNames.has(fieldName));
  const anyFieldGroupsMatched = (route.anyFieldHintGroups ?? []).every((group) =>
    normalizeHints(group).some((fieldName) => normalizedFieldNames.has(fieldName))
  );
  const minimumFieldCountMatched =
    typeof route.minimumFieldCount === "number" && normalizedFieldNames.size >= route.minimumFieldCount;
  const repeatableInlineFieldEntryPatternMatched =
    route.requireRepeatableInlineFieldEntryPattern !== true ||
    hasRepeatableInlineFieldEntryPattern(section.rawContent);

  return (
    repeatableInlineFieldEntryPatternMatched &&
    (minimumFieldCountMatched || (requiredFieldsMatched && anyFieldGroupsMatched) || titleMatched)
  );
}

function hasRepeatableInlineFieldEntryPattern(rawContent: string | undefined): boolean {
  return (rawContent ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\s*>\s*/u, "").replace(/^`/u, "").replace(/`$/u, "").trim())
    .some((line) => {
      if (!/^\s*[-*+]\s+/u.test(line)) {
        return false;
      }

      const inlineFieldMatches = line.match(/\[[^\]]+::[^\]]*\]/gu) ?? [];
      return inlineFieldMatches.length >= 2;
    });
}
