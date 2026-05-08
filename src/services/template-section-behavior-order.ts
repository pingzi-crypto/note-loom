import type {
  TemplateRulePackConfig,
  TemplateSectionBehaviorConfig,
  TemplateSectionBehaviorRuleId,
  TemplateSectionConfig
} from "../types/template";
import { foldMatchingSectionRules } from "./template-section-rule-resolution";

export type SectionBehaviorInferenceInput = {
  title: string;
  kind: TemplateSectionConfig["kind"];
  fieldNames?: string[];
  rawContent: string;
  allTemplateFieldNames: string[];
};

export type SectionBehaviorInferers = {
  inferRepeatableEntriesBehavior: (section: {
    title: string;
    fieldNames?: string[];
  }) => TemplateSectionBehaviorConfig;
  inferTableBehavior: (rawContent: string) => TemplateSectionBehaviorConfig | undefined;
  inferMixedFieldBlockBehavior: (rawContent: string) => TemplateSectionBehaviorConfig | undefined;
  inferGroupedBehavior: (
    title: string,
    rawContent: string,
    allTemplateFieldNames: string[]
  ) => TemplateSectionBehaviorConfig | undefined;
  inferFieldBlockBehavior: (title: string, rawContent: string) => TemplateSectionBehaviorConfig | undefined;
  inferTaskListBehavior: (rawContent: string) => TemplateSectionBehaviorConfig | undefined;
};

export const DEFAULT_SECTION_BEHAVIOR_RULE_ORDER = [
  "table",
  "mixed",
  "grouped",
  "field",
  "task"
] as const;

type SectionBehaviorRuleId = (typeof DEFAULT_SECTION_BEHAVIOR_RULE_ORDER)[number];

type SectionBehaviorRule = {
  id: SectionBehaviorRuleId;
  run: (section: SectionBehaviorInferenceInput, inferers: SectionBehaviorInferers) => TemplateSectionBehaviorConfig | undefined;
};

function createSectionBehaviorRules(): SectionBehaviorRule[] {
  return [
    {
      id: "table",
      run: (section, inferers) => inferers.inferTableBehavior(section.rawContent)
    },
    {
      id: "mixed",
      run: (section, inferers) => inferers.inferMixedFieldBlockBehavior(section.rawContent)
    },
    {
      id: "grouped",
      run: (section, inferers) =>
        inferers.inferGroupedBehavior(section.title, section.rawContent, section.allTemplateFieldNames)
    },
    {
      id: "field",
      run: (section, inferers) =>
        section.kind !== "content_block" ? undefined : inferers.inferFieldBlockBehavior(section.title, section.rawContent)
    },
    {
      id: "task",
      run: (section, inferers) =>
        section.kind !== "content_block" ? undefined : inferers.inferTaskListBehavior(section.rawContent)
    }
  ];
}

function resolveRuleOrder(
  rules: SectionBehaviorRule[],
  requestedOrder?: readonly string[]
): SectionBehaviorRule[] {
  if (!requestedOrder || requestedOrder.length === 0) {
    return rules;
  }

  const ruleById = new Map(rules.map((rule) => [rule.id, rule] as const));
  const ordered: SectionBehaviorRule[] = [];
  const visited = new Set<SectionBehaviorRuleId>();

  requestedOrder.forEach((id) => {
    const rule = ruleById.get(id as SectionBehaviorRuleId);
    if (rule && !visited.has(rule.id)) {
      ordered.push(rule);
      visited.add(rule.id);
    }
  });

  rules.forEach((rule) => {
    if (!visited.has(rule.id)) {
      ordered.push(rule);
      visited.add(rule.id);
    }
  });

  return ordered;
}

export function resolveSectionBehaviorRuleOrderForSection(
  section: {
    title: string;
    kind: TemplateSectionConfig["kind"];
  },
  rulePackConfig?: TemplateRulePackConfig
): TemplateSectionBehaviorRuleId[] | undefined {
  const base = rulePackConfig?.sectionBehaviorRuleOrder;
  const rules = rulePackConfig?.sectionBehaviorOrderOverrides ?? [];
  return foldMatchingSectionRules(
    { title: section.title, kind: section.kind },
    rules,
    base && base.length > 0 ? [...base] : undefined,
    (_accumulator, rule) => [...rule.ruleOrder]
  );
}

export function inferSectionBehaviorByOrder(
  section: SectionBehaviorInferenceInput,
  inferers: SectionBehaviorInferers,
  ruleOrder: readonly string[] = DEFAULT_SECTION_BEHAVIOR_RULE_ORDER
): TemplateSectionBehaviorConfig | undefined {
  if (section.kind === "repeatable_entries") {
    return inferers.inferRepeatableEntriesBehavior({
      title: section.title,
      fieldNames: section.fieldNames
    });
  }

  if (section.kind === "computed_block") {
    return undefined;
  }

  const orderedRules = resolveRuleOrder(createSectionBehaviorRules(), ruleOrder);
  for (const rule of orderedRules) {
    const inferred = rule.run(section, inferers);
    if (inferred) {
      return inferred;
    }
  }

  return undefined;
}
