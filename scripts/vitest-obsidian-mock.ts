export class App {}

export class ButtonComponent {}

export class DropdownComponent {}

export class ExtraButtonComponent {}

export class Modal {}

export class Notice {
  constructor(readonly message: string) {}
}

export class Plugin {}

export class PluginSettingTab {}

export class Setting {}

export class TAbstractFile {
  constructor(readonly path = "") {}
}

export class TFile extends TAbstractFile {
  constructor(path = "", readonly extension = "") {
    super(path);
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export function addIcon(): void {}

export function getLanguage(): string {
  return "en";
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}
