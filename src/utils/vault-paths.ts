import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";

function sortPaths(paths: string[]): string[] {
  return [...paths].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function collectFromFolder(folder: TFolder, files: TAbstractFile[]): void {
  files.push(folder);
  for (const child of folder.children) {
    if (child instanceof TFolder) {
      collectFromFolder(child, files);
    } else {
      files.push(child);
    }
  }
}

export function getVaultFolderPaths(app: App): string[] {
  const allFiles: TAbstractFile[] = [];
  collectFromFolder(app.vault.getRoot(), allFiles);

  const folders = allFiles
    .filter((item): item is TFolder => item instanceof TFolder)
    .map((folder) => normalizePath(folder.path))
    .filter((path) => path.length > 0);

  return sortPaths(folders);
}

export function getVaultMarkdownPaths(app: App): string[] {
  const allFiles: TAbstractFile[] = [];
  collectFromFolder(app.vault.getRoot(), allFiles);

  const notes = allFiles
    .filter(
      (item): item is TFile =>
        item instanceof TFile && (item.extension === "md" || item.extension === "")
    )
    .map((file) => normalizePath(file.path));

  return sortPaths(notes);
}
