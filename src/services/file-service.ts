import { App, TFile, TFolder, normalizePath } from "obsidian";

import { fallbackFilename, sanitizeFilename } from "../utils/filename";

function splitFolderSegments(folderPath: string): string[] {
  return normalizePath(folderPath)
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export class FileService {
  constructor(private readonly app: App) {}

  isPathInsideVault(path: string): boolean {
    const normalized = normalizePath(path.trim());
    return (
      !/^[A-Za-z]:/.test(normalized) &&
      !normalized.startsWith("/") &&
      normalized !== ".." &&
      !normalized.startsWith("../")
    );
  }

  async ensureFolderExists(folderPath: string): Promise<void> {
    const normalizedFolderPath = normalizePath(folderPath.trim());
    if (!normalizedFolderPath) {
      return;
    }

    const segments = splitFolderSegments(normalizedFolderPath);
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);
      if (existing instanceof TFolder) {
        continue;
      }

      if (existing instanceof TFile) {
        throw new Error(`Path conflict: ${currentPath} is a file.`);
      }

      await this.app.vault.createFolder(currentPath);
    }
  }

  async resolveUniqueNotePath(folderPath: string, filename: string): Promise<string> {
    const safeFilename = sanitizeFilename(filename) || fallbackFilename(new Date());
    const normalizedFolderPath = normalizePath(folderPath.trim());
    let attempt = 0;

    while (attempt < 1000) {
      const suffix = attempt === 0 ? "" : ` ${attempt}`;
      const noteName = `${safeFilename}${suffix}.md`;
      const notePath = normalizedFolderPath ? `${normalizedFolderPath}/${noteName}` : noteName;

      if (!this.app.vault.getAbstractFileByPath(notePath)) {
        return notePath;
      }

      attempt += 1;
    }

    throw new Error("Unable to resolve a unique note path.");
  }

  async createNote(notePath: string, content: string): Promise<TFile> {
    return this.app.vault.create(normalizePath(notePath), content);
  }

  async updateNote(file: TFile, content: string): Promise<void> {
    await this.app.vault.modify(file, content);
  }
}
