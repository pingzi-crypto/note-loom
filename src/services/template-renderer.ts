import type { FieldMatchResult } from "../types/match";
import type { ConceptFieldConfig, TemplateFieldConfig, TemplateSemanticConfig } from "../types/template";
import type { TemplateStructureDescriptor } from "../types/template-structure-descriptor";
import {
  resolveTemplateFieldContextFields,
  type TemplateFieldContext
} from "./template-field-state-service";
import { templateStructureDescriptorFieldsToConfigs } from "./template-structure-descriptor-service";
import type { FrontmatterValue } from "../utils/frontmatter";
import { createDataviewInlineFieldRegex } from "../utils/dataview-inline-field";
import { mergeFrontmatter, resolveExistingFrontmatterKey } from "../utils/frontmatter";
import {
  NOTE_LOOM_CREATED_BY,
  SOURCE_METADATA_FRONTMATTER_FIELDS,
} from "../utils/generation-protocol";
import { replaceAllPlaceholders } from "../utils/placeholder";

export interface RenderMetadata {
  sourceTemplateName: string;
  writeSourceMetadata: boolean;
  sourceNotePath?: string;
}

export interface TemplateSectionOverride {
  title: string;
  content: string;
  mode?: "append" | "replace";
}

interface CheckboxSelection {
  selected: Set<string>;
  otherText: string;
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

function buildEnabledValueMap(fieldResults: FieldMatchResult[]): Map<string, string> {
  return new Map(
    fieldResults.map((field) => [field.fieldName, field.enabled ? field.finalValue : ""] as const)
  );
}

function buildEnabledFieldNameSet(fieldResults: FieldMatchResult[]): Set<string> {
  return new Set(
    fieldResults
      .filter((field) => field.enabled)
      .map((field) => field.fieldName)
  );
}

function findFirstEnabledValue(
  candidates: string[],
  enabledValues: Map<string, string>
): string {
  for (const candidate of candidates) {
    const value = enabledValues.get(candidate)?.trim() ?? "";
    if (value) {
      return value;
    }
  }

  return "";
}

function replaceTemplaterDateTextFields(
  content: string,
  enabledValues: Map<string, string>
): string {
  const dateValue = findFirstEnabledValue(["日期", "record_date", "date"], enabledValues);
  if (!dateValue) {
    return content;
  }

  return content.replace(
    /^(\s*[-*+]\s+日期\s*[：:]\s*)`?<%\s*tp\.date\.now\("YYYY-MM-DD"\)\s*%>`?/gmu,
    `$1${dateValue}`
  );
}

function isFieldExplicitlyDisabled(
  fieldName: string,
  enabledFieldNames: Set<string>,
  fieldResultMap: Map<string, FieldMatchResult>
): boolean {
  return fieldResultMap.has(fieldName) && !enabledFieldNames.has(fieldName);
}

function buildFieldConfigMap(fieldConfigs: TemplateFieldConfig[]): Map<string, TemplateFieldConfig> {
  return new Map(fieldConfigs.map((field) => [field.name, field] as const));
}

function normalizeCompareValue(value: string): string {
  return value.replace(/\s+/g, "").replace(/[：:，,。.;；、|｜/\\\-—–~·]/g, "").trim();
}

function resolveFixedOptionValue(value: string, options: string[]): string {
  const normalizedValue = normalizeCompareValue(value);
  if (!normalizedValue) {
    return "";
  }

  return options
    .slice()
    .sort((left, right) => normalizeCompareValue(right).length - normalizeCompareValue(left).length)
    .find((option) => {
      const normalizedOption = normalizeCompareValue(option.replace(/：$/, ""));
      return normalizedOption && (
        normalizedValue === normalizedOption ||
        normalizedValue.includes(normalizedOption)
      );
    }) ?? "";
}

function findSemanticConceptForCheckboxField(
  fieldName: string,
  semanticConfig: TemplateSemanticConfig | undefined
): ConceptFieldConfig | null {
  if (!semanticConfig) {
    return null;
  }

  return (
    semanticConfig.conceptFields.find((concept) =>
      concept.renderTargets.some(
        (target) => target.fieldName === fieldName && target.kind === "checkbox_group"
      )
    ) ?? null
  );
}

function mapSemanticValueToCheckboxOptions(
  concept: ConceptFieldConfig,
  value: string
): string[] {
  const normalized = normalizeCompareValue(value);
  if (!normalized) {
    return [];
  }

  return concept.enumOptions
    .filter((option) =>
      [option.label, option.normalizedValue]
        .map((candidate) => normalizeCompareValue(candidate))
        .includes(normalized)
    )
    .map((option) => option.label);
}

function resolveCheckboxSelectionFromSemanticConfig(
  fieldName: string,
  options: string[],
  enabledValues: Map<string, string>,
  enabledFieldNames: Set<string>,
  fieldResultMap: Map<string, FieldMatchResult>,
  semanticConfig: TemplateSemanticConfig | undefined
): CheckboxSelection | null {
  if (isFieldExplicitlyDisabled(fieldName, enabledFieldNames, fieldResultMap)) {
    return {
      selected: new Set<string>(),
      otherText: ""
    };
  }

  const concept = findSemanticConceptForCheckboxField(fieldName, semanticConfig);
  if (!concept) {
    return null;
  }

  const selected = new Set<string>();
  const otherOption = options.find((option) => option.startsWith("其他"));
  let otherText = "";

  concept.renderTargets.forEach((target) => {
    const source = enabledValues.get(target.fieldName) ?? "";
    if (!source.trim()) {
      return;
    }

    mapSemanticValueToCheckboxOptions(concept, source).forEach((option) => selected.add(option));

    const normalizedSource = normalizeCompareValue(source);
    options
      .slice()
      .sort(
        (left, right) =>
          normalizeCompareValue(right.replace(/：$/, "")).length -
          normalizeCompareValue(left.replace(/：$/, "")).length
      )
      .forEach((option) => {
        const normalizedOption = normalizeCompareValue(option.replace(/：$/, ""));
        const conflictsWithLongerMatch = Array.from(selected).some((existing) =>
          normalizeCompareValue(existing.replace(/：$/, "")).includes(normalizedOption)
        );
        if (normalizedOption && normalizedSource.includes(normalizedOption) && !conflictsWithLongerMatch) {
          selected.add(option);
        }
      });

    if (otherOption) {
      const explicitOther = source.match(/^其他[：:]\s*(.+)$/);
      if (explicitOther?.[1]?.trim()) {
        selected.add(otherOption);
        otherText = explicitOther[1].trim();
      }
    }
  });

  if (otherOption && selected.size === 0) {
    const fallbackSource = concept.renderTargets
      .map((target) => enabledValues.get(target.fieldName) ?? "")
      .find((value) => value.trim().length > 0);
    if (fallbackSource) {
      selected.add(otherOption);
      otherText = fallbackSource;
    }
  }

  return {
    selected,
    otherText
  };
}

function replaceInlineFields(
  content: string,
  enabledValues: Map<string, string>,
  fieldConfigs: TemplateFieldConfig[]
): string {
  const fieldConfigMap = buildFieldConfigMap(fieldConfigs);
  const inlineFieldNames = new Set(
    fieldConfigs.filter((field) => field.kind === "inline_field").map((field) => field.name)
  );

  return content.replace(createDataviewInlineFieldRegex("gu"), (match, fieldName: string, rawValue: string) => {
    const shouldRender =
      inlineFieldNames.size > 0 ? inlineFieldNames.has(fieldName) : enabledValues.has(fieldName);
    if (!shouldRender) {
      return match;
    }

    const value = enabledValues.get(fieldName) ?? "";
    const fieldConfig = fieldConfigMap.get(fieldName);
    const fixedOptions = fieldConfig?.checkboxOptions ?? [];
    if (fixedOptions.length > 0 && rawValue.trim()) {
      const fixedOptionValue = resolveFixedOptionValue(value, fixedOptions);
      if (!fixedOptionValue) {
        return match;
      }

      return `[${fieldName}:: ${fixedOptionValue}]`;
    }

    if (!value.trim() && /<%[\s\S]*?%>/.test(rawValue)) {
      return match;
    }

    return `[${fieldName}:: ${value}]`;
  });
}

function resolveCheckboxSelection(
  fieldName: string,
  options: string[],
  enabledValues: Map<string, string>,
  enabledFieldNames: Set<string>,
  fieldResultMap: Map<string, FieldMatchResult>,
  semanticConfig?: TemplateSemanticConfig
): CheckboxSelection {
  const semanticSelection = resolveCheckboxSelectionFromSemanticConfig(
    fieldName,
    options,
    enabledValues,
    enabledFieldNames,
    fieldResultMap,
    semanticConfig
  );
  if (semanticSelection) {
    return semanticSelection;
  }

  if (isFieldExplicitlyDisabled(fieldName, enabledFieldNames, fieldResultMap)) {
    return {
      selected: new Set<string>(),
      otherText: ""
    };
  }

  const directValue = enabledValues.get(fieldName) ?? "";
  const selected = new Set<string>();
  const compareSources = [directValue].filter((value) => value.trim().length > 0);
  const otherOption = options.find((option) => option.startsWith("其他"));
  let otherText = "";

  compareSources.forEach((source) => {
    const normalizedSource = normalizeCompareValue(source);
    options
      .slice()
      .sort(
        (left, right) =>
          normalizeCompareValue(right.replace(/：$/, "")).length -
          normalizeCompareValue(left.replace(/：$/, "")).length
      )
      .forEach((option) => {
        const normalizedOption = normalizeCompareValue(option.replace(/：$/, ""));
        const conflictsWithLongerMatch = Array.from(selected).some((existing) =>
          normalizeCompareValue(existing.replace(/：$/, "")).includes(normalizedOption)
        );
        if (normalizedOption && normalizedSource.includes(normalizedOption) && !conflictsWithLongerMatch) {
          selected.add(option);
        }
      });

    if (otherOption) {
      const explicitOther = source.match(/^其他[：:]\s*(.+)$/);
      if (explicitOther?.[1]?.trim()) {
        selected.add(otherOption);
        otherText = explicitOther[1].trim();
      }
    }
  });

  if (otherOption && compareSources.length > 0 && selected.size === 0) {
    selected.add(otherOption);
    otherText = compareSources[0] ?? "";
  }

  return {
    selected,
    otherText
  };
}

function collectCheckboxBlock(
  lines: string[],
  startIndex: number
): { spacerLines: string[]; checkboxLines: string[]; endIndex: number } | null {
  const spacerLines: string[] = [];
  let cursor = startIndex + 1;

  while (cursor < lines.length && (lines[cursor] ?? "").trim().length === 0) {
    spacerLines.push(lines[cursor] ?? "");
    cursor += 1;
  }

  const checkboxLines: string[] = [];
  while (cursor < lines.length && /^\s*-\s+\[[ xX]\]\s+/.test(lines[cursor] ?? "")) {
    checkboxLines.push(lines[cursor] ?? "");
    cursor += 1;
  }

  if (checkboxLines.length === 0) {
    return null;
  }

  return {
    spacerLines,
    checkboxLines,
    endIndex: cursor - 1
  };
}

function formatTextFieldLines(
  indent: string,
  bulletPrefix: string,
  label: string,
  separator: string,
  value: string
): string[] {
  if (!value.trim()) {
    return [`${indent}${bulletPrefix}${label}${separator}`];
  }

  const valueLines = value.split(/\r?\n/);
  if (!bulletPrefix) {
    return [`${indent}${label}${separator}`, ...valueLines.map((line) => `${indent}${line}`)];
  }

  if (valueLines.length === 1) {
    return [`${indent}${bulletPrefix}${label}${separator}${valueLines[0]}`];
  }

  const continuationIndent = bulletPrefix ? `${indent}  ` : indent;
  return [
    `${indent}${bulletPrefix}${label}${separator}`,
    ...valueLines.map((line) => `${continuationIndent}${line}`)
  ];
}

function renderStructuredFields(
  content: string,
  enabledValues: Map<string, string>,
  enabledFieldNames: Set<string>,
  fieldResultMap: Map<string, FieldMatchResult>,
  fieldConfigs: TemplateFieldConfig[],
  semanticConfig?: TemplateSemanticConfig
): string {
  const configByName = buildFieldConfigMap(fieldConfigs);
  const lines = content.split(/\r?\n/);
  const renderedLines: string[] = [];
  let frontmatterState: "unknown" | "inside" | "done" = "unknown";

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index] ?? "";

    if (frontmatterState === "unknown") {
      if (currentLine.trim() === "---") {
        frontmatterState = "inside";
        renderedLines.push(currentLine);
        continue;
      }
      if (currentLine.trim().length > 0) {
        frontmatterState = "done";
      }
    } else if (frontmatterState === "inside") {
      renderedLines.push(currentLine);
      if (currentLine.trim() === "---") {
        frontmatterState = "done";
      }
      continue;
    }

    const labelMatch = currentLine.match(/^(\s*)(-\s+)?(.+?)([：:])\s*(.*)$/);

    if (!labelMatch) {
      renderedLines.push(currentLine);
      continue;
    }

    const indent = labelMatch[1] ?? "";
    const bulletPrefix = labelMatch[2] ?? "";
    const fieldName = labelMatch[3]?.trim() ?? "";
    const separator = labelMatch[4] ?? "：";
    const trailingValue = labelMatch[5] ?? "";
    const fieldConfig = configByName.get(fieldName);

    if (!fieldConfig) {
      renderedLines.push(currentLine);
      continue;
    }

    if (fieldConfig.kind === "checkbox_group") {
      const block = collectCheckboxBlock(lines, index);
      if (!block) {
        renderedLines.push(currentLine);
        continue;
      }

      const selection = resolveCheckboxSelection(
        fieldName,
        fieldConfig.checkboxOptions ?? [],
        enabledValues,
        enabledFieldNames,
        fieldResultMap,
        semanticConfig
      );
      renderedLines.push(`${indent}${bulletPrefix}${fieldName}${separator}`);
      renderedLines.push(...block.spacerLines);
      block.checkboxLines.forEach((checkboxLine) => {
        const checkboxMatch = checkboxLine.match(/^(\s*-\s+)\[[ xX]\]\s+(.+?)\s*$/);
        if (!checkboxMatch) {
          renderedLines.push(checkboxLine);
          return;
        }

        const prefix = checkboxMatch[1] ?? "- ";
        const optionLabel = checkboxMatch[2]?.trim() ?? "";
        const checked = selection.selected.has(optionLabel);
        const renderedOption =
          optionLabel.startsWith("其他") && checked && selection.otherText
            ? `${optionLabel}${selection.otherText}`
            : optionLabel;
        renderedLines.push(`${prefix}[${checked ? "x" : " "}] ${renderedOption}`);
      });
      index = block.endIndex;
      continue;
    }

    if (fieldConfig.kind === "text") {
      const fieldValue = enabledValues.get(fieldName);
      if (!fieldValue?.trim() && /<%[\s\S]*?%>/.test(trailingValue)) {
        renderedLines.push(currentLine);
        continue;
      }

      renderedLines.push(
        ...formatTextFieldLines(indent, bulletPrefix, fieldName, separator, fieldValue ?? "")
      );

      let nextIndex = index + 1;
      while (nextIndex < lines.length && (lines[nextIndex] ?? "").trim().length === 0) {
        nextIndex += 1;
      }
      if (nextIndex < lines.length && /^\s*-\s*$/.test(lines[nextIndex] ?? "")) {
        index = nextIndex;
      }
      continue;
    }

    renderedLines.push(currentLine);
  }

  return renderedLines.join("\n");
}

function sanitizeFrontmatterPlaceholderValue(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function replaceTemplatePlaceholders(content: string, values: Record<string, string>): string {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatterMatch) {
    return replaceAllPlaceholders(content, values);
  }

  const frontmatterBlock = frontmatterMatch[0] ?? "";
  const body = content.slice(frontmatterBlock.length);
  const frontmatterValues = Object.fromEntries(
    Object.entries(values).map(([fieldName, value]) => [
      fieldName,
      sanitizeFrontmatterPlaceholderValue(value)
    ])
  );

  return `${replaceAllPlaceholders(frontmatterBlock, frontmatterValues)}${replaceAllPlaceholders(body, values)}`;
}

function applySectionOverrides(
  content: string,
  sectionOverrides: TemplateSectionOverride[]
): string {
  const effectiveOverrides = new Map(
    sectionOverrides
      .map((override) => [
        override.title.trim(),
        {
          ...override,
          content: override.content.trimEnd(),
          mode: override.mode ?? "append"
        }
      ] as const)
      .filter(([title, override]) => title.length > 0 && override.content.length > 0)
  );
  if (effectiveOverrides.size === 0) {
    return content;
  }

  const lines = content.split(/\r?\n/);
  const renderedLines: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const headingLine = lines[index] ?? "";
    const headingMatch = headingLine.match(/^(#{1,6})\s+(.+)$/);
    if (!headingMatch) {
      renderedLines.push(headingLine);
      index += 1;
      continue;
    }

    const headingLevel = headingMatch[1]?.length ?? 1;
    const title = headingMatch[2]?.trim() ?? "";
    const override = effectiveOverrides.get(title);

    renderedLines.push(headingLine);

    if (!override) {
      index += 1;
      continue;
    }

    let endIndex = index + 1;
    while (endIndex < lines.length) {
      const line = lines[endIndex] ?? "";
      const nextHeadingMatch = line.match(/^(#{1,6})\s+.+$/);
      if (nextHeadingMatch && (nextHeadingMatch[1]?.length ?? 1) <= headingLevel) {
        break;
      }

      if (isMarkdownThematicBreak(line)) {
        break;
      }

      endIndex += 1;
    }

    const bodyLines = lines.slice(index + 1, endIndex);

    if (override.mode === "replace") {
      if ((bodyLines[0] ?? "").trim().length === 0 && override.content.trimStart() === override.content) {
        renderedLines.push("");
      }
      renderedLines.push(...override.content.split(/\r?\n/));
      if (endIndex < lines.length) {
        renderedLines.push("");
      }
      index = endIndex;
      continue;
    }

    const preservedBody = [...bodyLines];
    while (preservedBody.length > 0 && preservedBody[preservedBody.length - 1]?.trim().length === 0) {
      preservedBody.pop();
    }
    renderedLines.push(...preservedBody);
    if (preservedBody.length > 0) {
      renderedLines.push("");
    }
    renderedLines.push(...override.content.split(/\r?\n/));

    if (endIndex < lines.length) {
      renderedLines.push("");
    }

    index = endIndex;
  }

  return renderedLines.join("\n");
}

export class TemplateRenderer {
  render(
    templateContent: string,
    fieldResults: FieldMatchResult[],
    metadata: RenderMetadata,
    fieldConfigs: TemplateFieldContext | TemplateFieldConfig[] = [],
    semanticConfig?: TemplateSemanticConfig,
    sectionOverrides: TemplateSectionOverride[] = [],
    frontmatterOverrides: Record<string, FrontmatterValue> = {},
    structureDescriptor?: TemplateStructureDescriptor
  ): string {
    const currentFieldConfigs = structureDescriptor
      ? templateStructureDescriptorFieldsToConfigs(structureDescriptor)
      : resolveTemplateFieldContextFields(fieldConfigs);
    const enabledValues = buildEnabledValueMap(fieldResults);
    const enabledFieldNames = buildEnabledFieldNameSet(fieldResults);
    const fieldResultMap = new Map(fieldResults.map((field) => [field.fieldName, field] as const));
    const rendered = applySectionOverrides(
      renderStructuredFields(
        replaceInlineFields(
          replaceTemplaterDateTextFields(
            replaceTemplatePlaceholders(templateContent, Object.fromEntries(enabledValues)),
            enabledValues
          ),
          enabledValues,
          currentFieldConfigs
        ),
        enabledValues,
        enabledFieldNames,
        fieldResultMap,
        currentFieldConfigs,
        semanticConfig
      ),
      sectionOverrides
    );

    const metadataFrontmatter: Record<string, FrontmatterValue> = metadata.writeSourceMetadata
      ? {
          ...(metadata.sourceNotePath
            ? {
                [resolveExistingFrontmatterKey(
                  rendered,
                  SOURCE_METADATA_FRONTMATTER_FIELDS.sourceNote.aliases,
                  SOURCE_METADATA_FRONTMATTER_FIELDS.sourceNote.canonical
                )]: `[[${metadata.sourceNotePath.replace(/\.md$/i, "")}]]`
              }
            : {}),
          [resolveExistingFrontmatterKey(
            rendered,
            SOURCE_METADATA_FRONTMATTER_FIELDS.sourceTemplate.aliases,
            SOURCE_METADATA_FRONTMATTER_FIELDS.sourceTemplate.canonical
          )]: metadata.sourceTemplateName,
          [resolveExistingFrontmatterKey(
            rendered,
            SOURCE_METADATA_FRONTMATTER_FIELDS.createdBy.aliases,
            SOURCE_METADATA_FRONTMATTER_FIELDS.createdBy.canonical
          )]: NOTE_LOOM_CREATED_BY
        }
      : {};

    return mergeFrontmatter(rendered, {
      ...metadataFrontmatter,
      ...frontmatterOverrides
    });
  }
}
