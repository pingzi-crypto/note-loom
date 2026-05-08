import { App, TFile } from "obsidian";

import type {
  ScannedTemplateField,
  TemplateConfig,
  TemplateFieldConfig,
  TemplateSectionConfig
} from "../types/template";
import type { ResolvedTemplateContent } from "./template-include-resolver-service";
import { TemplateIncludeResolverService } from "./template-include-resolver-service";
import { TemplateRuntimeAnalysis, TemplateRuntimeAnalysisService } from "./template-runtime-analysis-service";
import { TemplateScanner } from "./template-scanner";
import {
  getRuntimeSectionRawContent,
  TemplateSectionConfigService
} from "./template-section-config-service";
import { completeBuiltInTemplateScan } from "./template-rule-registry";
import { resolveTemplateFieldsFromScan } from "./template-field-state-service";

export interface TemplateRuntimeState {
  rawContent: string;
  resolvedContent: string;
  includeResolution: Pick<ResolvedTemplateContent, "includePaths" | "unresolvedIncludes">;
  scannedFields: ScannedTemplateField[];
  sectionConfig?: TemplateSectionConfig[];
  sectionRawContentById: Record<string, string>;
  fields: TemplateFieldConfig[];
  runtimeAnalysis: TemplateRuntimeAnalysis;
}

export class TemplateRuntimeStateService {
  private readonly includeResolverService: TemplateIncludeResolverService;
  private readonly runtimeAnalysisService = new TemplateRuntimeAnalysisService();

  constructor(
    private readonly app: App,
    private readonly templateScanner: TemplateScanner,
    private readonly sectionConfigService: TemplateSectionConfigService = new TemplateSectionConfigService()
  ) {
    this.includeResolverService = new TemplateIncludeResolverService(app);
  }

  async build(
    template: TemplateConfig,
    templateFile: TFile,
    options?: { preferFreshRead?: boolean; resetRecognitionConfig?: boolean }
  ): Promise<TemplateRuntimeState> {
    const rawContent =
      options?.preferFreshRead && typeof this.app.vault.read === "function"
        ? await this.app.vault.read(templateFile)
        : await this.app.vault.cachedRead(templateFile);
    return this.buildFromContent(template, templateFile.path, rawContent, {
      resetRecognitionConfig: options?.resetRecognitionConfig
    });
  }

  async buildFromContent(
    template: TemplateConfig,
    templatePath: string,
    rawContent: string,
    options?: { resetRecognitionConfig?: boolean }
  ): Promise<TemplateRuntimeState> {
    const resolved = await this.includeResolverService.resolveTemplate(templatePath, rawContent);
    const sectionConfig =
      this.sectionConfigService.buildFromContent(
        resolved.resolvedContent,
        template.sectionConfig,
        template.rulePackConfig,
        {
          includeModeSource: true,
          resetRecognitionConfig: options?.resetRecognitionConfig
        }
      ) ?? template.sectionConfig;
    const scannedFields = completeBuiltInTemplateScan(
      this.templateScanner.scanFields(resolved.resolvedContent)
    );
    const fields = resolveTemplateFieldsFromScan(
      scannedFields,
      template.fields,
      sectionConfig,
      template.semanticConfig,
      template.rulePackConfig
    );
    const sectionRawContentById = Object.fromEntries(
      (sectionConfig ?? []).map((section) => [section.id, getRuntimeSectionRawContent(section)])
    );

    return {
      rawContent,
      resolvedContent: resolved.resolvedContent,
      includeResolution: {
        includePaths: resolved.includePaths,
        unresolvedIncludes: resolved.unresolvedIncludes
      },
      scannedFields,
      sectionConfig,
      sectionRawContentById,
      fields,
      runtimeAnalysis: this.runtimeAnalysisService.analyze(resolved.resolvedContent)
    };
  }
}
