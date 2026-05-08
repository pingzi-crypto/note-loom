import { Setting } from "obsidian";

import {
  markFieldRowSetting,
  markInfoStackSetting,
  markSingleLeftSetting,
  markSingleRightSetting
} from "./setting-layout";
import {
  bindFolderOptionsRefresh,
  bindNoteOptionsRefresh,
  markPathSetting,
  type FolderEmptyLabelKey,
  type NoteEmptyLabelKey
} from "./path-dropdown";
import type { PluginLanguage } from "../types/settings";

// Canonical UI entrypoint for shared settings-style layout helpers.
// Any new card row, info/control split, or vault path selector should first
// be checked here together with docs/15 and docs/18 before adding local UI code.

export {
  applyFieldRowLayout,
  type FieldRowLayoutMode,
  markFieldRowSetting,
  markCardSetting,
  markInfoStackSetting,
  markSingleLeftSetting,
  markSingleRightSetting
} from "./setting-layout";
export {
  createModalActionFooter,
  type ModalActionButton,
  type ModalActionFooterOptions,
  createModalFooter,
  createModalHeading,
  createModalSection,
  createModalTitle,
  createSettingGroup,
  prepareModalShell
} from "./ui-shell";
export {
  addFolderOptions,
  addNoteOptions,
  bindFolderOptionsRefresh,
  bindNoteOptionsRefresh,
  markPathSetting,
  resolveFolderDropdownValue,
  resolveNoteDropdownValue
} from "./path-dropdown";

export function createInfoSetting(container: HTMLElement): Setting {
  return markInfoStackSetting(new Setting(container));
}

export function createSingleLeftInfoSetting(container: HTMLElement): Setting {
  return markSingleLeftSetting(createInfoSetting(container));
}

export function createSingleRightInfoSetting(container: HTMLElement): Setting {
  return markSingleRightSetting(createInfoSetting(container));
}

export function createSingleLeftNoteRow(
  container: HTMLElement,
  text: string,
  ...classes: string[]
): Setting {
  const setting = createSingleLeftInfoSetting(container);
  setting.settingEl.addClass("note-loom-note-row");
  classes.forEach((className) => setting.settingEl.addClass(className));
  setting.setName(text);
  setting.nameEl.addClass("note-loom-note-row-text");
  return setting;
}

export function createPathSettingRow(container: HTMLElement): Setting {
  return markPathSetting(createInfoSetting(container));
}

interface PathDropdownSettingOptions<EmptyLabelKey extends string> {
  name: string;
  getLanguage: () => PluginLanguage;
  getPaths: () => string[];
  emptyLabelKey: EmptyLabelKey;
  getCurrentValue: () => string;
  onChange: (value: string) => void | Promise<void>;
  classNames?: string[];
  resetButton?: {
    label: string;
    onClick: () => void | Promise<void>;
  };
}

function addPathSettingResetButton(
  setting: Setting,
  resetButton: PathDropdownSettingOptions<string>["resetButton"]
): Setting {
  if (!resetButton) {
    return setting;
  }

  return setting.addButton((button) =>
    button.setButtonText(resetButton.label).onClick(() => {
      void resetButton.onClick();
    })
  );
}

export function createFolderPathDropdownSetting(
  container: HTMLElement,
  options: PathDropdownSettingOptions<FolderEmptyLabelKey>
): Setting {
  const setting = createPathSettingRow(container);
  options.classNames?.forEach((className) => setting.settingEl.addClass(className));

  setting.setName(options.name).addDropdown((dropdown) => {
    bindFolderOptionsRefresh(
      dropdown,
      options.getLanguage,
      options.getPaths,
      options.emptyLabelKey,
      options.getCurrentValue
    );
    dropdown.onChange((value) => {
      void options.onChange(value);
    });
  });

  return addPathSettingResetButton(setting, options.resetButton);
}

export function createNotePathDropdownSetting(
  container: HTMLElement,
  options: PathDropdownSettingOptions<NoteEmptyLabelKey>
): Setting {
  const setting = createPathSettingRow(container);
  options.classNames?.forEach((className) => setting.settingEl.addClass(className));

  setting.setName(options.name).addDropdown((dropdown) => {
    bindNoteOptionsRefresh(
      dropdown,
      options.getLanguage,
      options.getPaths,
      options.emptyLabelKey,
      options.getCurrentValue
    );
    dropdown.onChange((value) => {
      void options.onChange(value);
    });
  });

  return addPathSettingResetButton(setting, options.resetButton);
}

export function createFieldRowSetting(container: HTMLElement): Setting {
  return markFieldRowSetting(new Setting(container));
}
