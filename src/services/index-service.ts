import { App, TFile, normalizePath } from "obsidian";

import { rewriteManagedIndexContent } from "../utils/managed-index-content";

function basenameFromPath(notePath: string): string {
  const normalizedPath = normalizePath(notePath.trim());
  const filename = normalizedPath.includes("/")
    ? normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1)
    : normalizedPath;

  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

export class IndexService {
  constructor(private readonly app: App) {}

  async upsertLinkEntry(params: {
    indexNotePath: string;
    createdNotePath: string;
    sourceNotePath: string;
  }): Promise<boolean> {
    const normalizedPath = normalizePath(params.indexNotePath.trim());
    if (!normalizedPath) {
      return false;
    }

    const indexFile = await this.getOrCreateIndexFile(normalizedPath);
    const currentContent = await this.app.vault.cachedRead(indexFile);
    const nextContent = rewriteManagedIndexContent(currentContent, {
      entryToAdd: {
        createdNoteBasename: basenameFromPath(params.createdNotePath),
        sourceNoteBasename: basenameFromPath(params.sourceNotePath)
      },
      doesManagedEntryTargetExist: (entry) =>
        this.app.metadataCache.getFirstLinkpathDest(entry.createdNoteBasename, indexFile.path) !== null
    });

    if (nextContent !== currentContent) {
      await this.app.vault.modify(indexFile, nextContent);
    }

    return true;
  }

  async removeLinkEntry(params: {
    indexNotePath: string;
    createdNotePath: string;
    sourceNotePath: string;
  }): Promise<boolean> {
    const normalizedPath = normalizePath(params.indexNotePath.trim());
    if (!normalizedPath) {
      return false;
    }

    const indexFile = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!(indexFile instanceof TFile)) {
      return false;
    }

    const currentContent = await this.app.vault.cachedRead(indexFile);
    const nextContent = rewriteManagedIndexContent(currentContent, {
      entryToRemove: {
        createdNoteBasename: basenameFromPath(params.createdNotePath),
        sourceNoteBasename: basenameFromPath(params.sourceNotePath)
      }
    });

    if (nextContent !== currentContent) {
      await this.app.vault.modify(indexFile, nextContent);
    }

    return true;
  }

  private async getOrCreateIndexFile(indexNotePath: string): Promise<TFile> {
    const folderPath = indexNotePath.includes("/")
      ? indexNotePath.slice(0, indexNotePath.lastIndexOf("/"))
      : "";

    if (folderPath) {
      await this.ensureFolderExists(folderPath);
    }

    let indexFile = this.app.vault.getAbstractFileByPath(indexNotePath);
    if (!indexFile) {
      indexFile = await this.app.vault.create(indexNotePath, "");
    }

    if (!(indexFile instanceof TFile)) {
      throw new Error("Index note path must point to a Markdown file.");
    }

    return indexFile;
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const segments = folderPath
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    let currentPath = "";
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(currentPath)) {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }
}
