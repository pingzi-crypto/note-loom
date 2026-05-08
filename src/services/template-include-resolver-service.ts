import type { App } from "obsidian";

import { normalizePathCompatible } from "../utils/path-normalizer";

export interface ResolvedTemplateContent {
  rawContent: string;
  resolvedContent: string;
  includePaths: string[];
  unresolvedIncludes: string[];
}

const INCLUDE_BLOCK_PATTERN =
  /<%[-_=*]?\s*(?:await\s+)?tp\.file\.include\(\s*(["'])(.*?)\1\s*\)\s*;?\s*%>/g;
const MAX_INCLUDE_DEPTH = 6;

function stripWikiLinkDecorators(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith("[[") && normalized.endsWith("]]")) {
    normalized = normalized.slice(2, -2).trim();
  }

  const aliasIndex = normalized.indexOf("|");
  if (aliasIndex >= 0) {
    normalized = normalized.slice(0, aliasIndex).trim();
  }

  const headingIndex = normalized.indexOf("#");
  if (headingIndex >= 0) {
    normalized = normalized.slice(0, headingIndex).trim();
  }

  return normalized;
}

function ensureMarkdownPath(value: string): string {
  return /\.md$/i.test(value) ? value : `${value}.md`;
}

function getParentFolder(path: string): string {
  const normalized = normalizePathCompatible(path);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(0, slashIndex) : "";
}

function isMarkdownFileLike(value: unknown): value is { path: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { path?: unknown }).path === "string" &&
    /\.md$/i.test((value as { path: string }).path)
  );
}

export class TemplateIncludeResolverService {
  constructor(private readonly app: App) {}

  async resolveTemplate(filePath: string, rawContent: string): Promise<ResolvedTemplateContent> {
    const includePaths = new Set<string>();
    const unresolvedIncludes = new Set<string>();
    const resolvedContent = await this.expandIncludes(
      normalizePathCompatible(filePath),
      rawContent,
      0,
      new Set<string>(),
      includePaths,
      unresolvedIncludes
    );

    return {
      rawContent,
      resolvedContent,
      includePaths: Array.from(includePaths),
      unresolvedIncludes: Array.from(unresolvedIncludes)
    };
  }

  private async expandIncludes(
    currentPath: string,
    content: string,
    depth: number,
    visiting: Set<string>,
    includePaths: Set<string>,
    unresolvedIncludes: Set<string>
  ): Promise<string> {
    if (depth >= MAX_INCLUDE_DEPTH) {
      return content;
    }

    const matches = Array.from(content.matchAll(INCLUDE_BLOCK_PATTERN));
    if (matches.length === 0) {
      return content;
    }

    let nextContent = content;
    for (const match of matches) {
      const fullMatch = match[0] ?? "";
      const rawReference = match[2] ?? "";
      const resolvedPath = this.resolveIncludePath(currentPath, rawReference);
      if (!resolvedPath) {
        unresolvedIncludes.add(rawReference.trim());
        continue;
      }

      if (visiting.has(resolvedPath)) {
        unresolvedIncludes.add(rawReference.trim());
        continue;
      }

      const target = this.app.vault.getAbstractFileByPath(resolvedPath);
      if (!isMarkdownFileLike(target)) {
        unresolvedIncludes.add(rawReference.trim());
        continue;
      }

      includePaths.add(resolvedPath);
      visiting.add(resolvedPath);
      const targetContent = await this.app.vault.cachedRead(target as never);
      const expanded = await this.expandIncludes(
        resolvedPath,
        targetContent,
        depth + 1,
        visiting,
        includePaths,
        unresolvedIncludes
      );
      visiting.delete(resolvedPath);
      nextContent = nextContent.replace(fullMatch, expanded);
    }

    return nextContent;
  }

  private resolveIncludePath(currentPath: string, reference: string): string | null {
    const normalizedReference = stripWikiLinkDecorators(reference);
    if (!normalizedReference) {
      return null;
    }

    const currentFolder = getParentFolder(currentPath);
    const rootCandidate = ensureMarkdownPath(normalizePathCompatible(normalizedReference));
    const candidatePaths = new Set<string>();

    if (/^\.{1,2}\//.test(normalizedReference)) {
      candidatePaths.add(ensureMarkdownPath(normalizePathCompatible(`${currentFolder}/${normalizedReference}`)));
    } else if (normalizedReference.includes("/")) {
      candidatePaths.add(rootCandidate);
      candidatePaths.add(ensureMarkdownPath(normalizePathCompatible(`${currentFolder}/${normalizedReference}`)));
    } else {
      candidatePaths.add(ensureMarkdownPath(normalizePathCompatible(`${currentFolder}/${normalizedReference}`)));
      candidatePaths.add(rootCandidate);
    }

    for (const candidate of candidatePaths) {
      const target = this.app.vault.getAbstractFileByPath(candidate);
      if (isMarkdownFileLike(target)) {
        return normalizePathCompatible(target.path);
      }
    }

    const basename = ensureMarkdownPath(normalizedReference).replace(/^.*\//, "").replace(/\.md$/i, "");
    const matchedFiles = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.basename === basename);
    const [singleMatch] = matchedFiles;
    if (matchedFiles.length === 1 && singleMatch) {
      return normalizePathCompatible(singleMatch.path);
    }

    return null;
  }
}
