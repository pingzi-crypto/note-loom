import type { TFile } from "obsidian";

import type { FieldMatchResult } from "../types/match";
import type { TemplateConfig, TemplateFieldConfig, TemplateSemanticConfig } from "../types/template";
import type { TemplateStructureDescriptor } from "../types/template-structure-descriptor";
import { fallbackFilename, sanitizeFilename } from "../utils/filename";
import type { FrontmatterValue } from "../utils/frontmatter";
import { resolveTemplateFilenameField, type FilenameFieldCandidate } from "../utils/template-filename-field";
import type { FileService } from "./file-service";
import type { IndexService } from "./index-service";
import {
  buildMatchedFieldReviewItems,
  buildResolvedValueMapFromRunFieldState,
  buildTemplateRunFieldStateSnapshot,
  type TemplateFieldContext
} from "./template-field-state-service";
import type { TemplateRenderer } from "./template-renderer";
import type { TemplaterProcessResult, TemplaterService } from "./templater-service";

export interface GenerateRunRenderInput {
  templateContent: string;
  fieldResults: FieldMatchResult[];
  sourceTemplateName: string;
  sourceNotePath?: string;
  writeSourceMetadata: boolean;
  fieldConfigs: TemplateFieldContext | TemplateFieldConfig[];
  semanticConfig?: TemplateSemanticConfig;
  structureDescriptor?: TemplateStructureDescriptor;
  sectionOverrides?: Array<{ title: string; content: string; mode?: "append" | "replace" }>;
  frontmatterOverrides?: Record<string, FrontmatterValue>;
}

export interface GenerateRunCreateInput {
  outputPath: string;
  filename: string;
  previewContent: string;
  renderInput: GenerateRunRenderInput;
  writeIndexEntry: boolean;
  indexNotePath: string;
  sourceNotePath: string;
  recordManagedIndexEntry?: (entry: {
    createdNotePath: string;
    indexNotePath: string;
    sourceNotePath: string;
  }) => Promise<void>;
  syncCreatedNoteIndexMetadata?: (createdFile: TFile, indexNotePath: string) => Promise<void>;
}

export interface GenerateRunCreateResult {
  createdFile: TFile;
  notePath: string;
  content: string;
  indexUpdated: boolean;
  templaterResult: TemplaterProcessResult | null;
  templaterError: unknown;
  indexError: unknown;
}

interface GenerateRunServiceDeps {
  templateRenderer: TemplateRenderer;
  fileService: FileService;
  indexService: IndexService;
  templaterService: TemplaterService;
  now?: () => Date;
}

export class GenerateRunService {
  private readonly now: () => Date;

  constructor(private readonly deps: GenerateRunServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  buildResolvedValueMap(params: {
    fieldResults: FieldMatchResult[];
    enabledFieldNames: Set<string>;
    sectionConfig?: TemplateConfig["sectionConfig"];
    fieldBlockSectionDrafts?: Map<string, Record<string, string>>;
    groupedFieldBlockSectionDrafts?: Map<string, Record<string, Record<string, string>>>;
    tableBlockSectionDrafts?: Map<string, Array<Record<string, string>>>;
    mixedFieldBlockSectionDrafts?: Map<string, Record<string, string>>;
  }): Record<string, string> {
    const matchedItems = buildMatchedFieldReviewItems(
      params.fieldResults,
      params.fieldResults,
      params.fieldResults.map((result) => ({
        fieldName: result.fieldName,
        kind: result.matched || result.finalValue.trim() ? "matched" : "unmatched",
        rawValue: result.finalValue.trim(),
        resolvedValue: result.finalValue.trim(),
        changed: false
      }))
    );
    return buildResolvedValueMapFromRunFieldState({
      snapshot: buildTemplateRunFieldStateSnapshot(matchedItems, []),
      enabledFieldNames: params.enabledFieldNames,
      sectionConfig: params.sectionConfig,
      fieldBlockSectionDrafts: params.fieldBlockSectionDrafts,
      groupedFieldBlockSectionDrafts: params.groupedFieldBlockSectionDrafts,
      tableBlockSectionDrafts: params.tableBlockSectionDrafts,
      mixedFieldBlockSectionDrafts: params.mixedFieldBlockSectionDrafts
    });
  }

  deriveFilename(
    template: TemplateConfig,
    valueMap: Record<string, string>,
    fields: FilenameFieldCandidate[] = []
  ): string {
    const configuredFieldName = template.filenameField?.trim() ?? "";
    const effectiveFieldName = fields.length > 0
      ? resolveTemplateFilenameField(configuredFieldName, fields)
      : configuredFieldName;
    const candidateFieldNames = Array.from(
      new Set([effectiveFieldName, configuredFieldName].filter(Boolean))
    );
    const matchedValue = candidateFieldNames
      .map((fieldName) => valueMap[fieldName]?.trim() ?? "")
      .find((value) => value.length > 0);
    return sanitizeFilename(matchedValue ?? "") || fallbackFilename(this.now());
  }

  renderContent(input: GenerateRunRenderInput): string {
    return this.deps.templateRenderer.render(
      input.templateContent,
      input.fieldResults,
      {
        sourceTemplateName: input.sourceTemplateName,
        sourceNotePath: input.sourceNotePath,
        writeSourceMetadata: input.writeSourceMetadata
      },
      input.fieldConfigs,
      input.semanticConfig,
      input.sectionOverrides ?? [],
      input.frontmatterOverrides ?? {},
      input.structureDescriptor
    );
  }

  async createGeneratedNote(input: GenerateRunCreateInput): Promise<GenerateRunCreateResult> {
    await this.deps.fileService.ensureFolderExists(input.outputPath);

    const notePath = await this.deps.fileService.resolveUniqueNotePath(input.outputPath, input.filename);
    const content = input.previewContent.trim() || this.renderContent(input.renderInput);
    const createdFile = await this.deps.fileService.createNote(notePath, content);
    let templaterResult: TemplaterProcessResult | null = null;
    let templaterError: unknown = null;
    let indexError: unknown = null;
    let indexUpdated = false;

    try {
      templaterResult = await this.deps.templaterService.processCreatedFile(createdFile, content);
    } catch (error) {
      templaterError = error;
    }

    if (input.writeIndexEntry && input.indexNotePath) {
      try {
        indexUpdated = await this.deps.indexService.upsertLinkEntry({
          indexNotePath: input.indexNotePath,
          createdNotePath: createdFile.path,
          sourceNotePath: input.sourceNotePath
        });
        if (indexUpdated) {
          await input.recordManagedIndexEntry?.({
            createdNotePath: createdFile.path,
            indexNotePath: input.indexNotePath,
            sourceNotePath: input.sourceNotePath
          });
          await input.syncCreatedNoteIndexMetadata?.(createdFile, input.indexNotePath);
        }
      } catch (error) {
        indexError = error;
      }
    }

    return {
      createdFile,
      notePath,
      content,
      indexUpdated,
      templaterResult,
      templaterError,
      indexError
    };
  }
}
