import type { PluginSettings } from "./types/settings";

export const PLUGIN_ID = "note-loom";
export const CURRENT_SETTINGS_SCHEMA_VERSION = 5;
export const GENERATE_COMMAND_ID = "generate-structured-note-from-current-note";
export const RIBBON_ICON = "note-loom-ribbon";
export const RIBBON_ICON_SVG =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M24 14h36l16 16v56H24z"/><path fill="var(--background-primary)" d="M34 26h22v16h16v38H34z"/><path fill="currentColor" d="M60 14v20h20z"/><path fill="currentColor" d="M40 53h20v6H40zm0 12h20v6H40z"/><path fill="currentColor" d="M70 50l2.6 5.4L78 58l-5.4 2.6L70 66l-2.6-5.4L62 58l5.4-2.6z"/></svg>';

export const DEFAULT_SETTINGS: PluginSettings = {
  schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
  language: "auto",
  templateRootFolder: "",
  templates: [],
  defaultOutputPath: "",
  defaultIndexNotePath: "",
  defaultFilenameField: "",
  writeSourceMetadata: true,
  writeIndexEntry: true,
  openGeneratedNote: true,
  enableAliasMatching: true,
  unmatchedFieldsStartEnabled: true,
  showRibbonIcon: true,
  diagnosticsEnabled: false,
  managedIndexEntries: []
};
