import { t } from "../i18n";
import type { PluginLanguage } from "../types/settings";
import type { TemplateSectionBehaviorConfig } from "../types/template";

type SectionBehaviorType =
  | "none"
  | "repeatable_text"
  | "task_list"
  | "field_block"
  | "grouped_field_block"
  | "table_block"
  | "mixed_field_block";

export function getSectionBehaviorTypeLabel(
  type: SectionBehaviorType,
  language: PluginLanguage
): string {
  switch (type) {
    case "repeatable_text":
      return t(language, "section_behavior_repeatable_text");
    case "task_list":
      return t(language, "section_behavior_task_list");
    case "field_block":
      return t(language, "section_behavior_field_block");
    case "table_block":
      return t(language, "section_behavior_table_block");
    case "grouped_field_block":
      return t(language, "section_behavior_grouped_field_block");
    case "mixed_field_block":
      return t(language, "section_behavior_mixed_field_block");
    default:
      return t(language, "section_behavior_none");
  }
}

export function summarizeTemplateSectionBehavior(
  behavior: TemplateSectionBehaviorConfig | undefined,
  language: PluginLanguage
): string {
  if (!behavior) {
    return getSectionBehaviorTypeLabel("none", language);
  }

  const typeLabel = getSectionBehaviorTypeLabel(behavior.kind, language);
  switch (behavior.kind) {
    case "repeatable_text":
      return t(language, "section_behavior_summary_repeatable", {
        type: typeLabel
      });
    case "task_list":
      return t(language, "section_behavior_summary_task_list", {
        type: typeLabel
      });
    case "field_block":
      return t(language, "section_behavior_summary_field_block", {
        type: typeLabel,
        count: behavior.fields.length
      });
    case "table_block":
      return t(language, "section_behavior_summary_table_block", {
        type: typeLabel,
        count: behavior.columns.length
      });
    case "grouped_field_block":
      return t(language, "section_behavior_summary_grouped_field_block", {
        type: typeLabel,
        groups: behavior.groups.length,
        fields: behavior.fields.length
      });
    case "mixed_field_block":
      return t(language, "section_behavior_summary_mixed_field_block", {
        type: typeLabel,
        count: behavior.items.length
      });
    default:
      return getSectionBehaviorTypeLabel("none", language);
  }
}
