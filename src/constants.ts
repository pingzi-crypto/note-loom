import type { PluginSettings } from "./types/settings";

export const PLUGIN_ID = "note-loom";
export const CURRENT_SETTINGS_SCHEMA_VERSION = 5;
export const GENERATE_COMMAND_ID = "generate-structured-note-from-current-note";
export const RIBBON_ICON = "note-loom-ribbon";
export const RIBBON_ICON_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h6"/><path d="M8 17h4"/><path d="m18 13 .7 1.3L20 15l-1.3.7L18 17l-.7-1.3L16 15l1.3-.7z"/></svg>';

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
