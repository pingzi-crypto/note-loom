import { App, Modal, Notice, TFile, normalizePath } from "obsidian";

import { t } from "../i18n";
import { SettingsService } from "../services/settings-service";
import { SectionDraftStore } from "../services/section-draft-store";
import { TemplateScanner } from "../services/template-scanner";
import { FieldMatcher } from "../services/field-matcher";
import { FileService } from "../services/file-service";
import { GenerateRunService } from "../services/generate-run-service";
import { DiagnosticsService } from "../services/diagnostics-service";
import { IndexService } from "../services/index-service";
import { TemplaterService } from "../services/templater-service";
import {
  resolveGenerateActiveFields,
  resolveGenerateDisplayResult,
  shouldSkipDisplayOnlyFieldWrite
} from "../services/generate-template-state-service";
import {
  TemplateIntegrityService,
  type StructuralMappingIntegrityReport,
  type StructuralMappingIntegrityResult
} from "../services/template-integrity-service";
import type { RuleLearningDetail } from "../services/template-rule-learning-service";
import { TemplateRuleLearningService } from "../services/template-rule-learning-service";
import {
  TemplateSectionDraftService,
  type TemplateSectionDraftExtraction
} from "../services/template-section-draft-service";
import {
  TemplateRunDiffService,
  type RunDecisionSummary,
  type RunFieldDecision
} from "../services/template-run-diff-service";
import { TemplateStructuralMappingRenderService } from "../services/template-semantic-render-service";
import { buildStructuralMappingConfigFromFields } from "../services/template-semantic-service";
import { TemplateSectionConfigService } from "../services/template-section-config-service";
import type { ResolvedTemplateContent } from "../services/template-include-resolver-service";
import { TemplateRenderer } from "../services/template-renderer";
import { type TemplateRuntimeAnalysis } from "../services/template-runtime-analysis-service";
import { TemplateRuntimeStateService } from "../services/template-runtime-state-service";
import { TemplateStructureDescriptorService } from "../services/template-structure-descriptor-service";
import { SourcePreparationService } from "../services/source-preparation-service";
import {
  applyTemplateFieldManualValue,
  buildTemplateFieldContext,
  buildMatchedFieldTrace,
  buildSectionPendingFieldTrace,
  buildMatchedFieldReviewItems,
  buildPendingFieldReviewViewModel,
  buildResolvedValueMapFromRunFieldState,
  buildRunDecisionSummaryFromFieldStateSnapshot,
  buildSectionPendingFieldItems,
  buildSectionRunDecisions,
  buildTemplateRunFieldStateSnapshot,
  buildTemplateRunFieldStateStats,
  createTemplateFieldAutoState,
  mergeRematchedFieldResults,
  type MatchedFieldReviewItem,
  resolveMatchedFieldRowState,
  resolveSectionPendingFieldRowState,
  type SectionPendingFieldBinding,
  type SectionPendingFieldItem,
  type TemplateFieldReviewStatus,
  type TemplateReviewItem,
  type TemplateRunFieldStateRecord,
  type TemplateRunFieldStateSnapshot,
} from "../services/template-field-state-service";
import { buildTemplateRuntimeGateState } from "../services/template-runtime-gate-service";
import type { FieldMatchResult } from "../types/match";
import type {
  TemplateConfig,
  TemplateFieldConfig,
  TemplateSectionConfig,
  TemplateSectionMode
} from "../types/template";
import type { TemplateStructureDescriptor } from "../types/template-structure-descriptor";
import { mergeFrontmatter, resolveExistingFrontmatterKey } from "../utils/frontmatter";
import { INDEX_METADATA_FRONTMATTER_FIELDS } from "../utils/generation-protocol";
import {
  resolveDefaultWriteIndexEntry as resolveDefaultWriteIndexEntryPolicy,
  resolveEffectiveIndexPath as resolveEffectiveIndexPathPolicy
} from "../utils/index-run-config";
import { getVaultFolderPaths, getVaultMarkdownPaths } from "../utils/vault-paths";
import {
  applyFieldRowLayout,
  createFieldRowSetting,
  createFolderPathDropdownSetting,
  createInfoSetting,
  createModalActionFooter,
  createModalHeading,
  createModalSection,
  createModalTitle,
  createNotePathDropdownSetting,
  createSingleLeftInfoSetting,
  createSingleLeftNoteRow,
  createSingleRightInfoSetting,
  prepareModalShell,
} from "./ui-entry";
import { TemplateConfigModal } from "./template-config-modal";

type FieldViewMode = "review" | "all";

interface FieldReviewItem {
  kind: MatchedFieldReviewItem["kind"];
  rawResult: MatchedFieldReviewItem["rawResult"];
  resolvedResult: MatchedFieldReviewItem["resolvedResult"];
  runDecision: MatchedFieldReviewItem["runDecision"];
  reviewStatus: MatchedFieldReviewItem["reviewStatus"];
}

type ReviewItem = TemplateReviewItem;

type SectionDraftWarningSummary = { message: string; titles: string[] };

function stripTrailingListBoundaryPunctuation(value: string): string {
  return value.trim().replace(/[\s:：,，;；.。!！?？、]+$/u, "");
}

export function formatSectionDraftWarningSummary(warning: SectionDraftWarningSummary): string {
  const visibleTitles = warning.titles.slice(0, 5).join("、");
  const hiddenCount = warning.titles.length - 5;
  const titleText = hiddenCount > 0
    ? `${visibleTitles} 等 ${hiddenCount} 个区块`
    : visibleTitles;
  const message = stripTrailingListBoundaryPunctuation(warning.message);

  if (!message) {
    return titleText;
  }

  if (!titleText) {
    return message;
  }

  return `${message}：${titleText}`;
}

function formatReviewStatus(
  language: ReturnType<SettingsService["getSettings"]>["language"],
  status: TemplateFieldReviewStatus
): string {
  switch (status) {
    case "edited":
      return t(language, "edited");
    case "needs_review":
      return t(language, "needs_review");
    case "unmatched":
      return t(language, "unmatched");
    default:
      return t(language, "matched");
  }
}

export class GenerateModal extends Modal {
  private readonly fieldAutoState = new WeakMap<
    FieldMatchResult,
    { matched: boolean; matchReason: FieldMatchResult["matchReason"]; matchedLabel?: string }
  >();
  private sourceText = "";
  private enabledTemplates: TemplateConfig[] = [];
  private selectedTemplateId = "";
  private currentTemplateContent = "";
  private currentFields: TemplateFieldConfig[] = [];
  private fieldResults: FieldMatchResult[] = [];
  private outputPath = "";
  private filename = "";
  private lastAutoFilename = "";
  private filenameManuallyEdited = false;
  private writeIndexEntry = true;
  private indexNotePathOverride = "";
  private openGeneratedNote = true;
  private fieldViewMode: FieldViewMode = "review";
  private showRunDecisionDetails = false;
  private showFieldTraceDetails = false;
  private previewContent = "";
  private previewTextAreaEl: HTMLTextAreaElement | null = null;
  private ready = false;
  private readonly integrityService = new TemplateIntegrityService();
  private readonly ruleLearningService = new TemplateRuleLearningService();
  private readonly runDiffService = new TemplateRunDiffService();
  private readonly structureDescriptorService = new TemplateStructureDescriptorService();
  private readonly sourcePreparationService = new SourcePreparationService();
  private readonly structuralMappingRenderService = new TemplateStructuralMappingRenderService();
  private readonly sectionConfigService = new TemplateSectionConfigService();
  private readonly sectionDraftService = new TemplateSectionDraftService();
  private readonly runtimeStateService: TemplateRuntimeStateService;
  private readonly generateRunService: GenerateRunService;
  private readonly sectionDraftStore: SectionDraftStore;
  private currentSectionConfig: TemplateConfig["sectionConfig"] = undefined;
  private currentSectionDraftExtraction: TemplateSectionDraftExtraction | null = null;
  private currentRuntimeAnalysis: TemplateRuntimeAnalysis = { level: "static", flags: [] };
  private currentIncludeResolution: Pick<ResolvedTemplateContent, "includePaths" | "unresolvedIncludes"> = {
    includePaths: [],
    unresolvedIncludes: []
  };
  constructor(
    app: App,
    private readonly sourceFile: TFile,
    private readonly settingsService: SettingsService,
    private readonly templateScanner: TemplateScanner,
    private readonly fieldMatcher: FieldMatcher,
    templateRenderer: TemplateRenderer,
    private readonly fileService: FileService,
    indexService: IndexService,
    templaterService: TemplaterService,
    private readonly diagnosticsService?: DiagnosticsService
  ) {
    super(app);
    this.runtimeStateService = new TemplateRuntimeStateService(app, templateScanner, this.sectionConfigService);
    this.generateRunService = new GenerateRunService({
      templateRenderer,
      fileService,
      indexService,
      templaterService
    });
    this.sectionDraftStore = new SectionDraftStore(this.sectionDraftService);
  }

  onOpen(): void {
    this.renderLoading();
    void this.initialize();
  }

  private renderLoading(): void {
    const { contentEl } = this;
    const settings = this.settingsService.getSettings();
    prepareModalShell(contentEl, this.modalEl, "note-loom-generate-modal");
    createModalTitle(contentEl, t(settings.language, "generator_title"));
    contentEl.createEl("p", {
      cls: "note-loom-section-note",
      text: t(settings.language, "generator_preparing")
    });
  }

  private async initialize(): Promise<void> {
    try {
      const settings = this.settingsService.getSettings();
      this.enabledTemplates = settings.templates.filter((template) => template.enabled);
      this.openGeneratedNote = settings.openGeneratedNote;

      if (this.enabledTemplates.length === 0) {
        this.ready = false;
        this.render();
        return;
      }

      const firstTemplate = this.enabledTemplates[0];
      if (!firstTemplate) {
        throw new Error(t(this.settingsService.getSettings().language, "no_enabled_templates"));
      }

      this.ready = true;
      this.selectedTemplateId = firstTemplate.id;
      await this.loadTemplate(this.selectedTemplateId);
      this.refreshPreview();
      this.render();
    } catch (error) {
      void this.recordDiagnostics("generate.initialize_failed", {
        status: "error",
        data: {
          sourceNotePath: this.sourceFile.path,
          error
        }
      });
      this.ready = false;
      this.render();
      new Notice(
        error instanceof Error ? error.message : t(this.settingsService.getSettings().language, "failed_initialize_generator")
      );
    }
  }

  private async refreshSourceText(): Promise<void> {
    this.sourceText = typeof this.app.vault.read === "function"
      ? await this.app.vault.read(this.sourceFile)
      : await this.app.vault.cachedRead(this.sourceFile);
  }

  private async loadTemplate(templateId: string): Promise<void> {
    const settings = this.settingsService.getSettings();
    const template = settings.templates.find((item) => item.id === templateId);

    if (!template) {
      throw new Error(t(this.settingsService.getSettings().language, "selected_template_not_found"));
    }

    const templateFile = this.app.vault.getAbstractFileByPath(template.path);
    if (!(templateFile instanceof TFile)) {
      throw new Error(t(this.settingsService.getSettings().language, "template_file_not_found"));
    }

    this.selectedTemplateId = template.id;
    await this.refreshSourceText();
    const runtimeState = await this.runtimeStateService.build(template, templateFile, { preferFreshRead: true });
    this.currentTemplateContent = runtimeState.resolvedContent;
    this.currentIncludeResolution = {
      includePaths: runtimeState.includeResolution.includePaths,
      unresolvedIncludes: runtimeState.includeResolution.unresolvedIncludes
    };
    this.currentSectionConfig = runtimeState.sectionConfig;
    this.currentFields = runtimeState.fields;
    this.currentRuntimeAnalysis = runtimeState.runtimeAnalysis;
    const preparedSource = this.getPreparedSourceForExtraction(template);
    const normalizedSourceText = preparedSource.normalizedSourceText;
    this.currentSectionDraftExtraction = this.sectionDraftService.extract(
      preparedSource,
      this.getEffectiveSectionConfig(template),
      {
        templateFields: this.getCurrentFieldContext(),
        structureDescriptor: this.getCurrentTemplateStructureDescriptor(template)
      }
    );
    this.sectionDraftStore.reset();
    this.sectionDraftStore.initialize({
      sectionConfig: this.getEffectiveSectionConfig(template),
      extraction: this.currentSectionDraftExtraction,
      templateContent: this.currentTemplateContent
    });

    this.fieldResults = this.fieldMatcher.match(
      normalizedSourceText,
      this.getMatcherFields(template),
      {
        enableAliasMatching: settings.enableAliasMatching,
        unmatchedFieldsStartEnabled: settings.unmatchedFieldsStartEnabled,
        sourceTextAlreadyNormalized: true
      },
      this.getCurrentFieldContext()
    );

    this.outputPath = template.defaultOutputPath || settings.defaultOutputPath;
    this.filenameManuallyEdited = false;
    this.syncFilenameFromTemplate(template, true);
    this.writeIndexEntry = this.resolveDefaultWriteIndexEntry(template);
    this.indexNotePathOverride = "";
    this.refreshPreview();
    void this.recordDiagnostics("generate.template_loaded", {
      status: "success",
      data: {
        templateId: template.id,
        templateName: template.name,
        templatePath: template.path,
        sourceNotePath: this.sourceFile.path,
        fieldCount: this.currentFields.length,
        sectionCount: this.getEffectiveSectionConfig(template).length,
        generatedSectionCount: this.getEffectiveSectionConfig(template).filter((section) => section.mode === "generate").length,
        includeCount: this.currentIncludeResolution.includePaths.length,
        unresolvedIncludeCount: this.currentIncludeResolution.unresolvedIncludes.length,
        runtimeLevel: this.currentRuntimeAnalysis.level,
        sectionDraftWarningCount: this.getSectionDraftWarnings().length
      }
    });
  }

  private deriveFilename(template: TemplateConfig): string {
    return this.generateRunService.deriveFilename(
      template,
      this.getResolvedValueMapForCurrentRun(template),
      this.getCurrentFieldContext().fields
    );
  }

  private syncFilenameFromTemplate(template?: TemplateConfig, force = false): void {
    const currentTemplate = template ?? this.getSelectedTemplate();
    if (!currentTemplate) {
      return;
    }

    const nextFilename = this.deriveFilename(currentTemplate);
    const shouldSync =
      force ||
      !this.filenameManuallyEdited ||
      this.filename.trim().length === 0 ||
      this.filename === this.lastAutoFilename;

    this.lastAutoFilename = nextFilename;
    if (shouldSync) {
      this.filename = nextFilename;
      this.filenameManuallyEdited = false;
    }
  }

  private getResolvedValueMapForCurrentRun(template?: TemplateConfig): Record<string, string> {
    const enabledFieldNames = this.getCurrentFieldContext().snapshot.reviewVisibleFieldNames;
    return buildResolvedValueMapFromRunFieldState({
      snapshot: this.buildRunFieldState(undefined, undefined, template),
      enabledFieldNames,
      sectionConfig: this.getEffectiveSectionConfig(template),
      fieldBlockSectionDrafts: this.sectionDraftStore.getFieldBlockSectionDrafts(),
      groupedFieldBlockSectionDrafts: this.sectionDraftStore.getGroupedFieldBlockSectionDrafts(),
      tableBlockSectionDrafts: this.sectionDraftStore.getTableBlockSectionDrafts(),
      mixedFieldBlockSectionDrafts: this.sectionDraftStore.getMixedFieldBlockSectionDrafts()
    });
  }

  private getSelectedTemplate(): TemplateConfig | undefined {
    return this.settingsService.getSettings().templates.find((item) => item.id === this.selectedTemplateId);
  }

  private resolveDefaultWriteIndexEntry(template: TemplateConfig): boolean {
    return resolveDefaultWriteIndexEntryPolicy(template, this.settingsService.getSettings());
  }

  private resolveEffectiveIndexPath(template: TemplateConfig): string {
    return resolveEffectiveIndexPathPolicy(template, this.settingsService.getSettings(), {
      writeIndexEntry: this.writeIndexEntry,
      overrideIndexNotePath: this.indexNotePathOverride
    });
  }

  private buildIndexNoteFrontmatterValue(indexNotePath: string): string {
    const normalizedPath = normalizePath(indexNotePath.trim());
    const linkTarget = normalizedPath.endsWith(".md") ? normalizedPath.slice(0, -3) : normalizedPath;
    return `[[${linkTarget}]]`;
  }

  private async syncCreatedNoteIndexMetadata(createdFile: TFile, indexNotePath: string): Promise<void> {
    const currentContent =
      typeof this.app.vault.read === "function"
        ? await this.app.vault.read(createdFile)
        : await this.app.vault.cachedRead(createdFile);
    const nextContent = mergeFrontmatter(currentContent, {
      [resolveExistingFrontmatterKey(
        currentContent,
        INDEX_METADATA_FRONTMATTER_FIELDS.indexNote.aliases,
        INDEX_METADATA_FRONTMATTER_FIELDS.indexNote.canonical
      )]: this.buildIndexNoteFrontmatterValue(indexNotePath)
    });

    if (nextContent !== currentContent) {
      await this.fileService.updateNote(createdFile, nextContent);
    }
  }

  private render(): void {
    const { contentEl } = this;
    const settings = this.settingsService.getSettings();
    prepareModalShell(contentEl, this.modalEl, "note-loom-generate-modal");
    this.previewTextAreaEl = null;
    createModalTitle(contentEl, t(settings.language, "generator_title"));

    if (!this.ready) {
      contentEl.createEl("p", {
        cls: "note-loom-section-note",
        text: t(settings.language, "no_enabled_templates")
      });
      return;
    }

    const basicSection = createModalSection(contentEl);

    const sourceNoteSetting = createSingleLeftInfoSetting(basicSection);
    sourceNoteSetting.settingEl.addClass("note-loom-generate-source-note");
    sourceNoteSetting
      .setName(t(settings.language, "source_note"))
      .setDesc(this.sourceFile.path);

    const templateSetting = createInfoSetting(basicSection);
    templateSetting.settingEl.addClass("note-loom-generate-inline-control");
    templateSetting
      .setName(t(settings.language, "selected_template"))
      .addDropdown((dropdown) => {
        this.enabledTemplates.forEach((template) => {
          dropdown.addOption(template.id, template.name);
        });

        dropdown.setValue(this.selectedTemplateId).onChange(async (value) => {
          try {
            await this.loadTemplate(value);
            this.render();
          } catch (error) {
            new Notice(
              error instanceof Error ? error.message : t(settings.language, "failed_load_template")
            );
          }
        });
      });

    createFolderPathDropdownSetting(basicSection, {
      name: t(settings.language, "output_path"),
      getLanguage: () => this.settingsService.getSettings().language,
      getPaths: () => getVaultFolderPaths(this.app),
      emptyLabelKey: "root_label",
      getCurrentValue: () => this.outputPath,
      onChange: (value) => {
        this.outputPath = value;
        this.render();
      },
      classNames: ["note-loom-generate-inline-control"],
      resetButton: {
        label: t(settings.language, "reset"),
        onClick: () => {
          const template = this.getSelectedTemplate();
          this.outputPath = template?.defaultOutputPath || settings.defaultOutputPath;
          this.render();
        }
      }
    });

    const filenameSetting = createInfoSetting(basicSection);
    filenameSetting.settingEl.addClass("note-loom-generate-inline-control");
    filenameSetting
      .setName(t(settings.language, "filename"))
      .addText((text) =>
        text.setValue(this.filename).onChange((value) => {
          this.filename = value;
          this.filenameManuallyEdited = value !== this.lastAutoFilename;
        })
      );

    const optionsSection = createModalSection(contentEl);

    this.renderTemplateDiagnostics(optionsSection);

    createInfoSetting(optionsSection)
      .setName(t(settings.language, "write_index_entry"))
      .addToggle((toggle) =>
        toggle.setValue(this.writeIndexEntry).onChange((value) => {
          this.writeIndexEntry = value;
          if (!value) {
            this.indexNotePathOverride = "";
          }
          this.render();
        })
      );

    if (this.writeIndexEntry) {
      createNotePathDropdownSetting(optionsSection, {
        name: t(settings.language, "index_note_path_for_run"),
        getLanguage: () => this.settingsService.getSettings().language,
        getPaths: () => getVaultMarkdownPaths(this.app),
        emptyLabelKey: "use_template_default_index",
        getCurrentValue: () => this.indexNotePathOverride,
        onChange: (value) => {
          this.indexNotePathOverride = value;
        },
        classNames: ["note-loom-generate-inline-control"],
        resetButton: {
          label: t(settings.language, "reset"),
          onClick: () => {
            this.indexNotePathOverride = "";
            this.render();
          }
        }
      });
    }

    createInfoSetting(optionsSection)
      .setName(t(settings.language, "open_generated_note"))
      .addToggle((toggle) =>
        toggle.setValue(this.openGeneratedNote).onChange((value) => {
          this.openGeneratedNote = value;
        })
      );

    const actionsSetting = createInfoSetting(optionsSection);
    actionsSetting.settingEl.addClass("note-loom-generate-actions");
    actionsSetting
      .setName(t(settings.language, "quick_actions"))
      .addButton((button) =>
        button
          .setButtonText(t(settings.language, "rematch_all"))
          .onClick(() => {
            this.rematchAll();
            this.render();
          })
      );

    const rawRunDiff = this.getRawRunDecisionSummary();
    const fieldReviewItems = this.getFieldReviewItems(rawRunDiff);
    const sectionPendingItems = this.getSectionPendingFieldItems();
    const runFieldState = this.buildRunFieldState(fieldReviewItems, sectionPendingItems);
    const runDiff = buildRunDecisionSummaryFromFieldStateSnapshot(runFieldState);
    const pendingFieldCount = runFieldState.pendingItems.length;
    const pendingSummarySetting = createSingleRightInfoSetting(optionsSection);
    pendingSummarySetting.settingEl.addClass("note-loom-generate-pending-summary");
    pendingSummarySetting.controlEl.createEl("p", {
      cls: "note-loom-section-note note-loom-generate-summary-count",
      text: t(settings.language, "pending_fields_summary", {
        pending: pendingFieldCount,
        total: runFieldState.allItems.length
      })
    });

    const sectionConfig = this.getEffectiveSectionConfig();
    if (sectionConfig.length > 0) {
      createModalHeading(contentEl, t(settings.language, "current_run_sections"));
      const sectionSummary = createModalSection(contentEl);
      this.renderSectionSummary(sectionSummary, sectionConfig);
    }

    const integrityReport = this.getIntegrityReport();
    if (integrityReport?.hasSemanticLayer) {
      createModalHeading(contentEl, t(settings.language, "integrity_check"));
      const integritySection = createModalSection(contentEl);
      this.renderIntegritySection(integritySection, integrityReport);
    }

    createModalHeading(contentEl, t(settings.language, "run_decision_preview"));
    const decisionSection = createModalSection(contentEl);
    this.renderRunDecisionSection(decisionSection, runDiff);

    createModalHeading(contentEl, t(settings.language, "pending_fields"));
    const fieldsSection = createModalSection(contentEl);
    this.renderPendingFieldsSection(fieldsSection, fieldReviewItems);

    const runtimeGateState = this.getRuntimeGateState();
    const hasRuntimeBlockingRisk = runtimeGateState.hasBlockingRisk;
    const shouldWarnBeforeGenerate = Boolean(
      integrityReport?.hasBlockingIssues || hasRuntimeBlockingRisk
    );
    createModalActionFooter(contentEl, {
      beforeActions: (footer) => {
        if (integrityReport?.hasBlockingIssues) {
          footer.createEl("p", {
            cls: "note-loom-section-note note-loom-generate-footer-warning",
            text: t(settings.language, "integrity_blocking_note")
          });
        }
      },
      actions: [
        {
          text: t(settings.language, "cancel"),
          onClick: () => this.close()
        },
        {
          text: shouldWarnBeforeGenerate
            ? t(settings.language, "generate_anyway")
            : t(settings.language, "generate"),
          variant: shouldWarnBeforeGenerate ? "warning" : "cta",
          onClick: async () => {
            await this.generate();
          }
        }
      ]
    });

  }

  private renderTemplateDiagnostics(container: HTMLElement): void {
    const language = this.settingsService.getSettings().language;
    const runtimeGateState = this.getRuntimeGateState();
    const structureDescriptor = this.getCurrentTemplateStructureDescriptor();
    const sectionWarnings = this.getSectionDraftWarningGroups();
    const groupedSectionWarnings = this.groupSectionDraftWarningsByMessage(sectionWarnings);

    if (runtimeGateState.level === "dynamic") {
      container.createDiv({
        cls: "note-loom-runtime-flag-row note-loom-runtime-flag is-high",
        text: t(language, "generator_runtime_dynamic_note")
      });
    } else if (runtimeGateState.level === "assisted") {
      container.createDiv({
        cls: "note-loom-runtime-flag-row note-loom-runtime-flag is-warn",
        text: t(language, "generator_runtime_assisted_note")
      });
    }

    if (structureDescriptor) {
      const generatedSections = structureDescriptor.sections.filter((section) => section.mode === "generate").length;
      const parserSections = structureDescriptor.sections.filter((section) => Boolean(section.parserId)).length;
      const semanticFields = structureDescriptor.fields.filter((field) =>
        field.features.includes("semantic_render_targets")
      ).length;
      const featureText = structureDescriptor.features.length > 0
        ? structureDescriptor.features.join(", ")
        : t(language, "generator_structure_no_template_features");

      container.createDiv({
        cls: "note-loom-runtime-flag-row note-loom-runtime-flag is-info",
        text: t(language, "generator_structure_descriptor_note", {
          fields: structureDescriptor.fields.length,
          sections: structureDescriptor.sections.length,
          generated: generatedSections,
          parsers: parserSections,
          semantic: semanticFields,
          features: featureText
        })
      });
    }

    if (groupedSectionWarnings.length > 0) {
      const warningContainer = container.createDiv({
        cls: "note-loom-runtime-flag-row note-loom-runtime-flag note-loom-section-soft-note is-info"
      });
      warningContainer.createEl("strong", {
        text: t(language, "generator_section_warning_title")
      });
      const summary = groupedSectionWarnings.slice(0, 3)
        .map((warning) => this.formatSectionDraftWarningGroup(warning))
        .join("；");
      warningContainer.createSpan({
        text: summary
      });
      if (groupedSectionWarnings.length > 3) {
        warningContainer.createSpan({
          cls: "note-loom-section-soft-note-more",
          text: t(language, "generator_section_warning_more", {
            count: String(groupedSectionWarnings.length - 3)
          })
        });
      }
    }
  }

  private getRuntimeGateState() {
    return buildTemplateRuntimeGateState(this.currentRuntimeAnalysis, {
      includePaths: this.currentIncludeResolution.includePaths,
      unresolvedIncludes: this.currentIncludeResolution.unresolvedIncludes
    });
  }

  private getSectionDraftWarnings(): string[] {
    return this.getSectionDraftWarningGroups().flatMap((warning) =>
      warning.messages.map((message) => `${warning.title}：${message}`)
    );
  }

  private getSectionDraftWarningGroups(): Array<{ title: string; messages: string[] }> {
    const warnings = this.currentSectionDraftExtraction?.repeatableWarnings;
    if (!warnings || warnings.size === 0) {
      return [];
    }

    const sectionsById = new Map(this.getEffectiveSectionConfig().map((section) => [section.id, section] as const));
    return Array.from(warnings.entries()).map(([sectionId, sectionWarnings]) => {
      const title = sectionsById.get(sectionId)?.title ?? sectionId;
      return { title, messages: sectionWarnings };
    });
  }

  private groupSectionDraftWarningsByMessage(
    sectionWarnings: Array<{ title: string; messages: string[] }>
  ): Array<{ message: string; titles: string[] }> {
    const grouped = new Map<string, string[]>();
    sectionWarnings.forEach((warning) => {
      warning.messages.forEach((message) => {
        const titles = grouped.get(message) ?? [];
        titles.push(warning.title);
        grouped.set(message, titles);
      });
    });

    return Array.from(grouped.entries()).map(([message, titles]) => ({
      message,
      titles
    }));
  }

  private formatSectionDraftWarningGroup(warning: SectionDraftWarningSummary): string {
    return formatSectionDraftWarningSummary(warning);
  }

  private getIntegrityReport(): StructuralMappingIntegrityReport | null {
    const template = this.getSelectedTemplate();
    if (!template) {
      return null;
    }

    const sectionValueOverrides = new Map(
      Object.entries(this.getResolvedValueMapForCurrentRun(template))
        .map(([fieldName, value]) => [fieldName, value.trim()] as const)
        .filter((entry) => entry[1].length > 0)
    );

    return this.integrityService.buildReport(
      this.getEffectiveSemanticConfig(template),
      this.getCurrentFieldContext(),
      this.getResolvedFieldResults(),
      sectionValueOverrides
    );
  }

  private getResolvedFieldResults(): FieldMatchResult[] {
    const template = this.getSelectedTemplate();
    return this.structuralMappingRenderService.apply(
      this.getEffectiveSemanticConfig(template),
      this.getCurrentFieldContext(),
      this.fieldResults,
      this.sourceText
    );
  }

  private getAllResolvedFieldResults(template?: TemplateConfig): FieldMatchResult[] {
    const currentTemplate = template ?? this.getSelectedTemplate();
    if (!currentTemplate) {
      return [...this.fieldResults];
    }

    const effectiveSemanticConfig = this.getEffectiveSemanticConfig(currentTemplate);
    const matcherFields = this.getActiveFields(currentTemplate);
    if (matcherFields.length === 0) {
      return [];
    }

    const settings = this.settingsService.getSettings();
    const normalizedSourceText = this.getNormalizedSourceText(currentTemplate);
    const matchedResults = this.fieldMatcher.match(
      normalizedSourceText,
      matcherFields,
      {
        enableAliasMatching: settings.enableAliasMatching,
        unmatchedFieldsStartEnabled: settings.unmatchedFieldsStartEnabled,
        sourceTextAlreadyNormalized: true
      },
      this.getCurrentFieldContext()
    );
    const editedResultMap = new Map(
      this.fieldResults.map((result) => [result.fieldName, result] as const)
    );
    const mergedResults = matchedResults.map(
      (result) => editedResultMap.get(result.fieldName) ?? result
    );

    return this.structuralMappingRenderService.apply(
      effectiveSemanticConfig,
      this.getCurrentFieldContext(),
      mergedResults,
      this.sourceText
    );
  }

  private getRunDecisionSummary(): RunDecisionSummary {
    return buildRunDecisionSummaryFromFieldStateSnapshot(this.buildRunFieldState());
  }

  private getRawRunDecisionSummary(): RunDecisionSummary {
    return this.runDiffService.build(this.fieldResults, this.getResolvedFieldResults());
  }

  private getSectionRunDecisions(): RunFieldDecision[] {
    return buildSectionRunDecisions(this.getSectionPendingFieldItems());
  }

  private getSectionPendingReviewStatus(
    binding: SectionPendingFieldBinding,
    value: string
  ): TemplateFieldReviewStatus {
    return this.sectionDraftStore.getPendingReviewStatus(binding, value, this.getEffectiveSectionConfig());
  }

  private getFieldReviewItems(summary: RunDecisionSummary): FieldReviewItem[] {
    return buildMatchedFieldReviewItems(this.fieldResults, this.getResolvedFieldResults(), summary.fields);
  }

  private buildRunFieldState(
    fieldReviewItems?: FieldReviewItem[],
    sectionPendingItems?: SectionPendingFieldItem[],
    template?: TemplateConfig
  ): TemplateRunFieldStateSnapshot {
    const rawResults = template ? this.getAllResolvedFieldResults(template) : this.fieldResults;
    const resolvedResults = template ? rawResults : this.getResolvedFieldResults();
    const rawSummary = this.runDiffService.build(rawResults, resolvedResults);
    const sectionItems = sectionPendingItems ?? this.getSectionPendingFieldItems(template);
    const sectionDecisions = buildSectionRunDecisions(sectionItems);
    const reviewItems =
      fieldReviewItems ??
      buildMatchedFieldReviewItems(rawResults, resolvedResults, [
        ...rawSummary.fields,
        ...sectionDecisions
      ]);
    return buildTemplateRunFieldStateSnapshot(reviewItems, sectionItems);
  }

  private findRunFieldStateRecord(item: TemplateReviewItem): TemplateRunFieldStateRecord | undefined {
    const itemId = item.kind === "section_field" ? item.binding.id : `field:${item.rawResult.fieldName}`;
    return this.buildRunFieldState().records.find((record) => record.id === itemId);
  }

  private describeRunFieldStateRecord(record: TemplateRunFieldStateRecord | undefined): string {
    if (!record) {
      return "";
    }

    const language = this.settingsService.getSettings().language;
    const sourceKey =
      record.source === "section_draft"
        ? "run_field_source_section_draft"
        : "run_field_source_matched_field";
    return [
      t(language, sourceKey),
      t(language, "run_field_render_owner", {
        value: record.renderOwner ? t(language, "yes") : t(language, "no")
      })
    ].join("；");
  }

  private getSectionPendingFieldItems(template?: TemplateConfig): SectionPendingFieldItem[] {
    return buildSectionPendingFieldItems(
      this.getCurrentFieldContext(),
      new Set((template ? this.getAllResolvedFieldResults(template) : this.fieldResults).map((field) => field.fieldName)),
      this.getEffectiveSectionConfig(template),
      this.sectionDraftStore.getCollections(),
      this.sectionConfigService,
      this.sectionDraftService
    );
  }

  private getCurrentFieldContext() {
    return buildTemplateFieldContext(
      this.currentFields,
      this.getEffectiveSectionConfig(),
      this.sectionConfigService
    );
  }

  private getMatcherFields(template?: TemplateConfig): TemplateFieldConfig[] {
    return this.getActiveFields(template);
  }

  private getNormalizedSourceText(template?: TemplateConfig): string {
    return this.getPreparedSourceForExtraction(template).normalizedSourceText;
  }

  private getPreparedSourceForExtraction(template?: TemplateConfig) {
    const currentTemplate = template ?? this.getSelectedTemplate();
    if (!currentTemplate) {
      return {
        rawSourceText: this.sourceText,
        normalizedSourceText: this.sourceText,
        normalizationVersion: 1 as const
      };
    }

    return this.sourcePreparationService.prepareForExtraction({
      sourceText: this.sourceText,
      sectionConfig: this.getEffectiveSectionConfig(currentTemplate),
      templateFields: this.getCurrentFieldContext(),
      getSectionLabels: (section) => this.sectionDraftService.getSectionLabels(section)
    });
  }

  private getEffectiveSectionConfig(template?: TemplateConfig): TemplateSectionConfig[] {
    const currentTemplate = template ?? this.getSelectedTemplate();
    if (
      currentTemplate?.id === this.selectedTemplateId &&
      this.currentSectionConfig &&
      this.currentSectionConfig.length > 0
    ) {
      return [...this.currentSectionConfig];
    }

    return [...(currentTemplate?.sectionConfig ?? this.currentSectionConfig ?? [])];
  }

  private getActiveFields(template?: TemplateConfig): TemplateFieldConfig[] {
    return resolveGenerateActiveFields(
      this.getCurrentFieldContext(),
      this.getEffectiveSectionConfig(template),
      this.sectionConfigService
    );
  }

  private getEffectiveSemanticConfig(template?: TemplateConfig): TemplateConfig["semanticConfig"] {
    const currentTemplate = template ?? this.getSelectedTemplate();
    const semanticConfig = buildStructuralMappingConfigFromFields(
      this.getCurrentFieldContext(),
      currentTemplate?.semanticConfig,
      this.getEffectiveSectionConfig(currentTemplate)
    );

    return this.sectionConfigService.filterSemanticConfig(
      semanticConfig,
      this.getCurrentFieldContext()
    );
  }

  private getCurrentTemplateStructureDescriptor(template?: TemplateConfig): TemplateStructureDescriptor | undefined {
    const currentTemplate = template ?? this.getSelectedTemplate();
    if (!currentTemplate) {
      return undefined;
    }

    return this.structureDescriptorService.build({
      ...currentTemplate,
      rawContent: this.currentTemplateContent,
      fields: this.currentFields.length > 0 ? this.getActiveFields(currentTemplate) : currentTemplate.fields,
      semanticConfig: this.getEffectiveSemanticConfig(currentTemplate),
      sectionConfig: this.getEffectiveSectionConfig(currentTemplate)
    } as TemplateConfig & { rawContent: string });
  }

  private renderSectionSummary(
    container: HTMLElement,
    sectionConfig: TemplateSectionConfig[]
  ): void {
    const language = this.settingsService.getSettings().language;
    const generateSections = sectionConfig.filter((section) => section.mode === "generate");
    const preserveSections = sectionConfig.filter((section) => section.mode === "preserve");
    const ignoreSections = sectionConfig.filter((section) => section.mode === "ignore");

    createSingleLeftNoteRow(
      container,
      t(language, "current_run_sections_summary", {
        generate: generateSections.length,
        preserve: preserveSections.length,
        ignore: ignoreSections.length
      }),
      "note-loom-section-summary-note"
    );

    if (generateSections.length === 0) {
      createSingleLeftNoteRow(container, t(language, "current_run_sections_empty"));
      return;
    }

    generateSections.forEach((section) => {
      const setting = createInfoSetting(container);
      setting.settingEl.addClass("note-loom-card-row-with-icon");
      setting.setName(section.title).setDesc(this.describeActiveSection(section));
      setting.addExtraButton((button) => {
        button.setIcon("dot-network");
        button.setTooltip(this.getSectionModeLabel(section.mode));
      });
    });
  }

  private describeActiveSection(section: TemplateSectionConfig): string {
    const language = this.settingsService.getSettings().language;
    const kindLabel = this.getSectionKindLabel(section);
    const fieldCount = section.fieldNames?.length ?? 0;
    const baseDesc = fieldCount > 0
      ? t(language, "current_run_section_desc", {
          kind: kindLabel,
          count: fieldCount
        })
      : t(language, "current_run_section_desc_no_fields", {
          kind: kindLabel
        });

    return baseDesc;
  }

  private getSectionKindLabel(section: TemplateSectionConfig): string {
    const language = this.settingsService.getSettings().language;
    switch (section.kind) {
      case "inline_fields":
        return t(language, "section_kind_inline_fields");
      case "repeatable_entries":
        return t(language, "section_kind_repeatable_entries");
      case "computed_block":
        return t(language, "section_kind_computed_block");
      case "mixed":
        return t(language, "section_kind_mixed");
      default:
        return t(language, "section_kind_content_block");
    }
  }

  private getSectionModeLabel(mode: TemplateSectionMode): string {
    const language = this.settingsService.getSettings().language;
    switch (mode) {
      case "preserve":
        return t(language, "section_mode_preserve");
      case "ignore":
        return t(language, "section_mode_ignore");
      default:
        return t(language, "section_mode_generate");
    }
  }

  private getSectionOverrides(): Array<{ title: string; content: string; mode?: "append" | "replace" }> {
    const overrides: Array<{ title: string; content: string; mode?: "append" | "replace" }> = [];
    const resolvedFieldValueMap = this.getResolvedValueMapForCurrentRun();
    const activeFieldNames = this.getCurrentFieldContext().snapshot.reviewVisibleFieldNames;

    this.getEffectiveSectionConfig()
      .filter((section) => section.mode === "generate")
      .forEach((section) => {
        let draft:
          | string
          | Record<string, string>
          | Record<string, Record<string, string>>
          | Array<Record<string, string>>
          | null = null;
        if (
          section.kind === "repeatable_entries" ||
          this.sectionDraftService.isRepeatableTextSection(section) ||
          this.sectionDraftService.isTaskListSection(section)
        ) {
          const repeatableDraft = this.sectionDraftStore.getRepeatableDraft(section.id).trim();
          draft = repeatableDraft ? repeatableDraft : null;
        } else if (this.sectionDraftService.isFieldBlockSection(section)) {
          const fieldDraft = this.sectionDraftStore.getFieldBlockDraft(section.id);
          draft = this.sectionDraftService.hasFieldBlockContent(section, fieldDraft) ? fieldDraft ?? null : null;
        } else if (this.sectionDraftService.isGroupedFieldBlockSection(section)) {
          const groupedDraft = this.sectionDraftStore.getGroupedFieldBlockDraft(section.id);
          draft = this.sectionDraftService.hasGroupedFieldBlockContent(section, groupedDraft)
            ? groupedDraft ?? null
            : null;
        } else if (this.sectionDraftService.isTableBlockSection(section)) {
          const tableDraft = this.sectionDraftStore.getTableBlockDraft(section.id);
          draft = this.sectionDraftService.hasTableBlockContent(section, tableDraft) ? tableDraft ?? null : null;
        }

        if (this.sectionDraftService.isMixedFieldBlockSection(section)) {
          const mixedDraft = this.sectionDraftStore.getMixedFieldBlockDraft(section.id);
          const override = this.sectionDraftService.buildMixedFieldBlockSectionOverrideFromFieldValues(
            this.currentTemplateContent,
            section,
            {
              ...resolvedFieldValueMap,
              ...mixedDraft
            },
            activeFieldNames
          );
          if (override) {
            overrides.push(override);
          }
          return;
        }

        if (!draft) {
          return;
        }

        const override = this.sectionDraftService.buildSectionOverride(
          this.currentTemplateContent,
          section,
          draft
        );
        if (override) {
          overrides.push(override);
        }
      });

    return overrides;
  }

  private getFrontmatterOverrides(): Record<string, number> {
    return this.sectionDraftService.buildFrontmatterOverrides(
      this.getEffectiveSectionConfig(),
      this.sectionDraftStore.getGroupedFieldBlockSectionDrafts()
    );
  }

  private renderIntegritySection(container: HTMLElement, report: StructuralMappingIntegrityReport): void {
    const settings = this.settingsService.getSettings();
    const visibleConcepts = report.concepts.filter((concept) => concept.status !== "complete");
    createSingleLeftNoteRow(
      container,
      t(settings.language, "integrity_summary", {
        complete: report.completeCount,
        partial: report.partialCount,
        missing: report.missingCount,
        unmapped: report.unmappedComplexFieldCount
      }),
      "note-loom-integrity-summary-row"
    );

    if (report.concepts.length === 0 && report.unmappedComplexFields.length === 0) {
      createSingleLeftNoteRow(
        container,
        t(settings.language, "integrity_no_concepts"),
        "note-loom-integrity-note-row"
      );
    }

    if (report.unmappedComplexFields.length > 0) {
      createSingleLeftNoteRow(
        container,
        t(settings.language, "integrity_unmapped_fields", {
          fields: report.unmappedComplexFields.join("、")
        }),
        "note-loom-integrity-note-row"
      );
    }

    if (report.concepts.length > 0 && visibleConcepts.length > 0) {
      visibleConcepts.forEach((concept) => this.renderIntegrityConceptRow(container, concept));
    } else if (visibleConcepts.length === 0 && report.unmappedComplexFields.length === 0) {
      createSingleLeftNoteRow(
        container,
        t(settings.language, "integrity_no_incomplete_concepts"),
        "note-loom-integrity-note-row"
      );
    }

    const settingsTemplate = this.settingsService.getTemplate(this.selectedTemplateId);
    const currentTemplate = this.getSelectedTemplate();
    const learningPreview = currentTemplate
      ? this.ruleLearningService.preview(
          currentTemplate,
          this.getCurrentFieldContext(),
          this.fieldResults
        )
      : {
          changed: false,
          learnedEnumAliasCount: 0,
          learnedFieldDefaultCount: 0,
          learnedFixCount: 0,
          learnableFixCount: 0,
          details: [],
          template: undefined
        };
    const shouldShowEditButton =
      report.hasBlockingIssues ||
      report.missingCount > 0 ||
      report.partialCount > 0 ||
      report.unmappedComplexFields.length > 0 ||
      visibleConcepts.length > 0 ||
      report.concepts.length === 0;
    const shouldShowSaveFixesButton = learningPreview.learnableFixCount > 0;

    if ((shouldShowEditButton && settingsTemplate) || shouldShowSaveFixesButton) {
      const actionsSetting = createSingleLeftInfoSetting(container);
      actionsSetting.settingEl.addClass(
        "note-loom-note-row",
        "note-loom-integrity-action-row"
      );
      actionsSetting.setName("");
      actionsSetting.nameEl.empty();
      const actions = actionsSetting.infoEl.createDiv({
        cls: "note-loom-integrity-actions"
      });

      if (shouldShowEditButton && settingsTemplate) {
        const editButton = actions.createEl("button", {
          text: t(settings.language, "integrity_open_template_rules")
        });
        editButton.addEventListener("click", () => {
          void this.openTemplateRulesModal();
        });
      }

      if (shouldShowSaveFixesButton) {
        const saveFixesButton = actions.createEl("button", {
          text: t(settings.language, "integrity_save_current_fixes_count", {
            count: learningPreview.learnableFixCount
          })
        });
        saveFixesButton.addEventListener("click", () => {
          void this.saveCurrentFixesToTemplateRules();
        });
      }
    }

    if (learningPreview.details.length > 0) {
      const list = container.createDiv({ cls: "note-loom-learning-detail-list" });
      learningPreview.details.forEach((detail) => this.renderLearningDetail(list, detail));
    }
  }

  private renderLearningDetail(container: HTMLElement, detail: RuleLearningDetail): void {
    const language = this.settingsService.getSettings().language;
    const summary =
      detail.kind === "field_default"
        ? detail.summary === "enabled by default"
          ? t(language, "learning_detail_enabled")
          : t(language, "learning_detail_disabled")
        : detail.summary;

    const item = container.createDiv({ cls: "note-loom-learning-detail-item" });
    item.createSpan({ text: detail.title });
    item.createSpan({ text: summary });
  }

  private renderRunDecisionSection(container: HTMLElement, summary: RunDecisionSummary): void {
    const settings = this.settingsService.getSettings();
    const header = container.createDiv({
      cls: "note-loom-generate-summary-row note-loom-run-diff-header"
    });
    header.createEl("p", {
      cls: "note-loom-section-note",
      text: t(settings.language, "run_decision_summary", {
        manual: summary.manualCount,
        semantic: summary.semanticCount,
        matched: summary.matchedCount,
        unmatched: summary.unmatchedCount
      })
    });
    const toggleButton = header.createEl("button", {
      text: this.showRunDecisionDetails
        ? t(settings.language, "hide_run_decision_details")
        : t(settings.language, "show_run_decision_details")
    });
    toggleButton.addEventListener("click", () => {
      this.showRunDecisionDetails = !this.showRunDecisionDetails;
      this.render();
    });

    if (!this.showRunDecisionDetails) {
      return;
    }

    this.renderPreview(container, { displayOnly: true });

    const visibleFields = summary.fields.filter((field) => field.kind !== "unmatched" || field.changed);
    if (visibleFields.length === 0) {
      container.createEl("p", {
        cls: "note-loom-section-note",
        text: t(settings.language, "run_decision_no_changes")
      });
      return;
    }

    const list = container.createDiv({ cls: "note-loom-run-diff-list" });
    visibleFields.forEach((field) => this.renderRunDecisionRow(list, field));
  }

  private renderRunDecisionRow(container: HTMLElement, field: RunFieldDecision): void {
    const row = container.createDiv({ cls: "note-loom-run-diff-row" });
    row.createDiv({
      cls: "note-loom-run-diff-field",
      text: field.fieldName
    });
    const actionCell = row.createDiv({ cls: "note-loom-run-diff-action-cell" });
    actionCell.createEl("button", {
      cls: `note-loom-run-diff-action note-loom-run-diff-action-${field.kind}`,
      text: this.getRunDecisionKindLabel(field.kind)
    });
    const valueCell = row.createDiv({ cls: "note-loom-run-diff-value-cell" });
    valueCell.createDiv({
      cls: "note-loom-run-diff-value",
      text: this.formatRunDecisionValue(field)
    });
    const renderTargetText = this.describeRunDecisionRenderTargets(field.fieldName);
    if (renderTargetText) {
      valueCell.createDiv({
        cls: "note-loom-section-note note-loom-run-diff-targets",
        text: renderTargetText
      });
    }
  }

  private renderPendingFieldsSection(container: HTMLElement, items: FieldReviewItem[]): void {
    const settings = this.settingsService.getSettings();
    const sectionItems = this.getSectionPendingFieldItems();
    const reviewView = buildPendingFieldReviewViewModel(items, sectionItems, this.fieldViewMode);

    if (this.fieldViewMode === "review") {
      this.renderPendingFieldStateCard(container, reviewView.hasPendingFields, "review");
      if (!reviewView.hasPendingFields) {
        return;
      }
    } else {
      this.renderPendingFieldStateCard(container, reviewView.hasPendingFields, "all");
    }

    if (reviewView.visibleItems.length === 0) {
      createSingleLeftNoteRow(container, t(settings.language, "no_fields_to_display"));
      return;
    }

    reviewView.fieldGroups.forEach((group) => {
      if (reviewView.fieldGroups.length > 1) {
        container.createDiv({ cls: "note-loom-section-note", text: group.title });
      }

      const groupContainer = container.createDiv({
        cls: "note-loom-generate-field-group"
      });
      group.items.forEach((item) => this.renderFieldRow(groupContainer, item));
    });
  }

  private renderPendingFieldStateCard(
    container: HTMLElement,
    hasPendingFields: boolean,
    mode: FieldViewMode
  ): void {
    const language = this.settingsService.getSettings().language;
    const hasDivider = mode === "all" || hasPendingFields;
    const card = container.createDiv({
      cls: [
        "note-loom-pending-state-card",
        hasPendingFields ? "is-action-needed" : "is-ready",
        mode === "all" ? "is-all-fields" : "is-review-fields",
        hasDivider ? "has-divider" : ""
      ].filter(Boolean).join(" ")
    });
    const info = card.createDiv({ cls: "note-loom-pending-state-info" });
    info.createEl("p", {
      cls: "note-loom-section-note",
      text: mode === "all"
        ? t(language, "pending_fields_all_title")
        : hasPendingFields
          ? t(language, "pending_fields_action_title")
          : t(language, "pending_fields_ready_title")
    });
    info.createEl("p", {
      cls: "note-loom-section-note",
      text: mode === "all"
        ? t(language, "pending_fields_all_desc")
        : hasPendingFields
          ? t(language, "pending_fields_action_desc")
          : t(language, "pending_fields_ready_desc")
    });

    const actions = card.createDiv({ cls: "note-loom-pending-state-actions" });
    this.renderPendingFieldActionButtons(actions, mode === "all" || hasPendingFields);
  }

  private renderPendingFieldActionButtons(container: HTMLElement, includeTraceToggle: boolean): void {
    const language = this.settingsService.getSettings().language;
    const fieldViewToggle = container.createEl("button", {
      text:
        this.fieldViewMode === "review"
          ? t(language, "view_all_fields")
          : t(language, "view_pending_fields")
    });
    fieldViewToggle.addEventListener("click", () => {
      this.fieldViewMode = this.fieldViewMode === "review" ? "all" : "review";
      this.render();
    });

    if (!includeTraceToggle) {
      return;
    }

    const fieldTraceToggle = container.createEl("button", {
      text: this.showFieldTraceDetails
        ? t(language, "hide_field_trace_details")
        : t(language, "show_field_trace_details")
    });
    fieldTraceToggle.addEventListener("click", () => {
      this.showFieldTraceDetails = !this.showFieldTraceDetails;
      this.render();
    });
  }

  private getRunDecisionKindLabel(kind: RunFieldDecision["kind"]): string {
    const language = this.settingsService.getSettings().language;
    switch (kind) {
      case "manual":
        return t(language, "run_decision_kind_manual");
      case "semantic":
        return t(language, "run_decision_kind_semantic");
      case "matched":
        return t(language, "run_decision_kind_matched");
      default:
        return t(language, "run_decision_kind_unmatched");
    }
  }

  private formatRunDecisionValue(field: RunFieldDecision): string {
    const language = this.settingsService.getSettings().language;
    if (!field.resolvedValue) {
      return t(language, "run_decision_value_empty");
    }

    if (field.kind === "semantic" && field.rawValue && field.rawValue !== field.resolvedValue) {
      return t(language, "run_decision_value_transformed", {
        from: field.rawValue,
        to: field.resolvedValue
      });
    }

    return field.resolvedValue;
  }

  private describeRunDecisionRenderTargets(fieldName: string): string {
    const language = this.settingsService.getSettings().language;
    const descriptor = this.getCurrentTemplateStructureDescriptor();
    const fieldDescriptor = descriptor?.fields.find((field) => field.fieldName === fieldName);
    if (!fieldDescriptor || fieldDescriptor.renderTargetKinds.length === 0) {
      return "";
    }

    return t(language, "run_decision_render_targets", {
      targets: fieldDescriptor.renderTargetKinds.join(", ")
    });
  }

  private renderIntegrityConceptRow(container: HTMLElement, concept: StructuralMappingIntegrityResult): void {
    const settings = this.settingsService.getSettings();
    const row = container.createDiv({
      cls: "note-loom-integrity-row"
    });
    const info = row.createDiv({ cls: "note-loom-integrity-row-info" });
    const title = info.createDiv({ cls: "note-loom-integrity-row-title" });
    title.createSpan({
      cls: "note-loom-integrity-row-label",
      text: concept.label.trim() || t(settings.language, "concept_label_placeholder")
    });
    if (concept.required) {
      title.createSpan({
        cls: "note-loom-integrity-row-required",
        text: t(settings.language, "integrity_required")
      });
    }

    info.createEl("p", {
      cls: "note-loom-section-note note-loom-integrity-row-meta",
      text: t(settings.language, "integrity_target_progress", {
        filled: concept.filledTargetCount,
        total: concept.targetCount
      })
    });

    if (concept.previewValue.trim()) {
      info.createEl("p", {
        cls: "note-loom-section-note note-loom-integrity-row-value",
        text: t(settings.language, "integrity_preview_value", {
          value: concept.previewValue
        })
      });
    }

    if (concept.missingTargetNames.length > 0) {
      info.createEl("p", {
        cls: "note-loom-section-note note-loom-integrity-row-warning",
        text: t(settings.language, "integrity_missing_targets", {
          fields: concept.missingTargetNames.join("、")
        })
      });
    }

    row.createSpan({
      cls: `note-loom-integrity-badge note-loom-integrity-badge-${concept.status}`,
      text: this.getIntegrityStatusLabel(concept.status)
    });
  }

  private getIntegrityStatusLabel(status: StructuralMappingIntegrityResult["status"]): string {
    const language = this.settingsService.getSettings().language;
    switch (status) {
      case "complete":
        return t(language, "integrity_status_complete");
      case "partial":
        return t(language, "integrity_status_partial");
      default:
        return t(language, "integrity_status_missing");
    }
  }

  private renderFieldRow(container: HTMLElement, item: ReviewItem): void {
    if (item.kind === "section_field") {
      this.renderSectionPendingFieldRow(container, item);
      return;
    }

    const settings = this.settingsService.getSettings();
    const result = item.rawResult;
    const getDisplayResult = (nextItem?: FieldReviewItem): FieldMatchResult =>
      resolveGenerateDisplayResult(
        result,
        nextItem?.resolvedResult ?? item.resolvedResult
      );
    this.rememberFieldAutoState(result);
    const fieldSetting = createFieldRowSetting(container);
    let traceEl: HTMLParagraphElement | null = null;
    let applyValueFromInput: (() => void) | null = null;
    let rematchButtonEl: HTMLButtonElement | null = null;
    const getFieldRowState = (reviewStatus: TemplateFieldReviewStatus) =>
      resolveMatchedFieldRowState(this.fieldViewMode, reviewStatus, result, this.fieldAutoState.get(result));
    const syncFieldActionButton = (): void => {
      if (!rematchButtonEl) {
        return;
      }

      const rowState = getFieldRowState(result.edited ? "edited" : item.reviewStatus);
      rematchButtonEl.classList.toggle("is-hidden", !rowState.showSecondaryAction);
      rematchButtonEl.textContent = t(settings.language, rowState.secondaryActionKey);
    };
    const syncFieldDisplay = (): void => {
      const nextItem = this.getFieldReviewItems(this.getRawRunDecisionSummary()).find(
        (field) => field.rawResult.fieldName === result.fieldName
      );
      const reviewStatus = nextItem?.reviewStatus ?? item.reviewStatus;
      const displayResult = getDisplayResult(nextItem);
      const rowState = getFieldRowState(reviewStatus);
      const runRecordText = this.describeRunFieldStateRecord(this.findRunFieldStateRecord(nextItem ?? item));
      fieldSetting.descEl.setText(formatReviewStatus(settings.language, reviewStatus));
      fieldSetting.settingEl.dataset.reviewStatus = reviewStatus;
      applyFieldRowLayout(fieldSetting.settingEl, rowState.layout);
      syncFieldActionButton();

      const traceState = buildMatchedFieldTrace(
        (key, vars) => t(settings.language, key as never, vars as never),
        reviewStatus,
        displayResult,
        this.showFieldTraceDetails,
        this.getCurrentTemplateStructureDescriptor()?.fields.find(
          (field) => field.fieldName === displayResult.fieldName
        )
      );
      if (traceState.visible) {
        if (!traceEl) {
          traceEl = fieldSetting.infoEl.createEl("p", {
            cls: "note-loom-section-note note-loom-field-trace"
          });
        }
        traceEl.setText([runRecordText, traceState.text].filter(Boolean).join("；"));
      } else if (traceEl) {
        traceEl.remove();
        traceEl = null;
      }
    };

    fieldSetting
      .setName(result.fieldName)
      .setDesc(formatReviewStatus(settings.language, item.reviewStatus));

    const initialRowState = getFieldRowState(item.reviewStatus);
    applyFieldRowLayout(fieldSetting.settingEl, initialRowState.layout);

    if (initialRowState.showToggle) {
      fieldSetting.addToggle((toggle) =>
        toggle.setValue(result.enabled).onChange((value) => {
          result.enabled = value;
          this.refreshPreview();
        })
      );
    }

    fieldSetting.addTextArea((text) => {
        const applyValue = (value: string): void => {
          if (shouldSkipDisplayOnlyFieldWrite(result, getDisplayResult(), value)) {
            syncFieldDisplay();
            return;
          }

          applyTemplateFieldManualValue(result, this.fieldAutoState.get(result), value);
          syncFieldDisplay();
          this.refreshPreview();
        };
        const initialDisplayResult = getDisplayResult();

        text
          .setPlaceholder("")
          .setValue(initialDisplayResult.finalValue)
          .onChange((value) => {
            applyValue(value);
          });
        const syncFromInput = (): void => {
          applyValue(text.inputEl.value);
        };
        applyValueFromInput = syncFromInput;
        text.inputEl.addEventListener("input", syncFromInput);
        text.inputEl.addEventListener("change", syncFromInput);
        text.inputEl.addEventListener("blur", syncFromInput);
        text.inputEl.addEventListener("compositionend", syncFromInput);
        text.inputEl.addEventListener("keyup", syncFromInput);
        text.inputEl.rows = Math.max(2, Math.min(6, initialDisplayResult.finalValue.split("\n").length || 2));
      })
      .addButton((button) => {
        button.setButtonText(t(settings.language, "apply_field_value"));
        button.buttonEl.addClass("note-loom-field-action");
        button.buttonEl.addClass("note-loom-field-apply-action");
        button.onClick(() => {
          applyValueFromInput?.();
          this.render();
        });
      });

    if (!initialRowState.pendingReviewMode) {
      fieldSetting.addButton((button) => {
        button.setButtonText(t(settings.language, initialRowState.secondaryActionKey));
        button.buttonEl.addClass("note-loom-field-action");
        button.buttonEl.addClass("note-loom-field-secondary-action");
        rematchButtonEl = button.buttonEl;
        button.onClick(() => {
          this.rematchField(result.fieldName);
          this.render();
        });
      });
    }
    syncFieldDisplay();
  }

  private renderSectionPendingFieldRow(container: HTMLElement, item: SectionPendingFieldItem): void {
    const settings = this.settingsService.getSettings();
    const fieldSetting = createFieldRowSetting(container);

    const syncDisplay = (): void => {
      const nextValue = this.readSectionPendingFieldValue(item.binding);
      item.value = nextValue;
      item.reviewStatus = this.getSectionPendingReviewStatus(item.binding, nextValue);
      fieldSetting.descEl.setText(formatReviewStatus(settings.language, item.reviewStatus));
      fieldSetting.settingEl.dataset.reviewStatus = item.reviewStatus;
      applyFieldRowLayout(
        fieldSetting.settingEl,
        resolveSectionPendingFieldRowState(this.fieldViewMode, item.value).layout
      );
    };

    fieldSetting
      .setName(item.binding.label)
      .setDesc(formatReviewStatus(settings.language, item.reviewStatus))
      .addTextArea((text) => {
        const applyValue = (value: string): void => {
          this.writeSectionPendingFieldValue(item.binding, value);
          syncDisplay();
          this.refreshPreview();
        };

        text
          .setPlaceholder("")
          .setValue(item.value)
          .onChange((value) => {
            applyValue(value);
          });
        const syncFromInput = (): void => {
          applyValue(text.inputEl.value);
        };
        text.inputEl.addEventListener("input", syncFromInput);
        text.inputEl.addEventListener("change", syncFromInput);
        text.inputEl.addEventListener("blur", syncFromInput);
        text.inputEl.addEventListener("compositionend", syncFromInput);
        text.inputEl.addEventListener("keyup", syncFromInput);
        text.inputEl.rows = Math.max(2, Math.min(6, item.value.split("\n").length || 2));
      })
      ;

    const sectionRowState = resolveSectionPendingFieldRowState(this.fieldViewMode, item.value);
    applyFieldRowLayout(fieldSetting.settingEl, sectionRowState.layout);

    if (sectionRowState.canReset) {
      fieldSetting.addButton((button) => {
        button.setButtonText(t(settings.language, "reset"));
        button.buttonEl.addClass("note-loom-field-action");
        button.buttonEl.addClass("note-loom-field-secondary-action");
        button.onClick(() => {
          const initialValue = this.getInitialSectionPendingFieldValue(item.binding);
          this.writeSectionPendingFieldValue(item.binding, initialValue);
          syncDisplay();
          this.refreshPreview();
          this.render();
        });
      });
    }

    fieldSetting.addButton((button) => {
      button.setButtonText(t(settings.language, "apply_field_value"));
      button.buttonEl.addClass("note-loom-field-action");
      button.buttonEl.addClass("note-loom-field-apply-action");
      button.onClick(() => {
        this.render();
      });
    });

    const traceEl = fieldSetting.infoEl.createEl("p", {
      cls: "note-loom-section-note note-loom-field-trace",
      text: [this.describeRunFieldStateRecord(this.findRunFieldStateRecord(item)), this.describeSectionPendingFieldTrace(item)]
        .filter(Boolean)
        .join("；")
    });
    if (!this.showFieldTraceDetails) {
      traceEl.remove();
    }
  }

  private describeSectionPendingFieldTrace(item: SectionPendingFieldItem): string {
    const language = this.settingsService.getSettings().language;
    return buildSectionPendingFieldTrace(
      (key, vars) => t(language, key as never, vars as never),
      item.binding,
      true,
      this.sectionDraftStore.getSectionDraftTrace(item.binding.sectionId)
    ).text;
  }

  private getInitialSectionPendingFieldValue(binding: SectionPendingFieldBinding): string {
    return this.sectionDraftStore.getInitialPendingFieldValue(binding, this.getEffectiveSectionConfig());
  }

  private readSectionPendingFieldValue(binding: SectionPendingFieldBinding): string {
    return this.sectionDraftStore.readPendingFieldValue(binding, this.getEffectiveSectionConfig());
  }

  private writeSectionPendingFieldValue(binding: SectionPendingFieldBinding, value: string): void {
    this.sectionDraftStore.writePendingFieldValue(binding, value, this.getEffectiveSectionConfig());
    this.syncSectionDraftToFieldResult(binding.fieldKey, value);
  }

  private syncSectionDraftToFieldResult(fieldName: string, value: string): void {
    const result = this.fieldResults.find((field) => field.fieldName === fieldName);
    if (!result) {
      return;
    }

    applyTemplateFieldManualValue(result, this.fieldAutoState.get(result), value);
  }

  private buildDisplayPreviewContent(): string {
    const removeScriptedFrontmatterLine = (line: string): boolean =>
      /^\s*[A-Za-z0-9_-]+\s*:\s*.*(<%|{{|tp\.|dv\.)/.test(line);

    const lines = this.previewContent.split("\n");
    const filtered: string[] = [];
    let inDataviewLikeFence = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (/^```(dataview|dataviewjs|tasks)\b/i.test(trimmed)) {
        inDataviewLikeFence = true;
        continue;
      }

      if (inDataviewLikeFence) {
        if (trimmed === "```") {
          inDataviewLikeFence = false;
        }
        continue;
      }

      if (removeScriptedFrontmatterLine(line)) {
        continue;
      }

      if (/<%.*%>/.test(line)) {
        continue;
      }

      filtered.push(line);
    }

    const collapsed: string[] = [];
    let previousBlank = false;
    filtered.forEach((line) => {
      const isBlank = line.trim().length === 0;
      if (isBlank && previousBlank) {
        return;
      }
      collapsed.push(line);
      previousBlank = isBlank;
    });

    return collapsed.join("\n").trim();
  }

  private renderPreview(container: HTMLElement, options?: { displayOnly?: boolean }): void {
    const preview = container.createEl("textarea");
    preview.addClass("note-loom-preview");
    preview.readOnly = true;
    const content = options?.displayOnly ? this.buildDisplayPreviewContent() : this.previewContent;
    preview.value = content;
    preview.rows = Math.max(12, Math.min(28, content.split("\n").length + 2));
    this.previewTextAreaEl = preview;
  }

  private refreshPreview(): void {
    const template = this.getSelectedTemplate();
    if (!template || !this.currentTemplateContent) {
      this.previewContent = "";
      this.syncPreviewTextArea();
      return;
    }

    this.syncFilenameFromTemplate(template);
    const resolvedFieldResults = this.getResolvedFieldResults();
    this.previewContent = this.generateRunService.renderContent({
      templateContent: this.currentTemplateContent,
      fieldResults: resolvedFieldResults,
      sourceTemplateName: template.name,
      sourceNotePath: this.sourceFile.path,
      writeSourceMetadata: this.settingsService.getSettings().writeSourceMetadata,
      fieldConfigs: this.getCurrentFieldContext(),
      semanticConfig: this.getEffectiveSemanticConfig(template),
      structureDescriptor: this.getCurrentTemplateStructureDescriptor(template),
      sectionOverrides: this.getSectionOverrides(),
      frontmatterOverrides: this.getFrontmatterOverrides()
    });
    this.syncPreviewTextArea();
  }

  private syncPreviewTextArea(): void {
    if (!this.previewTextAreaEl) {
      return;
    }

    this.previewTextAreaEl.value = this.previewContent;
    this.previewTextAreaEl.rows = Math.max(12, Math.min(28, this.previewContent.split("\n").length + 2));
  }

  private rememberFieldAutoState(result: FieldMatchResult): void {
    if (this.fieldAutoState.has(result)) {
      return;
    }

    this.fieldAutoState.set(result, createTemplateFieldAutoState(result));
  }

  private rematchAll(): void {
    const settings = this.settingsService.getSettings();
    const matcherFields = this.getMatcherFields();
    const normalizedSourceText = this.getNormalizedSourceText();
    const rematchedResults = this.fieldMatcher.match(
      normalizedSourceText,
      matcherFields,
      {
        enableAliasMatching: settings.enableAliasMatching,
        unmatchedFieldsStartEnabled: settings.unmatchedFieldsStartEnabled,
        sourceTextAlreadyNormalized: true
      },
      this.getCurrentFieldContext()
    );

    this.fieldResults = mergeRematchedFieldResults(this.fieldResults, rematchedResults);

    this.refreshPreview();
  }

  private rematchField(fieldName: string): void {
    const fieldConfig = this.currentFields.find((field) => field.name === fieldName);
    const previous = this.fieldResults.find((field) => field.fieldName === fieldName);

    if (!fieldConfig || !previous) {
      return;
    }

    const settings = this.settingsService.getSettings();
    const matcherField = this.getMatcherFields().find((field) => field.name === fieldName) ?? fieldConfig;
    const normalizedSourceText = this.getNormalizedSourceText();
    const rematched = this.fieldMatcher.matchField(
      normalizedSourceText,
      matcherField,
      {
        enableAliasMatching: settings.enableAliasMatching,
        unmatchedFieldsStartEnabled: settings.unmatchedFieldsStartEnabled,
        sourceTextAlreadyNormalized: true
      },
      this.getCurrentFieldContext()
    );

    rematched.enabled = previous.enabled;

    this.fieldResults = this.fieldResults.map((field) =>
      field.fieldName === fieldName ? rematched : field
    );

    this.refreshPreview();
  }

  private async generate(): Promise<void> {
    const settings = this.settingsService.getSettings();
    const template = this.getSelectedTemplate();
    if (!template) {
      void this.recordDiagnostics("generate.validation_failed", {
        status: "warning",
        data: { reason: "missing_template", sourceNotePath: this.sourceFile.path }
      });
      new Notice(t(settings.language, "select_template_before_generating"));
      return;
    }

    const outputPath = this.outputPath.trim()
      ? normalizePath(this.outputPath.trim())
      : "";
    if (!this.fileService.isPathInsideVault(outputPath)) {
      void this.recordDiagnostics("generate.validation_failed", {
        status: "warning",
        data: {
          reason: "invalid_output_path",
          templateId: template.id,
          templateName: template.name,
          sourceNotePath: this.sourceFile.path
        }
      });
      new Notice(t(settings.language, "output_path_vault_relative"));
      return;
    }

    const integrityReport = this.getIntegrityReport();
    if (integrityReport?.hasBlockingIssues) {
      new Notice(t(settings.language, "integrity_generate_anyway_notice"));
    }

    const sectionDraftWarnings = this.getSectionDraftWarnings();
    if (sectionDraftWarnings.length > 0) {
      new Notice(t(settings.language, "generator_section_warning_notice", {
        count: String(sectionDraftWarnings.length)
      }));
    }

    const indexPath = this.writeIndexEntry ? this.resolveEffectiveIndexPath(template) : "";
    const sectionOverrides = this.getSectionOverrides();
    const frontmatterOverrides = this.getFrontmatterOverrides();
    const runFieldStats = buildTemplateRunFieldStateStats(this.buildRunFieldState());
    void this.recordDiagnostics("generate.started", {
      status: sectionDraftWarnings.length > 0 ? "warning" : "info",
      data: {
        templateId: template.id,
        templateName: template.name,
        templatePath: template.path,
        sourceNotePath: this.sourceFile.path,
        outputPath,
        filename: this.filename,
        writeIndexEntry: this.writeIndexEntry,
        indexNotePath: indexPath,
        fieldCount: this.getResolvedFieldResults().length,
        runFieldCount: runFieldStats.runFieldCount,
        pendingFieldCount: runFieldStats.pendingFieldCount,
        matchedFieldCount: runFieldStats.matchedFieldCount,
        sectionDraftFieldCount: runFieldStats.sectionDraftFieldCount,
        sectionOverrideCount: sectionOverrides.length,
        frontmatterOverrideCount: Object.keys(frontmatterOverrides).length,
        sectionDraftWarningCount: sectionDraftWarnings.length,
        runtimeLevel: this.currentRuntimeAnalysis.level
      }
    });

    let result;
    try {
      result = await this.generateRunService.createGeneratedNote({
        outputPath,
        filename: this.filename,
        previewContent: this.previewContent,
        renderInput: {
          templateContent: this.currentTemplateContent,
          fieldResults: this.getResolvedFieldResults(),
          sourceTemplateName: template.name,
          sourceNotePath: this.sourceFile.path,
          writeSourceMetadata: this.settingsService.getSettings().writeSourceMetadata,
          fieldConfigs: this.getCurrentFieldContext(),
          semanticConfig: this.getEffectiveSemanticConfig(template),
          structureDescriptor: this.getCurrentTemplateStructureDescriptor(template),
          sectionOverrides,
          frontmatterOverrides
        },
        writeIndexEntry: this.writeIndexEntry,
        indexNotePath: indexPath,
        sourceNotePath: this.sourceFile.path,
        recordManagedIndexEntry: async (entry) => {
          await this.settingsService.upsertManagedIndexEntry(entry);
        },
        syncCreatedNoteIndexMetadata: (createdFile, nextIndexPath) =>
          this.syncCreatedNoteIndexMetadata(createdFile, nextIndexPath)
      });
    } catch (error) {
      void this.recordDiagnostics("generate.failed", {
        status: "error",
        data: {
          templateId: template.id,
          templateName: template.name,
          sourceNotePath: this.sourceFile.path,
          error
        }
      });
      throw error;
    }

    void this.recordDiagnostics("generate.created_note", {
      status: result.templaterError || result.indexError ? "warning" : "success",
      data: {
        templateId: template.id,
        templateName: template.name,
        sourceNotePath: this.sourceFile.path,
        notePath: result.notePath,
        indexUpdated: result.indexUpdated,
        templaterProcessed: result.templaterResult?.processed ?? false,
        templaterRequiresReview: result.templaterResult?.requiresReview ?? false,
        templaterUnsupportedCount: result.templaterResult?.unsupportedExpressions.length ?? 0,
        templaterError: result.templaterError ?? undefined,
        indexError: result.indexError ?? undefined
      }
    });

    if (result.templaterError) {
      const error = result.templaterError;
      console.warn("Note Loom: failed to post-process generated note with Templater.", error);
      new Notice(
        error instanceof Error
          ? t(settings.language, "templater_postprocess_failed", { message: error.message })
          : t(settings.language, "templater_postprocess_failed", { message: "" })
      );
    }

    if (result.templaterResult?.requiresReview) {
      new Notice(
        t(settings.language, "templater_postprocess_requires_review", {
          count: String(result.templaterResult.unsupportedExpressions.length)
        })
      );
    }

    if (result.indexError) {
      const error = result.indexError;
      new Notice(
        error instanceof Error
          ? t(settings.language, "index_update_failed", { message: error.message })
          : t(settings.language, "index_update_failed", { message: "" })
      );
    }

    if (!result.indexUpdated && this.writeIndexEntry) {
      new Notice(t(settings.language, "structured_note_created", { path: result.notePath }));
    } else {
      new Notice(t(settings.language, "structured_note_created_indexed", { path: result.notePath }));
    }

    if (this.openGeneratedNote) {
      await this.app.workspace.getLeaf(true).openFile(result.createdFile);
    }

    this.close();
  }

  private async recordDiagnostics(
    event: string,
    payload: {
      status?: "info" | "success" | "warning" | "error";
      message?: string;
      data?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    await this.diagnosticsService?.record({
      event,
      status: payload.status,
      message: payload.message,
      data: payload.data
    });
  }

  private openTemplateRulesModal(): void {
    const template = this.settingsService.getTemplate(this.selectedTemplateId);
    if (!template) {
      new Notice(t(this.settingsService.getSettings().language, "selected_template_not_found"));
      return;
    }

    new TemplateConfigModal(
      this.app,
      template,
      this.settingsService,
      this.templateScanner,
      () => {
        void this.reloadTemplateAfterRuleEdit();
      }
    ).open();
  }

  private async reloadTemplateAfterRuleEdit(): Promise<void> {
    try {
      await this.loadTemplate(this.selectedTemplateId);
      this.render();
    } catch (error) {
      new Notice(
        error instanceof Error
          ? error.message
          : t(this.settingsService.getSettings().language, "failed_load_template")
      );
    }
  }

  private async saveCurrentFixesToTemplateRules(): Promise<void> {
    const settings = this.settingsService.getSettings();
    const template = this.settingsService.getTemplate(this.selectedTemplateId);
    if (!template) {
      new Notice(t(settings.language, "selected_template_not_found"));
      return;
    }

    const result = this.ruleLearningService.apply(
      template,
      this.getCurrentFieldContext(),
      this.fieldResults
    );
    if (!result.changed) {
      new Notice(t(settings.language, "integrity_save_current_fixes_empty"));
      return;
    }

    await this.settingsService.upsertTemplate(result.template);
    new Notice(
      t(settings.language, "integrity_save_current_fixes_success", {
        count: result.learnedFixCount,
        name: result.template.name
      })
    );
    await this.reloadTemplateAfterRuleEdit();
  }
}
