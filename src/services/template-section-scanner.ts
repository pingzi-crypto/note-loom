import type {
  ScannedTemplateSection,
  TemplateSectionKind,
  TemplateSectionMode
} from "../types/template";
import {
  extractDataviewInlineFieldNames,
  hasDataviewInlineField
} from "../utils/dataview-inline-field";
import { stripTemplateRuntimeBlocks } from "../utils/template-content";
import { TemplateScanner } from "./template-scanner";

function stripNonEditableBlocks(content: string): string {
  return stripTemplateRuntimeBlocks(content);
}

function slugifySectionTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function hasRepeatableInlineEntryPattern(rawContent: string): boolean {
  return rawContent
    .split(/\r?\n/)
    .some((line) => {
      if (!/^\s*>?\s*[-*+]\s+/.test(line)) {
        return false;
      }

      return extractDataviewInlineFieldNames(line).length >= 2;
    });
}

function detectSectionKind(
  _title: string,
  rawContent: string,
  hasDataviewCode: boolean,
  hasInlineFields: boolean,
  hasListEntries: boolean
): TemplateSectionKind {
  if (hasDataviewCode && !hasInlineFields) {
    return "computed_block";
  }

  if (
    /\[(start|end|category|subcategory|value|mode|result)::/i.test(rawContent) ||
    hasRepeatableInlineEntryPattern(rawContent)
  ) {
    return "repeatable_entries";
  }

  if (hasInlineFields) {
    return "inline_fields";
  }

  if (hasListEntries) {
    return "content_block";
  }

  if (hasDataviewCode) {
    return "mixed";
  }

  return "content_block";
}

function suggestSectionMode(kind: TemplateSectionKind, _title: string): TemplateSectionMode {
  if (kind === "computed_block") {
    return "preserve";
  }

  return "generate";
}

interface HeadingMatch {
  index: number;
  level: number;
  title: string;
}

function resolveFrontmatterEndLineIndex(lines: string[]): number | null {
  if ((lines[0] ?? "").trim() !== "---") {
    return null;
  }

  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === "---") {
      return index;
    }
  }

  return null;
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

function collectMarkdownThematicBreakLineIndexes(lines: string[]): number[] {
  const breakIndexes: number[] = [];
  const frontmatterEndLineIndex = resolveFrontmatterEndLineIndex(lines);
  let inCodeFence = false;

  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeFence = !inCodeFence;
      return;
    }

    if (inCodeFence) {
      return;
    }

    if (frontmatterEndLineIndex !== null && index <= frontmatterEndLineIndex) {
      return;
    }

    if (isMarkdownThematicBreak(line)) {
      breakIndexes.push(index);
    }
  });

  return breakIndexes;
}

function resolveSectionHeadingLevel(headings: HeadingMatch[]): number | null {
  if (headings.length === 0) {
    return null;
  }

  const headingsByLevel = new Map<number, number>();
  headings.forEach((heading) => {
    headingsByLevel.set(heading.level, (headingsByLevel.get(heading.level) ?? 0) + 1);
  });

  const topLevelCount = headingsByLevel.get(1) ?? 0;
  if (topLevelCount >= 2) {
    return 1;
  }

  if (topLevelCount === 1) {
    const secondLevelCount = headingsByLevel.get(2) ?? 0;
    if (secondLevelCount >= 2) {
      return 2;
    }

    return 1;
  }

  for (let level = 1; level <= 6; level += 1) {
    if ((headingsByLevel.get(level) ?? 0) > 0) {
      return level;
    }
  }

  return null;
}

export class TemplateSectionScanner {
  scan(content: string): ScannedTemplateSection[] {
    const lines = content.split(/\r?\n/);
    const sections: ScannedTemplateSection[] = [];
    const fieldScanner = new TemplateScanner();
    let inCodeFence = false;
    const headings: HeadingMatch[] = [];
    const frontmatterEndLineIndex = resolveFrontmatterEndLineIndex(lines);
    const thematicBreakLineIndexes = collectMarkdownThematicBreakLineIndexes(lines);

    lines.forEach((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inCodeFence = !inCodeFence;
      }

      if (inCodeFence) {
        return;
      }

      if (frontmatterEndLineIndex !== null && index <= frontmatterEndLineIndex) {
        return;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (!headingMatch) {
        return;
      }

      headings.push({
        index,
        level: headingMatch[1]?.length ?? 1,
        title: headingMatch[2]?.trim() ?? ""
      });
    });

    const sectionHeadingLevel = resolveSectionHeadingLevel(headings);
    if (!sectionHeadingLevel) {
      return sections;
    }

    const sectionHeadings = headings.filter((heading) => heading.level === sectionHeadingLevel);

    sectionHeadings.forEach((heading, sectionIndex) => {
      if (!heading.title) {
        return;
      }

      const nextHeading = sectionHeadings[sectionIndex + 1];
      const nextHeadingIndex = nextHeading?.index ?? lines.length;
      const nextThematicBreakIndex = thematicBreakLineIndexes.find(
        (breakIndex) => breakIndex > heading.index && breakIndex < nextHeadingIndex
      );
      const endIndexExclusive = nextThematicBreakIndex ?? nextHeadingIndex;
      const endIndexInclusive = endIndexExclusive - 1;
      const sectionLines = lines.slice(heading.index, endIndexInclusive + 1);
      const rawContent = sectionLines.join("\n");
      const editableContent = stripNonEditableBlocks(rawContent);
      const hasDataviewCode = /```dataview(?:js)?\b/i.test(rawContent);
      const hasTemplaterCode = /<%[\s\S]*?%>/.test(rawContent) || /```templater\b/i.test(rawContent);
      const hasInlineFields = hasDataviewInlineField(editableContent);
      const hasListEntries = /^\s*>?\s*-\s+.+[：:]/m.test(editableContent);
      const fieldNames = fieldScanner.scanFields(editableContent).map((field) => field.name);
      const kind = detectSectionKind(
        heading.title,
        rawContent,
        hasDataviewCode,
        hasInlineFields,
        hasListEntries
      );

      sections.push({
        id: `section-${slugifySectionTitle(heading.title)}`,
        title: heading.title,
        startLine: heading.index + 1,
        endLine: endIndexInclusive + 1,
        rawContent,
        hasDataviewCode,
        hasTemplaterCode,
        hasInlineFields,
        hasListEntries,
        fieldNames,
        kind,
        suggestedMode: suggestSectionMode(kind, heading.title)
      });
    });

    return sections;
  }
}
