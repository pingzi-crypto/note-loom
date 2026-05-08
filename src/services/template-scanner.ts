import type { ScannedTemplateField } from "../types/template";
import {
  createDataviewInlineFieldRegex,
  extractDataviewInlineFieldNames,
  hasDataviewInlineField
} from "../utils/dataview-inline-field";
import { extractPlaceholders } from "../utils/placeholder";
import { stripTemplateRuntimeBlocks } from "../utils/template-content";

function addUniqueField(
  fields: ScannedTemplateField[],
  uniqueFields: Set<string>,
  field: ScannedTemplateField
): void {
  if (uniqueFields.has(field.name)) {
    const existing = fields.find((item) => item.name === field.name);
    if (existing && (field.aliases?.length ?? 0) > 0) {
      existing.aliases = Array.from(new Set([...(existing.aliases ?? []), ...(field.aliases ?? [])]));
    }
    if (existing && (field.frontmatterTargets?.length ?? 0) > 0) {
      existing.frontmatterTargets = Array.from(
        new Set([...(existing.frontmatterTargets ?? []), ...(field.frontmatterTargets ?? [])])
      );
    }
    if (existing && (field.checkboxOptions?.length ?? 0) > 0) {
      existing.checkboxOptions = Array.from(new Set([...(existing.checkboxOptions ?? []), ...(field.checkboxOptions ?? [])]));
      if (field.kind === "checkbox_group") {
        existing.kind = "checkbox_group";
      }
    }
    if (existing && existing.kind === "text" && field.kind && field.kind !== "text") {
      existing.kind = field.kind;
    }
    return;
  }

  uniqueFields.add(field.name);
  const nextField: ScannedTemplateField = {
    ...field,
    ...(field.aliases ? { aliases: [...field.aliases] } : {}),
    ...(field.frontmatterTargets ? { frontmatterTargets: [...field.frontmatterTargets] } : {})
  };
  fields.push(nextField);
}

function extractFrontmatterPlaceholderTargets(content: string): Map<string, string[]> {
  const lines = content.split(/\r?\n/);
  const targetsByField = new Map<string, Set<string>>();
  if ((lines[0] ?? "").trim() !== "---") {
    return new Map();
  }

  const addTargets = (rawValue: string, targetName: string | undefined): void => {
    const normalizedTarget = targetName?.trim() ?? "";
    if (!normalizedTarget) {
      return;
    }

    extractPlaceholders(rawValue).forEach((fieldName) => {
      const normalizedField = fieldName.trim();
      if (!normalizedField) {
        return;
      }

      const targets = targetsByField.get(normalizedField) ?? new Set<string>();
      targets.add(normalizedTarget);
      targetsByField.set(normalizedField, targets);
    });
  };

  let currentKey = "";
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "---") {
      break;
    }

    const keyMatch = line.match(/^\s*([^:#\s][^:#]*?)\s*:\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1]?.trim() ?? "";
      addTargets(keyMatch[2] ?? "", currentKey);
      continue;
    }

    const listItemMatch = line.match(/^\s*-\s*(.*)$/);
    if (listItemMatch) {
      addTargets(listItemMatch[1] ?? "", currentKey);
    }
  }

  return new Map(
    Array.from(targetsByField.entries()).map(([fieldName, targets]) => [
      fieldName,
      Array.from(targets)
    ])
  );
}

function parseInlineEnumOptions(rawValue: string): string[] {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return [];
  }

  // Only treat slash-delimited values as enum hints when the separators are
  // written as human-readable option lists rather than URLs or paths.
  if (!/\s\/\s/.test(trimmed) && !(/[\p{Script=Han}]/u.test(trimmed) && trimmed.includes("/"))) {
    return [];
  }

  if (/[<>{}\[\]]/.test(trimmed) || /:\/\//.test(trimmed)) {
    return [];
  }

  const options = trimmed
    .split(/\s*\/\s*/g)
    .map((option) => option.trim())
    .filter(Boolean);

  return options.length >= 2 ? options : [];
}

function extractInlineFieldAlias(line: string, matchIndex: number): string | undefined {
  const prefix = line
    .slice(0, matchIndex)
    .replace(/^\s*>?\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .trim()
    .replace(/[：:，,。.;；、|｜/\\\-—–~·]+$/g, "")
    .trim();

  return isPlausibleStructuredFieldName(prefix) ? prefix : undefined;
}

function collectFollowingTaskLines(
  lines: string[],
  startIndex: number
): { tasks: string[]; nextIndex: number } {
  const tasks: string[] = [];
  let nextIndex = startIndex + 1;
  let started = false;

  while (nextIndex < lines.length) {
    const nextLine = lines[nextIndex] ?? "";
    const taskMatch = nextLine.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.+)\s*$/);
    if (taskMatch) {
      tasks.push(taskMatch[1]?.trim() ?? "");
      started = true;
      nextIndex += 1;
      continue;
    }

    if (!nextLine.trim()) {
      nextIndex += 1;
      if (!started) {
        continue;
      }
      continue;
    }

    break;
  }

  return {
    tasks: tasks.filter(Boolean),
    nextIndex
  };
}

function findNextNonBlankLine(lines: string[], startIndex: number): { line: string; index: number } | null {
  let nextIndex = startIndex + 1;
  while (nextIndex < lines.length) {
    const nextLine = lines[nextIndex] ?? "";
    if (nextLine.trim().length > 0) {
      return {
        line: nextLine,
        index: nextIndex
      };
    }
    nextIndex += 1;
  }

  return null;
}

function isPlaceholderBulletLine(line: string): boolean {
  return /^\s*[-*+]\s*$/.test(line) || /^\s*[-*+]\s+$/.test(line);
}

function isMarkdownTaskLine(line: string): boolean {
  return /^\s*[-*+]\s+\[[ xX]\]\s+.+$/.test(line);
}

function isPlausibleStructuredFieldName(fieldName: string): boolean {
  const normalized = fieldName.trim();
  if (!normalized || normalized.length > 80) {
    return false;
  }

  if (/^[`'"‘’“”.,;!?()[\]{}<>$]/.test(normalized)) {
    return false;
  }

  if (/[`'"{}$=<>\\;]/.test(normalized)) {
    return false;
  }

  if (/(?:=>|\?\s*:|\b(?:const|let|var|return|function|if|else)\b|\.\w+\s*\()/i.test(normalized)) {
    return false;
  }

  return /[\p{L}\p{N}_-]/u.test(normalized);
}

function isStaticReferenceValue(value: string): boolean {
  const normalized = value.trim();
  return /^!?\[\[[^\]\r\n]+?\]\]$/u.test(normalized) || /^\[[^\]\r\n]+?\]\([^)]+?\)$/u.test(normalized);
}

function hasTemplaterExpression(value: string): boolean {
  return /<%[\s\S]*?%>/.test(value);
}

function isRuntimePlaceholderShellValue(value: string): boolean {
  const normalized = value.trim();
  return normalized === "``" || normalized === "\"\"" || normalized === "''";
}

function extractInlineFields(content: string): ScannedTemplateField[] {
  const fields: ScannedTemplateField[] = [];

  content.split(/\r?\n/).forEach((line) => {
    const matches = Array.from(line.matchAll(createDataviewInlineFieldRegex("gu")));
    const inferVisibleAlias = matches.length === 1;
    matches.forEach((match) => {
      const name = match[1]?.trim() ?? "";
      if (!name) {
        return;
      }

      const rawValue = match[2]?.trim() ?? "";
      const checkboxOptions = parseInlineEnumOptions(rawValue);
      const alias = inferVisibleAlias ? extractInlineFieldAlias(line, match.index ?? 0) : undefined;

      fields.push({
        name,
        order: fields.length,
        kind: "inline_field",
        checkboxOptions,
        aliases: alias ? [alias] : undefined
      });
    });
  });

  return fields;
}

function extractStructuredFields(content: string): ScannedTemplateField[] {
  const lines = content.split(/\r?\n/);
  const fields: ScannedTemplateField[] = [];
  const uniqueFields = new Set<string>();
  let frontmatterState: "unknown" | "inside" | "done" = "unknown";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmedLine = line.trim();

    if (frontmatterState === "unknown") {
      if (trimmedLine === "---") {
        frontmatterState = "inside";
        continue;
      }
      if (trimmedLine.length > 0) {
        frontmatterState = "done";
      }
    } else if (frontmatterState === "inside") {
      if (trimmedLine === "---") {
        frontmatterState = "done";
      }
      continue;
    }

    const groupMatch = line.match(/^\s*-\s+(.+?)[：:]\s*$/);
    if (groupMatch) {
      const groupName = groupMatch[1]?.trim() ?? "";
      if (!isPlausibleStructuredFieldName(groupName)) {
        continue;
      }

      const nestedLines: string[] = [];
      let nextIndex = index + 1;
      while (nextIndex < lines.length) {
        const nextLine = lines[nextIndex] ?? "";
        if (!/^\s{2,}-\s+/.test(nextLine)) {
          break;
        }

        nestedLines.push(nextLine);
        nextIndex += 1;
      }

      const checkboxOptions = nestedLines
        .map((nestedLine) => nestedLine.match(/^\s*-\s+\[[ xX]\]\s+(.+)\s*$/)?.[1]?.trim() ?? "")
        .filter(Boolean);
      const inlineFieldNames = nestedLines
        .flatMap((nestedLine) => extractDataviewInlineFieldNames(nestedLine))
        .filter(Boolean);

      if (checkboxOptions.length > 0) {
        addUniqueField(fields, uniqueFields, {
          name: groupName,
          order: fields.length,
          kind: "checkbox_group",
          checkboxOptions
        });
        index = nextIndex - 1;
        continue;
      }

      if (inlineFieldNames.length > 0) {
        inlineFieldNames.forEach((fieldName) =>
          addUniqueField(fields, uniqueFields, {
            name: fieldName,
            order: fields.length,
            kind: "inline_field"
          })
        );
        index = nextIndex - 1;
        continue;
      }
    }

    const taskListLabelMatch = line.match(/^\s*(?![-*+]\s+)(.+?)[：:]\s*$/);
    if (taskListLabelMatch) {
      const fieldName = taskListLabelMatch[1]?.trim() ?? "";
      if (!isPlausibleStructuredFieldName(fieldName)) {
        continue;
      }

      const taskBlock = collectFollowingTaskLines(lines, index);
      if (taskBlock.tasks.length > 0) {
        addUniqueField(fields, uniqueFields, {
          name: fieldName,
          order: fields.length,
          kind: "text"
        });
        index = taskBlock.nextIndex - 1;
        continue;
      }
    }

    if (hasDataviewInlineField(line)) {
      continue;
    }

    if (isMarkdownTaskLine(line)) {
      continue;
    }

    const plainLabelMatch = line.match(/^\s*(?![-*+]\s+|#|>|\||[`-]{3,})(.+?)[：:]\s*(.*)$/);
    if (plainLabelMatch) {
      const fieldName = plainLabelMatch[1]?.trim() ?? "";
      const trailingValue = plainLabelMatch[2]?.trim() ?? "";
      if (!isPlausibleStructuredFieldName(fieldName)) {
        continue;
      }

      const placeholderFields = extractPlaceholders(trailingValue);
      if (placeholderFields.length > 0) {
        placeholderFields.forEach((placeholderField) =>
          addUniqueField(fields, uniqueFields, {
            name: placeholderField,
            order: fields.length,
            kind: "text",
            aliases: [fieldName]
          })
        );
        continue;
      }

      if (isStaticReferenceValue(trailingValue)) {
        continue;
      }

      if (hasTemplaterExpression(trailingValue) || isRuntimePlaceholderShellValue(trailingValue)) {
        continue;
      }

      const nextNonBlank = findNextNonBlankLine(lines, index);
      const hasPlaceholderBullet = nextNonBlank ? isPlaceholderBulletLine(nextNonBlank.line) : false;

      if (trailingValue.length > 0 || hasPlaceholderBullet) {
        addUniqueField(fields, uniqueFields, {
          name: fieldName,
          order: fields.length,
          kind: "text"
        });

        if (hasPlaceholderBullet && nextNonBlank) {
          index = nextNonBlank.index;
        }
        continue;
      }
    }

    const textFieldMatch = line.match(/^\s*-\s+(.+?)[：:]\s*(.*)$/);
    if (textFieldMatch) {
      const fieldName = textFieldMatch[1]?.trim() ?? "";
      const trailingValue = textFieldMatch[2]?.trim() ?? "";
      if (!isPlausibleStructuredFieldName(fieldName)) {
        continue;
      }

      const placeholderFields = extractPlaceholders(trailingValue);
      if (placeholderFields.length > 0) {
        placeholderFields.forEach((placeholderField) =>
          addUniqueField(fields, uniqueFields, {
            name: placeholderField,
            order: fields.length,
            kind: "text",
            aliases: [fieldName]
          })
        );
        continue;
      }

      if (isStaticReferenceValue(trailingValue)) {
        continue;
      }

      if (hasTemplaterExpression(trailingValue) || isRuntimePlaceholderShellValue(trailingValue)) {
        addUniqueField(fields, uniqueFields, {
          name: fieldName,
          order: fields.length,
          kind: "text"
        });
        continue;
      }

      addUniqueField(fields, uniqueFields, {
        name: fieldName,
        order: fields.length,
        kind: "text"
      });
    }
  }

  return fields;
}

export class TemplateScanner {
  scanFields(content: string): ScannedTemplateField[] {
    const editableContent = stripTemplateRuntimeBlocks(content);
    const placeholders = extractPlaceholders(editableContent);
    const frontmatterTargetsByField = extractFrontmatterPlaceholderTargets(editableContent);
    const uniqueFields = new Set<string>();
    const fields: ScannedTemplateField[] = [];

    placeholders.forEach((fieldName, index) => {
      if (uniqueFields.has(fieldName)) {
        return;
      }

      addUniqueField(fields, uniqueFields, {
        name: fieldName,
        order: index,
        kind: "text",
        frontmatterTargets: frontmatterTargetsByField.get(fieldName)
      });
    });

    extractInlineFields(editableContent).forEach((field) => {
      addUniqueField(fields, uniqueFields, {
        ...field,
        order: fields.length,
        kind: "inline_field"
      });
    });

    extractStructuredFields(editableContent).forEach((field) => {
      addUniqueField(fields, uniqueFields, {
        ...field,
        order: fields.length
      });
    });

    return fields;
  }
}
