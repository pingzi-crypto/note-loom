import { App, normalizePath, TFile, TFolder } from "obsidian";

import type { TemplateConfig, ScannedTemplateField, TemplateSectionConfig } from "../types/template";
import { resolveTemplateFilenameField } from "../utils/template-filename-field";
import { createTemplateId } from "../utils/template-id";
import { SettingsService } from "./settings-service";
import { buildStructuralMappingConfigFromFields } from "./template-semantic-service";
import { completeBuiltInTemplateScan } from "./template-rule-registry";
import { buildTemplateFieldContext, resolveTemplateFieldsFromScan } from "./template-field-state-service";
import { TemplateRuntimeAnalysis } from "./template-runtime-analysis-service";
import { ResolvedTemplateContent } from "./template-include-resolver-service";
import { TemplateRuntimeStateService } from "./template-runtime-state-service";
import { TemplateSectionConfigService } from "./template-section-config-service";
import { TemplateScanner } from "./template-scanner";

export interface ImportCandidate {
  name: string;
  path: string;
  fieldCount: number;
  fields: ScannedTemplateField[];
  sectionConfig?: TemplateSectionConfig[];
  runtimeAnalysis: TemplateRuntimeAnalysis;
  includeResolution: Pick<ResolvedTemplateContent, "includePaths" | "unresolvedIncludes">;
  alreadyImported: boolean;
  valid: boolean;
}

export class TemplateLibraryService {
  private readonly sectionConfigService = new TemplateSectionConfigService();
  private readonly runtimeStateService: TemplateRuntimeStateService;

  constructor(
    private readonly app: App,
    private readonly settingsService: SettingsService,
    private readonly templateScanner: TemplateScanner
  ) {
    this.runtimeStateService = new TemplateRuntimeStateService(app, templateScanner, this.sectionConfigService);
  }

  async scanFolder(folderPath: string): Promise<ImportCandidate[]> {
    const normalizedFolderPath = normalizePath(folderPath.trim());
    const folder = this.app.vault.getAbstractFileByPath(normalizedFolderPath);

    if (!normalizedFolderPath) {
      throw new Error("template_folder_required");
    }

    if (!folder) {
      throw new Error("template_folder_not_found");
    }

    if (!(folder instanceof TFolder)) {
      throw new Error("template_folder_must_be_folder");
    }

    const existingTemplatesByPath = new Map(
      this.settingsService
        .getSettings()
        .templates.map((template) => [normalizePath(template.path), template] as const)
    );

    const files = this.collectMarkdownFiles(folder);
    const candidates: ImportCandidate[] = [];

    for (const file of files) {
      const normalizedPath = normalizePath(file.path);
      const existingTemplate = existingTemplatesByPath.get(normalizedPath);
      const runtimeState = await this.runtimeStateService.build(
        existingTemplate ?? this.buildCandidateTemplateShell(file),
        file,
        { preferFreshRead: true }
      );

      candidates.push({
        name: file.basename,
        path: normalizedPath,
        fieldCount: runtimeState.fields.length,
        fields: runtimeState.scannedFields,
        sectionConfig: runtimeState.sectionConfig,
        runtimeAnalysis: runtimeState.runtimeAnalysis,
        includeResolution: runtimeState.includeResolution,
        alreadyImported: existingTemplate !== undefined,
        valid: runtimeState.fields.length > 0
      });
    }

    return candidates.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
  }

  private buildCandidateTemplateShell(file: TFile): TemplateConfig {
    return {
      id: createTemplateId(file.path),
      name: file.basename,
      path: normalizePath(file.path),
      enabled: true,
      defaultOutputPath: "",
      defaultIndexStrategy: "inherit",
      defaultIndexNotePath: "",
      filenameField: "",
      fields: []
    };
  }

  buildTemplateConfig(
    candidate: ImportCandidate,
    defaults: {
      enabled: boolean;
      defaultOutputPath: string;
      defaultIndexNotePath: string;
      filenameField: string;
    },
    existingTemplate?: TemplateConfig
  ): TemplateConfig {
    const completedFields = completeBuiltInTemplateScan(candidate.fields);
    const fields = resolveTemplateFieldsFromScan(
      completedFields,
      existingTemplate?.fields ?? [],
      candidate.sectionConfig,
      existingTemplate?.semanticConfig,
      existingTemplate?.rulePackConfig
    );
    const fieldContext = buildTemplateFieldContext(
      fields,
      candidate.sectionConfig,
      this.sectionConfigService
    );

    return {
      id: existingTemplate?.id ?? createTemplateId(candidate.path),
      name:
        existingTemplate && normalizePath(existingTemplate.path) === normalizePath(candidate.path)
          ? existingTemplate.name
          : candidate.name,
      path: normalizePath(candidate.path),
      enabled: existingTemplate?.enabled ?? defaults.enabled,
      defaultOutputPath: existingTemplate?.defaultOutputPath ?? defaults.defaultOutputPath,
      defaultIndexStrategy: existingTemplate?.defaultIndexStrategy ?? "inherit",
      defaultIndexNotePath: existingTemplate?.defaultIndexNotePath ?? defaults.defaultIndexNotePath,
      filenameField: resolveTemplateFilenameField(existingTemplate?.filenameField ?? defaults.filenameField, fields),
      fields,
      semanticConfig: buildStructuralMappingConfigFromFields(
        fieldContext,
        existingTemplate?.semanticConfig,
        candidate.sectionConfig
      ),
      rulePackConfig: existingTemplate?.rulePackConfig,
      sectionConfig: candidate.sectionConfig
    };
  }

  private collectMarkdownFiles(folder: TFolder): TFile[] {
    const files: TFile[] = [];

    for (const child of folder.children) {
      if (child instanceof TFolder) {
        files.push(...this.collectMarkdownFiles(child));
        continue;
      }

      if (child instanceof TFile && child.extension === "md") {
        files.push(child);
      }
    }

    return files;
  }
}
