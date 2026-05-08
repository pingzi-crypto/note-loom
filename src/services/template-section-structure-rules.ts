import type {
  TemplateSectionBehaviorConfig,
  TemplateSectionStructureToggles,
  TemplateSectionConfig,
  TemplateSectionOverrideMode,
  TemplateSectionParserId,
  TemplateSectionBoundaryPolicyConfig,
  TemplateRulePackConfig
} from "../types/template";
import { foldMatchingSectionRules } from "./template-section-rule-resolution";
import {
  isRegisteredTemplateSectionParserId,
  resolveRegisteredRepeatableParserRoute,
  resolveTemplateSectionParserDocumentation
} from "./template-section-parser-registry";
import {
  extractRepeatableInlineEntryLabelFromRawContent,
  extractRepeatableInlineEntrySchemasFromRawContent
} from "./repeatable-inline-schema";

interface RepeatableParserRouteResolution {
  parserId: TemplateSectionParserId;
  sourceAliases: string[];
  overrideMode: TemplateSectionOverrideMode;
  boundaryPolicy?: TemplateSectionBoundaryPolicyConfig;
}

export function resolveSectionStructureTogglesForSection(
  section: {
    title: string;
    kind: TemplateSectionConfig["kind"];
  },
  rulePackConfig?: TemplateRulePackConfig
): TemplateSectionStructureToggles | undefined {
  const base = rulePackConfig?.sectionStructureToggles;
  const rules = rulePackConfig?.sectionStructureOverrides ?? [];
  const resolved = foldMatchingSectionRules(
    { title: section.title, kind: section.kind },
    rules,
    {
      futurePlanningIgnore: base?.futurePlanningIgnore,
      futurePlanningSection: base?.futurePlanningSection,
      repeatableParserRoute: base?.repeatableParserRoute
    },
    (accumulator, rule) => ({
      futurePlanningIgnore:
        typeof rule.toggles.futurePlanningIgnore === "boolean"
          ? rule.toggles.futurePlanningIgnore
          : accumulator.futurePlanningIgnore,
      futurePlanningSection:
        typeof rule.toggles.futurePlanningSection === "boolean"
          ? rule.toggles.futurePlanningSection
          : accumulator.futurePlanningSection,
      repeatableParserRoute:
        typeof rule.toggles.repeatableParserRoute === "boolean"
          ? rule.toggles.repeatableParserRoute
          : accumulator.repeatableParserRoute
    })
  );

  if (
    resolved.futurePlanningIgnore === undefined &&
    resolved.futurePlanningSection === undefined &&
    resolved.repeatableParserRoute === undefined
  ) {
    return undefined;
  }

  return resolved;
}

export function inferSectionStructureMode(section: {
  title: string;
  kind: TemplateSectionConfig["kind"];
  fieldNames?: string[];
}, toggles?: TemplateSectionStructureToggles): TemplateSectionConfig["mode"] {
  if (section.kind === "computed_block") {
    return "preserve";
  }

  const futurePlanningIgnore = toggles?.futurePlanningIgnore ?? true;
  if (futurePlanningIgnore && toggles?.futurePlanningSection === true) {
    return "ignore";
  }

  return "generate";
}

export function inferRepeatableEntriesStructureBehavior(section: {
  title: string;
  fieldNames?: string[];
  rawContent?: string;
}, toggles?: TemplateSectionStructureToggles, rulePackConfig?: TemplateRulePackConfig): TemplateSectionBehaviorConfig {
  const repeatableParserRoute = toggles?.repeatableParserRoute ?? true;
  const route = repeatableParserRoute
    ? resolveConfiguredRepeatableParserRoute(section, rulePackConfig) ?? resolveRegisteredRepeatableParserRoute(section)
    : undefined;
  const entryLabel = extractRepeatableInlineEntryLabelFromRawContent(section.rawContent);
  if (route) {
    const entrySchemas = route.parserId === "repeatable_inline_fields"
      ? extractRepeatableInlineEntrySchemasFromRawContent(section.rawContent)
      : undefined;
    return {
      kind: "repeatable_text",
      sourceAliases: route.sourceAliases,
      parserId: route.parserId,
      entryLabel,
      entrySchemas,
      overrideMode: route.overrideMode,
      boundaryPolicy: route.boundaryPolicy
    };
  }

  return {
    kind: "repeatable_text",
    sourceAliases: [],
    entryLabel,
    overrideMode: "append"
  };
}

function resolveConfiguredRepeatableParserRoute(
  section: {
    title: string;
    fieldNames?: string[];
  },
  rulePackConfig?: TemplateRulePackConfig
): RepeatableParserRouteResolution | undefined {
  const rules = rulePackConfig?.repeatableParserRouteOverrides ?? [];
  if (rules.length === 0) {
    return undefined;
  }

  return foldMatchingSectionRules(
    { title: section.title, kind: "repeatable_entries" },
    rules,
    undefined as RepeatableParserRouteResolution | undefined,
    (_accumulator, rule) => {
      if (rule.mode === "disable" || !isRegisteredTemplateSectionParserId(rule.parserId)) {
        return undefined;
      }

      return {
        parserId: rule.parserId,
        sourceAliases: rule.sourceAliases ?? [],
        overrideMode: rule.overrideMode ?? "append",
        boundaryPolicy: resolveTemplateSectionParserDocumentation(rule.parserId)?.boundaryPolicy
      };
    }
  );
}
