import type {
  TemplateSectionBehaviorConfig,
  TemplateSectionBehaviorFieldConfig,
  TemplateSectionBehaviorGroupConfig,
  TemplateSectionMixedFieldBlockBehaviorConfig,
  TemplateSectionMixedFieldBlockFieldConfig,
  TemplateSectionMixedFieldBlockItemConfig,
  TemplateSectionMixedFieldBlockOptionConfig
} from "../types/template";
import {
  createDataviewInlineFieldRegex,
  extractDataviewInlineFieldNames,
  hasDataviewInlineField
} from "../utils/dataview-inline-field";
import {
  inferDerivedSectionAliases,
  inferPresenceFieldName
} from "./template-section-structure-hints";
import { TemplateScanner } from "./template-scanner";
import { extractPlaceholders } from "../utils/placeholder";

function slugifyBehaviorId(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function isInlineFieldPlaceholderLine(line: string): boolean {
  return hasDataviewInlineField(line);
}

function hasTemplaterExpression(value: string): boolean {
  return /<%[\s\S]*?%>/.test(value);
}

function isRuntimePlaceholderShellValue(value: string): boolean {
  const normalized = value.trim();
  return normalized === "``" || normalized === "\"\"" || normalized === "''";
}

function isMarkdownTaskLine(line: string): boolean {
  return /^\s*[-*+]\s+\[[ xX]\]\s*.*$/.test(line);
}

function isBlockquoteStructuredPrefix(line: string): boolean {
  return /^\s*>\s*[-*+]\s+/.test(line) || /^\s*>\s*#{2,6}\s+/.test(line);
}

function isPlainStructuredLabelLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || /^#{1,6}\s+/.test(trimmed) || /^[-*+]\s+\[[ xX]\]/.test(trimmed)) {
    return false;
  }

  const match = line.match(/^\s*(?![-*+]\s+)(.+?)[：:]\s*(.*)$/);
  if (!match) {
    return false;
  }

  const label = (match[1] ?? "").trim();
  return Boolean(label) && extractPlaceholders(label).length === 0 && !label.includes("`");
}

function createFieldConfig(label: string, index: number, id?: string): TemplateSectionBehaviorFieldConfig {
  return {
    id: id?.trim() || slugifyBehaviorId(label, `field-${index + 1}`),
    label
  };
}

function createGroupConfig(label: string, index: number): TemplateSectionBehaviorGroupConfig {
  return {
    id: slugifyBehaviorId(label, `group-${index + 1}`),
    label
  };
}

function extractGroupedHeadingBlocks(rawContent: string): Array<{
  headingPrefix: string;
  label: string;
  body: string;
}> {
  const lines = rawContent.split(/\r?\n/);
  const headings = lines
    .map((line, lineIndex) => {
      const match = line.match(/^(\s*>?\s*#{2,6}\s+)(.+?)\s*$/);
      if (!match) {
        return null;
      }

      return {
        lineIndex,
        headingPrefix: match[1] ?? "",
        label: (match[2] ?? "").trim()
      };
    })
    .filter((entry): entry is { lineIndex: number; headingPrefix: string; label: string } => entry !== null);

  return headings.map((heading, index) => {
    const nextHeading = headings[index + 1];
    return {
      headingPrefix: heading.headingPrefix,
      label: heading.label,
      body: lines.slice(heading.lineIndex + 1, nextHeading?.lineIndex).join("\n")
    };
  });
}

function normalizePresenceMarkerFieldName(value: string | undefined): string | undefined {
  const normalized = (value ?? "")
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "");
  if (!normalized || /[，,。；;、|｜/\\]/.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function inferPresenceFieldNameFromGroupBody(groupBody: string): string | undefined {
  const normalizedBody = groupBody.replace(/`([^`]+)`/g, " $1 ");
  const markerMatch = normalizedBody.match(
    /\bfrontmatter\b\s*(?:字段|field|key)?\s*[：:]?\s*([^\s`=：:]+)\s*(?:=|:|：)\s*(?:1|true|yes|完成)\b/i
  );

  return normalizePresenceMarkerFieldName(markerMatch?.[1]);
}

function createMixedTextItemConfig(
  label: string,
  index: number,
  targetFieldName?: string
): Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "text_field" }> {
  return {
    id: slugifyBehaviorId(label, `mixed-text-${index + 1}`),
    kind: "text_field",
    label,
    aliases: [],
    targetFieldName,
    inputKind: "text"
  };
}

function createMixedInlineFieldGroupFieldConfig(
  fieldName: string,
  index: number
): TemplateSectionMixedFieldBlockFieldConfig {
  return {
    id: slugifyBehaviorId(fieldName, `mixed-inline-field-${index + 1}`),
    label: fieldName,
    fieldName,
    aliases: []
  };
}

function createMixedCheckboxOptionConfig(
  label: string,
  index: number
): TemplateSectionMixedFieldBlockOptionConfig {
  return {
    id: slugifyBehaviorId(label, `mixed-option-${index + 1}`),
    label,
    value: label,
    aliases: []
  };
}

function createMixedTaskListItemConfig(
  label: string,
  index: number,
  taskPrefix: string | undefined,
  targetFieldName?: string
): Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "task_list" }> {
  return {
    id: slugifyBehaviorId(label, `mixed-task-list-${index + 1}`),
    kind: "task_list",
    label,
    aliases: [],
    targetFieldName,
    taskPrefix
  };
}

function resolveSinglePlaceholderTarget(value: string): string | undefined {
  const placeholders = Array.from(new Set(extractPlaceholders(value)));
  return placeholders.length === 1 ? placeholders[0] : undefined;
}

function parseStandaloneDataviewInlineFieldLine(line: string): { fieldName: string; value: string } | undefined {
  const normalized = line.replace(/^\s*[-*+]\s+/, "").trim();
  const matches = Array.from(normalized.matchAll(createDataviewInlineFieldRegex("gu")));
  if (matches.length !== 1 || matches[0]?.[0] !== normalized) {
    return undefined;
  }

  const fieldName = matches[0]?.[1]?.trim() ?? "";
  if (!fieldName) {
    return undefined;
  }

  return {
    fieldName,
    value: matches[0]?.[2]?.trim() ?? ""
  };
}

function uniqueByLabel<T extends { label: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.label.trim();
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function inferStructuredLines(
  rawContent: string
): Array<{ prefix: string; label: string; separator: string; targetFieldName?: string }> {
  const lines = rawContent.split(/\r?\n/);
  const results: Array<{ prefix: string; label: string; separator: string; targetFieldName?: string }> = [];
  let collecting = false;
  const structuralLinePatterns = [
    /^(\s*>?\s*(?:[-*+]\s+|\d+[.)]\s+))(.+?)([：:])\s*(.*)$/,
    /^(\s*>?\s*(?:[-*+]\s+|\d+[.)]\s+))(.+?)([，,。.;；、|｜~·]|[-—–]{1,2})\s*(.*)$/
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (collecting) {
        continue;
      }
      continue;
    }

    if (isMarkdownTaskLine(line)) {
      if (collecting) {
        break;
      }
      continue;
    }

    const match = structuralLinePatterns
      .map((pattern) => line.match(pattern))
      .find((candidate): candidate is RegExpMatchArray => candidate !== null);
    if (!match) {
      if (collecting) {
        break;
      }
      continue;
    }

    if (isInlineFieldPlaceholderLine(line)) {
      continue;
    }

    const label = (match[2] ?? "").trim();
    const separator = match[3] ?? "：";
    if (extractPlaceholders(label).length > 0) {
      continue;
    }

    if (!label || label.includes("`")) {
      if (collecting) {
        break;
      }
      continue;
    }

    if (isBlockquoteStructuredPrefix(line) && !/^[：:]$/.test(separator)) {
      if (collecting) {
        break;
      }
      continue;
    }

    collecting = true;
    results.push({
      prefix: match[1] ?? "- ",
      label,
      separator,
      targetFieldName: resolveSinglePlaceholderTarget(match[4] ?? "")
    });
  }

  return results;
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
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

export function inferTableBehavior(rawContent: string): TemplateSectionBehaviorConfig | undefined {
  const lines = rawContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerLine = lines[index] ?? "";
    const separatorLine = lines[index + 1] ?? "";
    if (!headerLine.includes("|") || !separatorLine.includes("|") || !isMarkdownTableSeparatorRow(separatorLine)) {
      continue;
    }

    const templateRows: string[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowLine = lines[rowIndex] ?? "";
      if (!rowLine.includes("|")) {
        break;
      }
      templateRows.push(rowLine);
    }
    const firstTemplateValues = templateRows
      .map((rowLine) => splitMarkdownTableRow(rowLine))
      .find((cells) => cells.some((cell) => extractPlaceholders(cell).length > 0));
    const columns = splitMarkdownTableRow(headerLine)
      .map((label, columnIndex) =>
        createFieldConfig(
          label,
          columnIndex,
          firstTemplateValues ? resolveSinglePlaceholderTarget(firstTemplateValues[columnIndex] ?? "") : undefined
        )
      )
      .filter((column) => column.label.length > 0);
    if (columns.length < 2) {
      continue;
    }

    return {
      kind: "table_block",
      sourceAliases: [],
      columns,
      overrideMode: "replace"
    };
  }

  return undefined;
}

export function inferMixedFieldBlockBehavior(
  rawContent: string
): TemplateSectionMixedFieldBlockBehaviorConfig | undefined {
  const lines = rawContent.split(/\r?\n/);
  const itemScanner = new TemplateScanner();
  const scannedFieldNames = new Set(itemScanner.scanFields(rawContent).map((field) => field.name));
  const items: TemplateSectionMixedFieldBlockItemConfig[] = [];
  let hasInlineFieldGroup = false;
  let hasCheckboxEnum = false;
  let hasTextField = false;
  let hasTaskList = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const headingTaskListMatch = line.match(/^\s*#{2,6}\s+(.+?)\s*$/);
    if (headingTaskListMatch) {
      const label = (headingTaskListMatch[1] ?? "").trim();
      const taskLines: string[] = [];
      let nextIndex = index + 1;
      let taskPrefix: string | undefined;
      while (nextIndex < lines.length) {
        const nextLine = lines[nextIndex] ?? "";
        const taskMatch = nextLine.match(/^(\s*[-*+]\s+\[(?: |x|X)\]\s+)(.+)\s*$/);
        if (taskMatch) {
          taskPrefix ??= taskMatch[1]?.trimEnd();
          taskLines.push(taskMatch[2]?.trim() ?? "");
          nextIndex += 1;
          continue;
        }

        if (!nextLine.trim()) {
          nextIndex += 1;
          continue;
        }

        break;
      }

      if (label && taskLines.length > 0) {
        hasTaskList = true;
        items.push(
          createMixedTaskListItemConfig(
            label,
            items.length,
            taskPrefix,
            resolveSinglePlaceholderTarget(taskLines.join("\n")) ?? (scannedFieldNames.has(label) ? label : undefined)
          )
        );
        index = nextIndex - 1;
        continue;
      }
    }

    const labeledTaskListMatch = line.match(/^\s*(?![-*+]\s+)(.+?)[：:]\s*$/);
    if (labeledTaskListMatch) {
      const label = (labeledTaskListMatch[1] ?? "").trim();
      if (!label) {
        continue;
      }

      const taskLines: string[] = [];
      let nextIndex = index + 1;
      let taskPrefix: string | undefined;
      while (nextIndex < lines.length) {
        const nextLine = lines[nextIndex] ?? "";
        const taskMatch = nextLine.match(/^(\s*[-*+]\s+\[(?: |x|X)\]\s+)(.+)\s*$/);
        if (taskMatch) {
          taskPrefix ??= taskMatch[1]?.trimEnd();
          taskLines.push(taskMatch[2]?.trim() ?? "");
          nextIndex += 1;
          continue;
        }

        if (!nextLine.trim()) {
          nextIndex += 1;
          continue;
        }

        break;
      }

      if (taskLines.length > 0) {
        hasTaskList = true;
        items.push(
          createMixedTaskListItemConfig(
            label,
            items.length,
            taskPrefix,
            scannedFieldNames.has(label) ? label : undefined
          )
        );
        index = nextIndex - 1;
        continue;
      }
    }

    const plainStructuredLabelMatch = line.match(/^\s*(?![-*+]\s+)(.+?)[：:]\s*(.*)$/);
    if (plainStructuredLabelMatch && isPlainStructuredLabelLine(line)) {
      const label = (plainStructuredLabelMatch[1] ?? "").trim();
      const trailingValue = plainStructuredLabelMatch[2] ?? "";
      if (
        label &&
        !hasTemplaterExpression(trailingValue) &&
        !isRuntimePlaceholderShellValue(trailingValue)
      ) {
        hasTextField = true;
        items.push(
          createMixedTextItemConfig(
            label,
            items.length,
            resolveSinglePlaceholderTarget(trailingValue) ?? (scannedFieldNames.has(label) ? label : undefined)
          )
        );
        continue;
      }
    }

    const standaloneInlineField = parseStandaloneDataviewInlineFieldLine(line);
    if (standaloneInlineField) {
      hasTextField = true;
      items.push(
        createMixedTextItemConfig(
          standaloneInlineField.fieldName,
          items.length,
          resolveSinglePlaceholderTarget(standaloneInlineField.value) ??
            (scannedFieldNames.has(standaloneInlineField.fieldName) ? standaloneInlineField.fieldName : undefined)
        )
      );
      continue;
    }

    const topLevelMatch = line.match(/^(\s*)[-*+]\s+(.+?)[：:]\s*(.*)$/);
    if (!topLevelMatch) {
      continue;
    }

    const indent = topLevelMatch[1]?.length ?? 0;
    const label = (topLevelMatch[2] ?? "").trim();
    if (!label || extractPlaceholders(label).length > 0) {
      continue;
    }

    const nestedLines: string[] = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const nextLine = lines[nextIndex] ?? "";
      if (!nextLine.trim()) {
        break;
      }

      const nextIndent = nextLine.match(/^(\s*)/)?.[1]?.length ?? 0;
      const isNextTopLevel = /^(\s*)[-*+]\s+.+?[：:]\s*(.*)$/.test(nextLine) && nextIndent <= indent;
      if (isNextTopLevel) {
        break;
      }

      if (nextIndent > indent) {
        nestedLines.push(nextLine);
        nextIndex += 1;
        continue;
      }

      break;
    }

    const inlineFieldNames = nestedLines
      .flatMap((nestedLine) => extractDataviewInlineFieldNames(nestedLine))
      .filter((value) => value.length > 0);
    if (inlineFieldNames.length > 0) {
      hasInlineFieldGroup = true;
      items.push({
        id: slugifyBehaviorId(label, `mixed-inline-group-${items.length + 1}`),
        kind: "inline_field_group",
        label,
        aliases: [],
        fields: uniqueByLabel(
          inlineFieldNames.map((fieldName, fieldIndex) =>
            createMixedInlineFieldGroupFieldConfig(fieldName, fieldIndex)
          )
        )
      });
      index = nextIndex - 1;
      continue;
    }

    const checkboxOptions = nestedLines
      .map((nestedLine) => nestedLine.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.+)\s*$/)?.[1]?.trim() ?? "")
      .filter((value) => value.length > 0);
    if (checkboxOptions.length > 0) {
      hasCheckboxEnum = true;
      items.push({
        id: slugifyBehaviorId(label, `mixed-checkbox-${items.length + 1}`),
        kind: "checkbox_enum",
        label,
        aliases: [],
        targetFieldName: scannedFieldNames.has(label) ? label : undefined,
        selectMode: "single",
        options: checkboxOptions.map((option, optionIndex) =>
          createMixedCheckboxOptionConfig(option, optionIndex)
        )
      });
      index = nextIndex - 1;
      continue;
    }

    const followingCheckboxLines: string[] = [];
    let checkboxIndex = index + 1;
    while (checkboxIndex < lines.length) {
      const nextLine = lines[checkboxIndex] ?? "";
      const taskMatch = nextLine.match(/^\s*[-*+]\s+\[(?: |x|X)\]\s+(.+)\s*$/);
      if (taskMatch) {
        followingCheckboxLines.push(taskMatch[1]?.trim() ?? "");
        checkboxIndex += 1;
        continue;
      }

      if (!nextLine.trim()) {
        checkboxIndex += 1;
        continue;
      }

      break;
    }

    if (followingCheckboxLines.length >= 2) {
      const targetFieldName =
        resolveSinglePlaceholderTarget(topLevelMatch[3] ?? "") ?? (scannedFieldNames.has(label) ? label : undefined);
      hasCheckboxEnum = true;
      items.push({
        id: slugifyBehaviorId(label, `mixed-checkbox-${items.length + 1}`),
        kind: "checkbox_enum",
        label,
        aliases: [],
        targetFieldName,
        checkedValueFieldName: targetFieldName ? `${targetFieldName}__checked_options` : undefined,
        selectMode: "single",
        options: followingCheckboxLines.map((option, optionIndex) =>
          createMixedCheckboxOptionConfig(option, optionIndex)
        )
      });
      index = checkboxIndex - 1;
      continue;
    }

    const trailingValue = topLevelMatch[3] ?? "";
    if (!hasTemplaterExpression(trailingValue) && !isRuntimePlaceholderShellValue(trailingValue)) {
      hasTextField = true;
      items.push(
        createMixedTextItemConfig(
          label,
          items.length,
          resolveSinglePlaceholderTarget(trailingValue) ?? (scannedFieldNames.has(label) ? label : undefined)
        )
      );
    }
    index = nextIndex - 1;
  }

  const kindCount =
    Number(hasTextField) + Number(hasInlineFieldGroup) + Number(hasCheckboxEnum) + Number(hasTaskList);
  if (items.length < 2 || kindCount < 2 || (!hasInlineFieldGroup && !hasCheckboxEnum && !hasTaskList)) {
    return undefined;
  }

  return {
    kind: "mixed_field_block",
    sourceAliases: [],
    items,
    overrideMode: "replace"
  };
}

export function inferGroupedBehavior(
  title: string,
  rawContent: string,
  allTemplateFieldNames: string[]
): TemplateSectionBehaviorConfig | undefined {
  const headingBlocks = extractGroupedHeadingBlocks(rawContent).filter(
    (block) => block.label.trim() !== title.trim()
  );

  if (headingBlocks.length < 2) {
    return undefined;
  }

  const groupHeadingPrefix = headingBlocks[0]?.headingPrefix ?? "> ## ";
  const groupBodyByLabel = new Map<string, string>();
  headingBlocks.forEach((block) => {
    if (!groupBodyByLabel.has(block.label)) {
      groupBodyByLabel.set(block.label, block.body);
    }
  });
  const groups = uniqueByLabel(
    headingBlocks.map((block, index) => createGroupConfig(block.label, index))
  );
  if (groups.length < 2) {
    return undefined;
  }

  const structuredLines = headingBlocks.flatMap((block) => inferStructuredLines(block.body));
  const fields = uniqueByLabel(
    structuredLines.map((entry, index) => createFieldConfig(entry.label, index, entry.targetFieldName))
  );
  if (fields.length === 0) {
    return undefined;
  }

  const sourceAliases = inferDerivedSectionAliases(title);
  return {
    kind: "grouped_field_block",
    sourceAliases,
    groups: groups.map((group) => ({
      ...group,
      presenceFieldName:
        inferPresenceFieldNameFromGroupBody(groupBodyByLabel.get(group.label) ?? "") ??
        inferPresenceFieldName(group.label, allTemplateFieldNames)
    })),
    fields,
    fallbackFieldId: fields[0]?.id,
    groupHeadingPrefix,
    linePrefix: structuredLines[0]?.prefix ?? "> - ",
    separator: structuredLines[0]?.separator ?? "：",
    overrideMode: "replace"
  };
}

export function inferFieldBlockBehavior(
  title: string,
  rawContent: string
): TemplateSectionBehaviorConfig | undefined {
  const structuredLines = inferStructuredLines(rawContent);
  const fields = uniqueByLabel(
    structuredLines.map((entry, index) => createFieldConfig(entry.label, index, entry.targetFieldName))
  );

  if (fields.length < 2) {
    return undefined;
  }

  return {
    kind: "field_block",
    sourceAliases: inferDerivedSectionAliases(title),
    fields,
    linePrefix: structuredLines[0]?.prefix ?? "> - ",
    separator: structuredLines[0]?.separator ?? "：",
    overrideMode: "replace"
  };
}

export function inferTaskListBehavior(rawContent: string): TemplateSectionBehaviorConfig | undefined {
  const taskLines = rawContent
    .split(/\r?\n/)
    .filter((line) => /^\s*[-*+]\s+\[[ xX]\]\s*.*$/.test(line));

  if (taskLines.length < 2) {
    return undefined;
  }

  const firstLine = taskLines[0] ?? "- [ ] ";
  const prefixMatch = firstLine.match(/^(\s*[-*+]\s+\[(?: |x|X)\]\s+)/);

  return {
    kind: "task_list",
    sourceAliases: [],
    taskPrefix: prefixMatch?.[1] ?? "- [ ] ",
    overrideMode: "replace"
  };
}

export function inferPlainBulletListBehavior(rawContent: string): TemplateSectionBehaviorConfig | undefined {
  const bulletLines = rawContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*+]\s*$/.test(line));

  if (bulletLines.length < 2) {
    return undefined;
  }

  return {
    kind: "repeatable_text",
    sourceAliases: [],
    overrideMode: "replace"
  };
}
