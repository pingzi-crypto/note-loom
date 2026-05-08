import type {
  BuiltInTemplateRulePack,
  TemplateConfig,
  TemplateRulePackConfig
} from "../types/template";
import {
  createSectionRulePackKey,
  listBuiltInRulePacks
} from "./template-rule-pack-service";

export interface TemplateRulePackMigrationPayload {
  kind: typeof NOTE_LOOM_RULE_PACK_MIGRATION_KIND;
  version: 1;
  exportedAt: string;
  templateName: string;
  templatePath: string;
  rulePackConfig?: TemplateRulePackConfig;
}

export const NOTE_LOOM_RULE_PACK_MIGRATION_KIND = "note-loom.rule-pack-migration";
export const LEGACY_TEMPLATE_EXTRACTOR_RULE_PACK_MIGRATION_KIND = "template-extractor.rule-pack-migration";

const SUPPORTED_RULE_PACK_MIGRATION_KINDS = new Set<string>([
  NOTE_LOOM_RULE_PACK_MIGRATION_KIND,
  LEGACY_TEMPLATE_EXTRACTOR_RULE_PACK_MIGRATION_KIND
]);

export interface TemplateRulePackUsageSummary {
  packId: string;
  label: string;
  kind: BuiltInTemplateRulePack["kind"];
  enabledByDefault: boolean;
  matchedEntries: string[];
}

export interface TemplateRulePackMigrationSummary {
  matchedBuiltInPacks: TemplateRulePackUsageSummary[];
  overrideCounts: {
    enabledPackIds: number;
    disabledPackIds: number;
    fieldAliasOverrides: number;
    fieldOptionOverrides: number;
    sectionEnrichOverrides: number;
    repeatableParserRouteOverrides: number;
    sectionBehaviorOrderOverrides: number;
    sectionStructureOverrides: number;
  };
  hasGlobalSectionBehaviorOrder: boolean;
  hasGlobalSectionStructureToggles: boolean;
}

function cloneRulePackConfig(config: TemplateRulePackConfig | undefined): TemplateRulePackConfig | undefined {
  return config ? (JSON.parse(JSON.stringify(config)) as TemplateRulePackConfig) : undefined;
}

function normalizeCompareKey(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[_\-\s]/g, "")
    .replace(/[：:，,。.;；、|｜/\\\-—–~·`'"“”‘’()[\]{}]/g, "");
}

function countValues(values: unknown[] | undefined): number {
  return Array.isArray(values) ? values.length : 0;
}

function summarizeFieldPackUsage(
  pack: Extract<BuiltInTemplateRulePack, { kind: "field_alias" | "field_options" }>,
  template: TemplateConfig
): string[] {
  const fieldKeys = new Set(template.fields.map((field) => normalizeCompareKey(field.name)));
  return pack.entries
    .filter((entry) => fieldKeys.has(normalizeCompareKey(entry.fieldName)))
    .map((entry) => entry.fieldName);
}

function summarizeSectionPackUsage(
  pack: Extract<BuiltInTemplateRulePack, { kind: "section_enrich" }>,
  template: TemplateConfig
): string[] {
  const sectionKeys = new Set(
    (template.sectionConfig ?? [])
      .map((section) =>
        section.behavior
          ? createSectionRulePackKey(section.behavior.kind, section.title)
          : undefined
      )
      .filter((key): key is string => Boolean(key))
      .map((key) => normalizeCompareKey(key))
  );

  return pack.entries
    .filter((entry) => sectionKeys.has(normalizeCompareKey(entry.sectionKey)))
    .map((entry) => entry.sectionKey);
}

export function summarizeTemplateRulePackMigration(
  template: TemplateConfig
): TemplateRulePackMigrationSummary {
  const matchedBuiltInPacks = listBuiltInRulePacks()
    .map<TemplateRulePackUsageSummary>((pack) => {
      const matchedEntries =
        pack.kind === "section_enrich"
          ? summarizeSectionPackUsage(pack, template)
          : summarizeFieldPackUsage(pack, template);

      return {
        packId: pack.id,
        label: pack.label,
        kind: pack.kind,
        enabledByDefault: pack.enabledByDefault,
        matchedEntries
      };
    })
    .filter((summary) => summary.matchedEntries.length > 0);

  const config = template.rulePackConfig;
  return {
    matchedBuiltInPacks,
    overrideCounts: {
      enabledPackIds: countValues(config?.enabledPackIds),
      disabledPackIds: countValues(config?.disabledPackIds),
      fieldAliasOverrides: countValues(config?.fieldAliasOverrides),
      fieldOptionOverrides: countValues(config?.fieldOptionOverrides),
      sectionEnrichOverrides: countValues(config?.sectionEnrichOverrides),
      repeatableParserRouteOverrides: countValues(config?.repeatableParserRouteOverrides),
      sectionBehaviorOrderOverrides: countValues(config?.sectionBehaviorOrderOverrides),
      sectionStructureOverrides: countValues(config?.sectionStructureOverrides)
    },
    hasGlobalSectionBehaviorOrder: Boolean(config?.sectionBehaviorRuleOrder?.length),
    hasGlobalSectionStructureToggles: Boolean(config?.sectionStructureToggles)
  };
}

export function createTemplateRulePackMigrationPayload(
  template: TemplateConfig,
  now: Date = new Date()
): TemplateRulePackMigrationPayload {
  return {
    kind: NOTE_LOOM_RULE_PACK_MIGRATION_KIND,
    version: 1,
    exportedAt: now.toISOString(),
    templateName: template.name,
    templatePath: template.path,
    rulePackConfig: cloneRulePackConfig(template.rulePackConfig)
  };
}

export function serializeTemplateRulePackMigrationPayload(
  template: TemplateConfig,
  now?: Date
): string {
  return JSON.stringify(createTemplateRulePackMigrationPayload(template, now), null, 2);
}

export function extractRulePackConfigFromMigrationInput(input: unknown): Partial<TemplateRulePackConfig> | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const record = input as {
    kind?: unknown;
    version?: unknown;
    rulePackConfig?: unknown;
  };

  if (typeof record.kind === "string" && SUPPORTED_RULE_PACK_MIGRATION_KINDS.has(record.kind)) {
    return record.version === 1 && record.rulePackConfig && typeof record.rulePackConfig === "object"
      ? (record.rulePackConfig as Partial<TemplateRulePackConfig>)
      : undefined;
  }

  return input as Partial<TemplateRulePackConfig>;
}
