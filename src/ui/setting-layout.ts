import { Setting } from "obsidian";

// Shared Setting-row skeleton used across settings and modals.
// This file owns the base card/info/control split so pages do not recreate
// another left-right layout with page-local classes.

export function markCardSetting(setting: Setting): Setting {
  setting.settingEl.addClass("note-loom-card-row");
  setting.infoEl.addClass("note-loom-card-info");
  setting.controlEl.addClass("note-loom-card-control");
  return setting;
}

export function markInfoStackSetting(setting: Setting): Setting {
  markCardSetting(setting);
  setting.infoEl.addClass("note-loom-info-stack");
  setting.descEl.addClass("note-loom-info-stack-desc");
  return setting;
}

export function markSingleLeftSetting(setting: Setting): Setting {
  markCardSetting(setting);
  setting.settingEl.addClass("note-loom-card-row-single-left");
  return setting;
}

export function markSingleRightSetting(setting: Setting): Setting {
  markCardSetting(setting);
  setting.settingEl.addClass("note-loom-card-row-single-right");
  return setting;
}

export type FieldRowLayoutMode = "toggle-primary" | "actions" | "primary" | "full";

export function markFieldRowSetting(setting: Setting): Setting {
  setting.settingEl.addClass("note-loom-field-row");
  return setting;
}

export function applyFieldRowLayout(element: HTMLElement, mode: FieldRowLayoutMode): void {
  element.toggleClass("note-loom-field-row-layout-toggle-primary", mode === "toggle-primary");
  element.toggleClass("note-loom-field-row-layout-actions", mode === "actions");
  element.toggleClass("note-loom-field-row-layout-primary", mode === "primary");
}
