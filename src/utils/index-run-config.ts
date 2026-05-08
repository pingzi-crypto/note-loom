import type { PluginSettings } from "../types/settings";
import type { TemplateConfig } from "../types/template";

function trimPath(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function resolveTemplateDefaultIndexPath(
  template: Pick<TemplateConfig, "defaultIndexStrategy" | "defaultIndexNotePath">,
  settings: Pick<PluginSettings, "defaultIndexNotePath">
): string {
  if (template.defaultIndexStrategy === "disabled") {
    return "";
  }

  const templateIndexPath = trimPath(template.defaultIndexNotePath);
  const globalIndexPath = trimPath(settings.defaultIndexNotePath);

  return templateIndexPath || globalIndexPath;
}

export function resolveDefaultWriteIndexEntry(
  template: Pick<TemplateConfig, "defaultIndexStrategy" | "defaultIndexNotePath">,
  settings: Pick<PluginSettings, "defaultIndexNotePath" | "writeIndexEntry">
): boolean {
  if (!settings.writeIndexEntry || template.defaultIndexStrategy === "disabled") {
    return false;
  }

  return resolveTemplateDefaultIndexPath(template, settings).length > 0;
}

export function resolveEffectiveIndexPath(
  template: Pick<TemplateConfig, "defaultIndexStrategy" | "defaultIndexNotePath">,
  settings: Pick<PluginSettings, "defaultIndexNotePath">,
  options: {
    writeIndexEntry: boolean;
    overrideIndexNotePath: string;
  }
): string {
  if (!options.writeIndexEntry) {
    return "";
  }

  const overrideIndexNotePath = trimPath(options.overrideIndexNotePath);
  if (overrideIndexNotePath.length > 0) {
    return overrideIndexNotePath;
  }

  return resolveTemplateDefaultIndexPath(template, settings);
}
