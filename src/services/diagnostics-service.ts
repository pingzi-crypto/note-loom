import type { App } from "obsidian";

import type { SettingsService } from "./settings-service";
import type { TemplateConfig } from "../types/template";
import { normalizePathCompatible } from "../utils/path-normalizer";

export type DiagnosticsEventStatus = "info" | "success" | "warning" | "error";

export interface DiagnosticsEvent {
  event: string;
  status?: DiagnosticsEventStatus;
  message?: string;
  data?: Record<string, unknown>;
}

export interface DiagnosticsEventRecord extends DiagnosticsEvent {
  time: string;
  plugin: "note-loom" | "template-extractor";
}

export interface DiagnosticsExportResult {
  path: string;
  eventCount: number;
}

const DIAGNOSTICS_FOLDER = "Note Loom Diagnostics";
const LEGACY_DIAGNOSTICS_FOLDER = "Template Extractor Diagnostics";
const LOG_PATH = `${DIAGNOSTICS_FOLDER}/diagnostics.jsonl`;
const LEGACY_LOG_PATH = `${LEGACY_DIAGNOSTICS_FOLDER}/diagnostics.jsonl`;
const EXPORT_EVENT_LIMIT = 500;
const LOG_EVENT_LIMIT = EXPORT_EVENT_LIMIT;

function toTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function normalizeError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return {
    name: "UnknownError",
    message: stringifyUnknownError(error)
  };
}

function stringifyUnknownError(error: unknown): string {
  if (error === null || error === undefined) {
    return "";
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error) ?? "";
  } catch {
    if (typeof error === "object") {
      const message = (error as { message?: unknown })?.message;
      return typeof message === "string" ? message : "[unserializable error]";
    }

    if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
      return error.toString();
    }

    return "[unserializable error]";
  }
}

function sanitizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return normalizeError(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((next, [key, item]) => {
    if (/content|sourceText|templateContent|previewContent|noteBody|body|raw/i.test(key)) {
      next[key] = "[redacted]";
      return next;
    }

    next[key] = sanitizeValue(item);
    return next;
  }, {});
}

function summarizeTemplate(template: TemplateConfig): Record<string, unknown> {
  const sections = template.sectionConfig ?? [];
  return {
    id: template.id,
    name: template.name,
    path: template.path,
    enabled: template.enabled,
    fieldCount: template.fields.length,
    sectionCount: sections.length,
    generatedSectionCount: sections.filter((section) => section.mode === "generate").length,
    sectionModes: sections.reduce<Record<string, number>>((counts, section) => {
      counts[section.mode] = (counts[section.mode] ?? 0) + 1;
      return counts;
    }, {}),
    parserIds: sections
      .map((section) => section.behavior?.kind === "repeatable_text" ? section.behavior.parserId : undefined)
      .filter(Boolean)
  };
}

function appendBoundedJsonl(existing: string, record: DiagnosticsEventRecord): string {
  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const boundedLines = [...lines, JSON.stringify(record)].slice(-LOG_EVENT_LIMIT);
  return `${boundedLines.join("\n")}\n`;
}

async function readIfExists(adapter: App["vault"]["adapter"], path: string): Promise<string> {
  const normalizedPath = normalizePathCompatible(path);
  return await adapter.exists(normalizedPath) ? await adapter.read(normalizedPath) : "";
}

export class DiagnosticsService {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: App,
    private readonly settingsService: SettingsService,
    private readonly now: () => Date = () => new Date()
  ) {}

  async record(event: DiagnosticsEvent): Promise<void> {
    if (!this.settingsService.getSettings().diagnosticsEnabled) {
      return;
    }

    const record: DiagnosticsEventRecord = {
      plugin: "note-loom",
      time: this.now().toISOString(),
      event: event.event,
      status: event.status ?? "info",
      message: event.message,
      data: sanitizeValue(event.data) as Record<string, unknown> | undefined
    };

    this.writeQueue = this.writeQueue.then(
      () => this.writeRecord(record),
      () => this.writeRecord(record)
    );
    await this.writeQueue;
  }

  async exportPackage(): Promise<DiagnosticsExportResult> {
    await this.writeQueue;
    await this.ensureDiagnosticsFolder();
    const adapter = this.app.vault.adapter;
    const rawLog = [
      await readIfExists(adapter, LEGACY_LOG_PATH),
      await readIfExists(adapter, LOG_PATH)
    ].filter(Boolean).join("\n");
    const events = rawLog
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as DiagnosticsEventRecord;
        } catch {
          return null;
        }
      })
      .filter((event): event is DiagnosticsEventRecord => event !== null)
      .slice(-EXPORT_EVENT_LIMIT);
    const settings = this.settingsService.getSettings();
    const payload = {
      exportedAt: this.now().toISOString(),
      note: "Local-only diagnostic package. It includes configuration summaries, template names/paths, note paths, and recent event metadata. It intentionally excludes source note text, template content, preview content, and generated note body.",
      settings: {
        schemaVersion: settings.schemaVersion,
        language: settings.language,
        templateRootFolder: settings.templateRootFolder,
        defaultOutputPath: settings.defaultOutputPath,
        writeSourceMetadata: settings.writeSourceMetadata,
        writeIndexEntry: settings.writeIndexEntry,
        openGeneratedNote: settings.openGeneratedNote,
        enableAliasMatching: settings.enableAliasMatching,
        unmatchedFieldsStartEnabled: settings.unmatchedFieldsStartEnabled,
        diagnosticsEnabled: settings.diagnosticsEnabled,
        templateCount: settings.templates.length
      },
      templates: settings.templates.map(summarizeTemplate),
      events
    };
    const exportPath = await this.resolveUniqueExportPath(
      normalizePathCompatible(`${DIAGNOSTICS_FOLDER}/diagnostics-${toTimestamp(this.now())}.json`)
    );
    await adapter.write(exportPath, JSON.stringify(payload, null, 2));
    await this.record({
      event: "diagnostics.exported",
      status: "success",
      data: {
        path: exportPath,
        eventCount: events.length
      }
    });
    return {
      path: exportPath,
      eventCount: events.length
    };
  }

  async clear(): Promise<void> {
    await this.writeQueue;
    const adapter = this.app.vault.adapter;
    const logPath = normalizePathCompatible(LOG_PATH);
    if (await adapter.exists(logPath)) {
      await adapter.remove(logPath);
    }
    const legacyLogPath = normalizePathCompatible(LEGACY_LOG_PATH);
    if (await adapter.exists(legacyLogPath)) {
      await adapter.remove(legacyLogPath);
    }
  }

  private async writeRecord(record: DiagnosticsEventRecord): Promise<void> {
    try {
      await this.ensureDiagnosticsFolder();
      const adapter = this.app.vault.adapter;
      const normalizedPath = normalizePathCompatible(LOG_PATH);
      const existing = await adapter.exists(normalizedPath)
        ? await adapter.read(normalizedPath)
        : "";
      await adapter.write(normalizedPath, appendBoundedJsonl(existing, record));
    } catch (error) {
      console.warn("Note Loom: failed to write local diagnostics.", error);
    }
  }

  private async resolveUniqueExportPath(basePath: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(basePath))) {
      return basePath;
    }

    const extensionIndex = basePath.lastIndexOf(".");
    const name = extensionIndex >= 0 ? basePath.slice(0, extensionIndex) : basePath;
    const extension = extensionIndex >= 0 ? basePath.slice(extensionIndex) : "";
    let index = 2;
    while (true) {
      const candidate = `${name}-${index}${extension}`;
      if (!(await adapter.exists(candidate))) {
        return candidate;
      }
      index += 1;
    }
  }

  private async ensureDiagnosticsFolder(): Promise<void> {
    const folderPath = normalizePathCompatible(DIAGNOSTICS_FOLDER);
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(folderPath))) {
      await adapter.mkdir(folderPath);
    }
  }
}
