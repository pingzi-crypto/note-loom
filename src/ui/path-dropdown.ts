import { Setting } from "obsidian";
import type { DropdownComponent } from "obsidian";

import { t } from "../i18n";
import type { PluginLanguage } from "../types/settings";

// Shared vault path / note dropdown behavior entry.
// Any selector that reads folders or notes from the vault should extend this
// helper instead of adding page-local refresh or stale-value logic.

export type FolderEmptyLabelKey = "root_label" | "inherits_global_default";
export type NoteEmptyLabelKey =
  | "none_label"
  | "no_index_label"
  | "use_template_default_index"
  | "inherits_global_default"
  | "select_template_file_label"
  | "select_index_note_label";

type DropdownLike = Pick<DropdownComponent, "selectEl" | "addOption" | "setValue">;

export function resolveFolderDropdownValue(
  value: string,
  paths: string[]
): string {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0 || normalizedValue === "/") {
    return "";
  }

  return paths.includes(normalizedValue) ? normalizedValue : "";
}

export function resolveNoteDropdownValue(
  value: string,
  paths: string[]
): string {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    return "";
  }

  return paths.includes(normalizedValue) ? normalizedValue : "";
}

export function markPathSetting(setting: Setting): Setting {
  setting.settingEl.addClass("note-loom-path-setting");
  return setting;
}

function clearDropdownOptions(dropdown: DropdownLike): void {
  const selectEl = dropdown.selectEl;
  selectEl.innerHTML = "";
}

export function addFolderOptions(
  dropdown: DropdownLike,
  language: PluginLanguage,
  paths: string[],
  emptyLabelKey: FolderEmptyLabelKey
): void {
  clearDropdownOptions(dropdown);
  dropdown.addOption("", t(language, emptyLabelKey));
  paths.forEach((path) => {
    if (path === "/" || path === "") {
      return;
    }

    dropdown.addOption(path, path);
  });
}

export function addNoteOptions(
  dropdown: DropdownLike,
  language: PluginLanguage,
  paths: string[],
  emptyLabelKey: NoteEmptyLabelKey
): void {
  clearDropdownOptions(dropdown);
  dropdown.addOption("", t(language, emptyLabelKey));
  paths.forEach((path) => {
    dropdown.addOption(path, path);
  });
}

export function bindFolderOptionsRefresh(
  dropdown: DropdownLike,
  getLanguage: () => PluginLanguage,
  getPaths: () => string[],
  emptyLabelKey: FolderEmptyLabelKey,
  getCurrentValue: () => string
): void {
  const refresh = () => {
    const paths = getPaths();
    addFolderOptions(dropdown, getLanguage(), paths, emptyLabelKey);
    dropdown.setValue(resolveFolderDropdownValue(getCurrentValue(), paths));
  };

  refresh();
  const selectEl = dropdown.selectEl;
  selectEl.addEventListener("pointerdown", refresh);
  selectEl.addEventListener("focus", refresh);
}

export function bindNoteOptionsRefresh(
  dropdown: DropdownLike,
  getLanguage: () => PluginLanguage,
  getPaths: () => string[],
  emptyLabelKey: NoteEmptyLabelKey,
  getCurrentValue: () => string
): void {
  const refresh = () => {
    const paths = getPaths();
    addNoteOptions(dropdown, getLanguage(), paths, emptyLabelKey);
    dropdown.setValue(resolveNoteDropdownValue(getCurrentValue(), paths));
  };

  refresh();
  const selectEl = dropdown.selectEl;
  selectEl.addEventListener("pointerdown", refresh);
  selectEl.addEventListener("focus", refresh);
}
