import type { TemplateConfig } from "./template";

export type PluginLanguage = "auto" | "zh" | "en";

export interface ManagedIndexEntryRecord {
  createdNotePath: string;
  indexNotePath: string;
  sourceNotePath: string;
}

export interface PluginSettings {
  schemaVersion: number;
  language: PluginLanguage;
  templateRootFolder: string;
  templates: TemplateConfig[];
  defaultOutputPath: string;
  defaultIndexNotePath: string;
  defaultFilenameField: string;
  writeSourceMetadata: boolean;
  writeIndexEntry: boolean;
  openGeneratedNote: boolean;
  enableAliasMatching: boolean;
  unmatchedFieldsStartEnabled: boolean;
  showRibbonIcon: boolean;
  diagnosticsEnabled: boolean;
  managedIndexEntries: ManagedIndexEntryRecord[];
}
