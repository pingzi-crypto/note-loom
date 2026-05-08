import type {
  BuiltInFieldAliasPackEntry,
  BuiltInFieldOptionPackEntry,
  BuiltInSectionEnrichPackEntry,
  BuiltInTemplateRulePack,
  TemplateRulePackConfig,
  TemplateSectionBehaviorKind,
  TemplateSectionEnrichPackFieldPatch,
  TemplateSectionEnrichPackGroupPatch
} from "../types/template";
import { foldRulePackOverrideState } from "./template-rule-pack-fold";

function normalizeCompareKey(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[_\-\s]/g, "")
    .replace(/[：:，,。.;；、|｜/\\\-—–~·`'"“”‘’()[\]{}]/g, "");
}

function mergeUniqueStrings(...groups: Array<string[] | undefined>): string[] | undefined {
  const merged = Array.from(
    new Set(
      groups
        .flatMap((group) => group ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );
  return merged.length > 0 ? merged : undefined;
}

function cloneFieldPatch(patch: TemplateSectionEnrichPackFieldPatch): TemplateSectionEnrichPackFieldPatch {
  return {
    label: patch.label,
    aliases: patch.aliases ? [...patch.aliases] : undefined,
    inputKind: patch.inputKind
  };
}

function cloneGroupPatch(patch: TemplateSectionEnrichPackGroupPatch): TemplateSectionEnrichPackGroupPatch {
  return {
    label: patch.label,
    aliases: patch.aliases ? [...patch.aliases] : undefined,
    presenceFieldName: patch.presenceFieldName
  };
}

export function createSectionRulePackKey(
  behaviorKind: TemplateSectionBehaviorKind,
  title: string
): string {
  return `${behaviorKind}:${normalizeCompareKey(title)}`;
}

export function listBuiltInRulePacks(): BuiltInTemplateRulePack[] {
  return [];
}

export function resolveBuiltInFieldAliasPackEntry(
  fieldName: string,
  config?: TemplateRulePackConfig
): BuiltInFieldAliasPackEntry | undefined {
  const normalizedFieldName = normalizeCompareKey(fieldName);
  const matchingOverrides = (config?.fieldAliasOverrides ?? []).filter(
    (item) => normalizeCompareKey(item.fieldName) === normalizedFieldName
  );

  const resolved = foldRulePackOverrideState(
    matchingOverrides,
    {
      aliases: undefined as string[] | undefined,
      semanticTriggers: undefined as string[] | undefined
    },
    {
      onDisable: () => ({
        aliases: undefined,
        semanticTriggers: undefined
      }),
      onReplace: (_value, override) => ({
        aliases: mergeUniqueStrings(override.aliases),
        semanticTriggers: mergeUniqueStrings(override.semanticTriggers)
      }),
      onMerge: (value, override) => ({
        aliases: mergeUniqueStrings(value.aliases, override.aliases),
        semanticTriggers: mergeUniqueStrings(value.semanticTriggers, override.semanticTriggers)
      })
    }
  );

  if (resolved.disabled) {
    return undefined;
  }

  const aliases = resolved.value.aliases;
  const semanticTriggers = resolved.value.semanticTriggers;

  if (!aliases && !semanticTriggers) {
    return undefined;
  }

  return {
    fieldName,
    aliases,
    semanticTriggers
  };
}

export function resolveBuiltInFieldOptionPackEntry(
  fieldName: string,
  config?: TemplateRulePackConfig
): BuiltInFieldOptionPackEntry | undefined {
  const normalizedFieldName = normalizeCompareKey(fieldName);
  const matchingOverrides = (config?.fieldOptionOverrides ?? []).filter(
    (item) => normalizeCompareKey(item.fieldName) === normalizedFieldName
  );

  const resolved = foldRulePackOverrideState(
    matchingOverrides,
    {
      options: undefined as string[] | undefined,
      fieldKind: undefined as "checkbox_group" | undefined,
      normalizerKey: undefined as string | undefined
    },
    {
      onDisable: (value) => ({
        ...value,
        options: undefined,
        fieldKind: undefined,
        normalizerKey: undefined
      }),
      onReplace: (_value, override) => ({
        options: mergeUniqueStrings(override.options),
        fieldKind: override.fieldKind,
        normalizerKey: override.normalizerKey
      }),
      onMerge: (value, override) => ({
        options: mergeUniqueStrings(value.options, override.options),
        fieldKind: override.fieldKind ?? value.fieldKind,
        normalizerKey: override.normalizerKey ?? value.normalizerKey
      })
    }
  );

  if (resolved.disabled) {
    return undefined;
  }

  const options = resolved.value.options;
  const fieldKind = resolved.value.fieldKind;
  const normalizerKey = resolved.value.normalizerKey;

  if (!options && !fieldKind && !normalizerKey) {
    return undefined;
  }

  return {
    fieldName,
    options,
    fieldKind,
    normalizerKey
  };
}

export function resolveBuiltInSectionEnrichPackEntry(
  sectionTitle: string,
  behaviorKind: TemplateSectionBehaviorKind,
  config?: TemplateRulePackConfig
): BuiltInSectionEnrichPackEntry | undefined {
  const sectionKey = createSectionRulePackKey(behaviorKind, sectionTitle);
  const matchingOverrides = (config?.sectionEnrichOverrides ?? []).filter(
    (entry) =>
      entry.behaviorKind === behaviorKind &&
      normalizeCompareKey(entry.sectionKey) === normalizeCompareKey(sectionKey)
  );

  const resolved = foldRulePackOverrideState(
    matchingOverrides,
    {
      sourceAliases: undefined as string[] | undefined,
      fieldPatches: [] as TemplateSectionEnrichPackFieldPatch[],
      groupPatches: [] as TemplateSectionEnrichPackGroupPatch[]
    },
    {
      onDisable: () => ({
        sourceAliases: undefined,
        fieldPatches: [],
        groupPatches: []
      }),
      onReplace: (_value, override) => ({
        sourceAliases: mergeUniqueStrings(override.sourceAliases),
        fieldPatches: override.fieldPatches?.map((patch) => cloneFieldPatch(patch)) ?? [],
        groupPatches: override.groupPatches?.map((patch) => cloneGroupPatch(patch)) ?? []
      }),
      onMerge: (value, override) => ({
        sourceAliases: mergeUniqueStrings(value.sourceAliases, override.sourceAliases),
        fieldPatches: [
          ...value.fieldPatches,
          ...(override.fieldPatches?.map((patch) => cloneFieldPatch(patch)) ?? [])
        ],
        groupPatches: [
          ...value.groupPatches,
          ...(override.groupPatches?.map((patch) => cloneGroupPatch(patch)) ?? [])
        ]
      })
    }
  );

  if (resolved.disabled) {
    return undefined;
  }

  const sourceAliases = resolved.value.sourceAliases;
  const fieldPatches = resolved.value.fieldPatches;
  const groupPatches = resolved.value.groupPatches;

  if (!sourceAliases && fieldPatches.length === 0 && groupPatches.length === 0) {
    return undefined;
  }

  return {
    sectionKey,
    behaviorKind,
    sourceAliases,
    fieldPatches: fieldPatches.length > 0 ? fieldPatches : undefined,
    groupPatches: groupPatches.length > 0 ? groupPatches : undefined
  };
}
