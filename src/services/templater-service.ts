import type { App, TFile } from "obsidian";

const TEMPLATER_PLUGIN_ID = "templater-obsidian";

type TemplaterPlugin = {
  templater?: {
    overwrite_file_commands?: (file: TFile, openAfter?: boolean) => Promise<void>;
  };
};

type AppWithPlugins = App & {
  plugins?: {
    plugins?: Record<string, unknown>;
  };
};

type AppWithVaultWrite = App & {
  vault?: {
    modify?: (file: TFile, content: string) => Promise<void>;
    read?: (file: TFile) => Promise<string>;
  };
};

type DateProvider = () => Date;

type StaticTemplaterRenderResult = {
  rendered: string;
  replacedCount: number;
  unsupportedExpressions: string[];
};

export interface TemplaterProcessResult {
  processed: boolean;
  pluginProcessed: boolean;
  replacedCount: number;
  unsupportedExpressions: string[];
  requiresReview: boolean;
}

const EMPTY_TEMPLATER_PROCESS_RESULT: TemplaterProcessResult = {
  processed: false,
  pluginProcessed: false,
  replacedCount: 0,
  unsupportedExpressions: [],
  requiresReview: false
};

function buildTemplaterProcessResult(params: {
  processed?: boolean;
  pluginProcessed?: boolean;
  replacedCount?: number;
  unsupportedExpressions?: string[];
}): TemplaterProcessResult {
  const unsupportedExpressions = Array.from(new Set(params.unsupportedExpressions ?? []));
  return {
    processed: params.processed ?? false,
    pluginProcessed: params.pluginProcessed ?? false,
    replacedCount: params.replacedCount ?? 0,
    unsupportedExpressions,
    requiresReview: unsupportedExpressions.length > 0
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function resolveLocale(locale?: string): string {
  return locale?.toLowerCase() === "zh-cn" ? "zh-CN" : "en-US";
}

function isoWeek(date: Date): number {
  const current = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = current.getUTCDay() || 7;
  current.setUTCDate(current.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));
  return Math.ceil(((current.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function isoWeekYear(date: Date): number {
  const current = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = current.getUTCDay() || 7;
  current.setUTCDate(current.getUTCDate() + 4 - day);
  return current.getUTCFullYear();
}

function formatDate(date: Date, format: string, locale?: string): string {
  const literals: string[] = [];
  const literalProtectedFormat = format.replace(/\[([^\]]+)\]/g, (_match, literal: string) => {
    const token = `\u0000${literals.length}\u0000`;
    literals.push(literal);
    return token;
  });

  return literalProtectedFormat
    .replace(/GGGG/g, String(isoWeekYear(date)))
    .replace(/WW/g, pad2(isoWeek(date)))
    .replace(/YYYY/g, String(date.getFullYear()))
    .replace(/MM/g, pad2(date.getMonth() + 1))
    .replace(/DD/g, pad2(date.getDate()))
    .replace(/HH/g, pad2(date.getHours()))
    .replace(/mm/g, pad2(date.getMinutes()))
    .replace(/ss/g, pad2(date.getSeconds()))
    .replace(/dddd/g, new Intl.DateTimeFormat(resolveLocale(locale), { weekday: "long" }).format(date))
    .replace(new RegExp(`${String.fromCharCode(0)}(\\d+)${String.fromCharCode(0)}`, "g"), (_match, index: string) => literals[Number(index)] ?? "");
}

function splitOutsideSyntax(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  let depth = 0;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = quote !== null;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  parts.push(current.trim());
  return parts;
}

function unquoteStringLiteral(value: string): string | null {
  const match = value.match(/^(["'])([\s\S]*)\1$/);
  if (!match?.[1]) {
    return null;
  }

  const quote = match[1];
  const body = match[2] ?? "";
  return body
    .replace(new RegExp(`\\\\${quote}`, "g"), quote)
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

function evaluateSupportedAtom(expression: string, date: Date, locale?: string): string | null {
  const trimmed = expression.trim();
  const stringLiteral = unquoteStringLiteral(trimmed);
  if (stringLiteral !== null) {
    return stringLiteral;
  }

  const dateNowMatch = trimmed.match(/^tp\.date\.now\((["'])([^"']+)\1\)$/);
  if (dateNowMatch?.[2]) {
    return formatDate(date, dateNowMatch[2], locale);
  }

  const isoWeekMatch = trimmed.match(/^(?:window\.)?moment\(\)\.isoWeek\(\)$/);
  if (isoWeekMatch) {
    return String(isoWeek(date));
  }

  const momentFormatMatch = trimmed.match(
    /^(?:window\.)?moment\(\)(?:\.locale\((["'])([^"']+)\1\))?\.format\((["'])([^"']+)\3\)$/
  );
  if (momentFormatMatch?.[4]) {
    return formatDate(date, momentFormatMatch[4], momentFormatMatch[2] ?? locale);
  }

  return null;
}

function evaluateSupportedConcatExpression(expression: string, date: Date, locale?: string): string | null {
  const parts = splitOutsideSyntax(expression, "+");
  if (parts.length === 0) {
    return null;
  }

  const renderedParts: string[] = [];
  for (const part of parts) {
    if (!part) {
      return null;
    }

    const rendered = evaluateSupportedAtom(part, date, locale);
    if (rendered === null) {
      return null;
    }

    renderedParts.push(rendered);
  }

  return renderedParts.join("");
}

function evaluateSupportedTemplaterExpression(expression: string, date: Date): string | null {
  const trimmed = expression.trim();
  const directResult = evaluateSupportedConcatExpression(trimmed, date);
  if (directResult !== null) {
    return directResult;
  }

  let locale: string | undefined;
  const statements = splitOutsideSyntax(trimmed, ";").filter(Boolean);
  if (statements.length === 0) {
    return null;
  }

  for (const statement of statements.slice(0, -1)) {
    const localeMatch = statement.match(/^(?:window\.)?moment\.locale\((["'])([^"']+)\1\)$/);
    if (!localeMatch?.[2]) {
      return null;
    }
    locale = localeMatch[2];
  }

  const outputStatement = statements.at(-1);
  if (!outputStatement) {
    return null;
  }

  const outputMatch = outputStatement.match(/^tR\s*\+=\s*([\s\S]+)$/);
  if (!outputMatch?.[1]) {
    return null;
  }

  return evaluateSupportedConcatExpression(outputMatch[1], date, locale);
}

function renderSupportedStaticTemplaterExpressions(content: string, date: Date): StaticTemplaterRenderResult {
  const unsupportedExpressions: string[] = [];
  let replacedCount = 0;
  const rendered = content.replace(/<%[-_=*]?([\s\S]+?)-?%>/g, (match, expression: string) => {
    const rendered = evaluateSupportedTemplaterExpression(expression, date);
    if (rendered === null) {
      unsupportedExpressions.push(expression.trim());
      return match;
    }

    replacedCount += 1;
    return rendered;
  });
  return { rendered, replacedCount, unsupportedExpressions };
}

const TEMPLATER_MARKER_PREFIX = "__TEMPLATE_EXTRACTOR_PROMPT_VALUE__";

function extractPromptAssignmentVariables(expression: string): string[] {
  const variables = new Set<string>();
  const assignmentRegex =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tp\.system\.(?:prompt|suggester|multi_suggester)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = assignmentRegex.exec(expression)) !== null) {
    const variableName = match[1]?.trim();
    if (variableName) {
      variables.add(variableName);
    }
  }

  return Array.from(variables);
}

function scopeTemplaterPromptVariables(content: string): string {
  const promptVariables = new Set<string>();

  content.replace(/<%\*([\s\S]+?)%>/g, (_match, expression: string) => {
    extractPromptAssignmentVariables(expression).forEach((variableName) => promptVariables.add(variableName));
    return "";
  });

  if (promptVariables.size === 0) {
    return content;
  }

  const buildMarker = (variableName: string): string => `${TEMPLATER_MARKER_PREFIX}${variableName}__`;

  const rewritten = content.replace(
    /<%([-_=*]?)([\s\S]+?)(-?)%>/g,
    (match, marker: string, expression: string, closingTrim: string) => {
    if (marker === "*") {
      const blockVariables = extractPromptAssignmentVariables(expression);
      if (blockVariables.length === 0) {
        return match;
      }

      const replacementLines = blockVariables.map((variableName) => {
        const markerText = JSON.stringify(buildMarker(variableName));
        return `nextContent = nextContent.split(${markerText}).join(String(${variableName} ?? ""));`;
      });
      const syncLines = [
        "const __noteLoomApplyPromptValues = async () => {",
        "  const targetFile = tp.config?.target_file ?? app.workspace?.getActiveFile?.();",
        "  if (!targetFile) return;",
        "  let nextContent = await app.vault.read(targetFile);",
        ...replacementLines.map((line) => `  ${line}`),
        "  await app.vault.modify(targetFile, nextContent);",
        "};",
        "if (tp.hooks?.on_all_templates_executed) {",
        "  tp.hooks.on_all_templates_executed(__noteLoomApplyPromptValues);",
        "} else {",
        "  setTimeout(__noteLoomApplyPromptValues, 0);",
        "}"
      ];
      const separator = expression.trimEnd().endsWith(";") ? "\n" : ";\n";
      return `<%*${expression}${separator}${syncLines.join("\n")}${closingTrim}%>`;
    }

    const trimmedExpression = expression.trim();
    if (!promptVariables.has(trimmedExpression)) {
      return match;
    }

    return buildMarker(trimmedExpression);
  }
  );

  return rewritten;
}

export class TemplaterService {
  constructor(private readonly app: App, private readonly now: DateProvider = () => new Date()) {}

  hasTemplateSyntax(content: string): boolean {
    return /<%[-_=*]?[\s\S]+?%>/.test(content);
  }

  async processCreatedFile(file: TFile, content: string): Promise<TemplaterProcessResult> {
    if (!this.hasTemplateSyntax(content)) {
      return EMPTY_TEMPLATER_PROCESS_RESULT;
    }

    const plugin = this.getTemplaterPlugin();
    const overwriteFile = plugin?.templater?.overwrite_file_commands;
    if (!overwriteFile) {
      return this.processSupportedStaticExpressions(file, content);
    }

    const scopedContent = scopeTemplaterPromptVariables(content);
    if (scopedContent !== content) {
      const modify = (this.app as AppWithVaultWrite).vault?.modify;
      if (modify) {
        await modify.call((this.app as AppWithVaultWrite).vault, file, scopedContent);
      }
    }

    await overwriteFile.call(plugin.templater, file, false);
    const fallbackResult = await this.processRemainingSupportedStaticExpressions(file, scopedContent);
    return buildTemplaterProcessResult({
      processed: true,
      pluginProcessed: true,
      replacedCount: fallbackResult.replacedCount,
      unsupportedExpressions: fallbackResult.unsupportedExpressions
    });
  }

  private getTemplaterPlugin(): TemplaterPlugin | null {
    const plugins = (this.app as AppWithPlugins).plugins?.plugins;
    const plugin = plugins?.[TEMPLATER_PLUGIN_ID];
    return plugin ? (plugin as TemplaterPlugin) : null;
  }

  private async processSupportedStaticExpressions(file: TFile, content: string): Promise<TemplaterProcessResult> {
    const result = renderSupportedStaticTemplaterExpressions(content, this.now());
    this.warnUnsupportedExpressions(file, result.unsupportedExpressions);
    if (result.replacedCount === 0 || result.rendered === content) {
      return buildTemplaterProcessResult({
        replacedCount: result.replacedCount,
        unsupportedExpressions: result.unsupportedExpressions
      });
    }

    const modify = (this.app as AppWithVaultWrite).vault?.modify;
    if (!modify) {
      return buildTemplaterProcessResult({
        replacedCount: result.replacedCount,
        unsupportedExpressions: result.unsupportedExpressions
      });
    }

    await modify.call((this.app as AppWithVaultWrite).vault, file, result.rendered);
    return buildTemplaterProcessResult({
      processed: true,
      replacedCount: result.replacedCount,
      unsupportedExpressions: result.unsupportedExpressions
    });
  }

  private async processRemainingSupportedStaticExpressions(
    file: TFile,
    fallbackContent: string
  ): Promise<TemplaterProcessResult> {
    const vault = (this.app as AppWithVaultWrite).vault;
    const content = vault?.read ? await vault.read(file) : fallbackContent;
    return this.processSupportedStaticExpressions(file, content);
  }

  private warnUnsupportedExpressions(file: TFile, expressions: string[]): void {
    if (expressions.length === 0) {
      return;
    }

    console.warn(
      `[note-loom] Unsupported Templater expressions remain in ${file.path}: ${expressions.join(" | ")}`
    );
  }
}
