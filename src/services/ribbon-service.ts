import type { Plugin } from "obsidian";

import { RIBBON_ICON } from "../constants";

export class RibbonService {
  private ribbonElement: HTMLElement | null = null;

  constructor(private readonly plugin: Plugin) {}

  sync(show: boolean, title: string, onClick: () => void): void {
    this.remove();

    if (!show) {
      return;
    }

    this.ribbonElement = this.plugin.addRibbonIcon(RIBBON_ICON, title, onClick);
  }

  remove(): void {
    this.ribbonElement?.detach();
    this.ribbonElement = null;
  }
}
