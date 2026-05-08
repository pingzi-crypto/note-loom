import type { TemplateFieldKind } from "./template";

export interface TemplateFieldRule {
  aliases?: string[];
  semanticTriggers?: string[];
  normalizerKey?: string;
  kind?: TemplateFieldKind;
  checkboxOptions?: string[];
}
