import {
  App,
  Modal,
  Notice,
  Setting,
  TFile,
  normalizePath
} from "obsidian";

import { t } from "../i18n";
import { SettingsService } from "../services/settings-service";
import {
  buildStructuralMappingConfigFromFields,
  removeStructuralMappingFieldAliases
} from "../services/template-semantic-service";
import type { ResolvedTemplateContent } from "../services/template-include-resolver-service";
import { TemplateSectionConfigService } from "../services/template-section-config-service";
import { TemplateRuntimeAnalysis } from "../services/template-runtime-analysis-service";
import { TemplateRuntimeStateService } from "../services/template-runtime-state-service";
import { buildTemplateRuntimeGateState } from "../services/template-runtime-gate-service";
import {
  isStructuralRuleCandidate,
  resolveStructuralRuleStatus,
  resolveStructuralRuleStatusRank,
  resolveStructuralRuleSummary,
  resolveStructuralRuleSystemTopic,
  resolveStructuralRuleTargetNames,
  resolveStructuralRuleTitle,
  shouldShowStructuralRuleSystemTopic,
} from "../services/template-structural-rule-service";
import { TemplateScanner } from "../services/template-scanner";
import {
  buildTemplateFieldContext,
  finalizeEditableTemplateFieldConfigs,
  resetFieldRecognitionConfig,
  resolveTemplateFieldsFromScan,
  setTemplateFieldAliases,
  setTemplateFieldEnabled
} from "../services/template-field-state-service";
import type {
  ScannedTemplateField,
  TemplateConfig,
  TemplateFieldConfig,
  TemplateIndexStrategy,
  TemplateSectionConfig,
  TemplateSectionMode
} from "../types/template";
import { getVaultFolderPaths, getVaultMarkdownPaths } from "../utils/vault-paths";
import { resolveTemplateFilenameField } from "../utils/template-filename-field";
import {
  createFolderPathDropdownSetting,
  createInfoSetting,
  createModalActionFooter,
  createModalHeading,
  createModalSection,
  createModalTitle,
  createNotePathDropdownSetting,
  createSingleLeftNoteRow,
  prepareModalShell,
} from "./ui-entry";
import { SectionBehaviorConfigModal } from "./section-behavior-config-modal";
import { summarizeTemplateSectionBehavior } from "./section-behavior-labels";
import { StructuralRuleConfigModal } from "./structural-rule-config-modal";
import { replaceConceptFieldById } from "../utils/concept-field-array";

function cloneTemplate(template: TemplateConfig): TemplateConfig {
  return JSON.parse(JSON.stringify(template)) as TemplateConfig;
}

function parseAliases(value: string): string[] {
  return value
    .split(/[,\uFF0C;\uFF1B\r\n]+/)
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}

function ensureFilenameField(
  currentValue: string,
  fields: TemplateFieldConfig[]
): string {
  return resolveTemplateFilenameField(currentValue, fields);
}

function removeRepeatableEntryFields(
  fields: TemplateFieldConfig[],
  sectionConfig: TemplateConfig["sectionConfig"],
  sectionConfigService: TemplateSectionConfigService
): TemplateFieldConfig[] {
  const repeatableFieldNames = sectionConfigService.getInternalRepeatableEntryFieldNames(sectionConfig);
  return fields.filter((field) => !repeatableFieldNames.has(field.name));
}

function markCompactSetting(setting: Setting): Setting {
  setting.settingEl.addClass("note-loom-compact-setting");
  return setting;
}

function markActionSetting(setting: Setting): Setting {
  setting.settingEl.addClass("note-loom-action-setting");
  return setting;
}

export class TemplateConfigModal extends Modal {
  private readonly sectionConfigService = new TemplateSectionConfigService();
  private readonly runtimeStateService: TemplateRuntimeStateService;
  private templateState: TemplateConfig;
  private scannedTemplateFields: ScannedTemplateField[] = [];
  private runtimeAnalysis: TemplateRuntimeAnalysis = {
    level: "static",
    flags: []
  };
  private includeResolution: Pick<ResolvedTemplateContent, "includePaths" | "unresolvedIncludes"> = {
    includePaths: [],
    unresolvedIncludes: []
  };
  private scanSummary = "";
  private showCompletedStructuralRules = false;
  private highlightedStructuralRuleId: string | null = null;
  private structuralRuleHighlightTimeout: number | null = null;

  constructor(
    app: App,
    template: TemplateConfig,
    private readonly settingsService: SettingsService,
    private readonly templateScanner: TemplateScanner,
    private readonly onSaved: () => void
  ) {
    super(app);
    this.runtimeStateService = new TemplateRuntimeStateService(app, templateScanner, this.sectionConfigService);
    this.templateState = cloneTemplate(template);
  }

  onOpen(): void {
    this.ensureStructuralMappingConfig();
    this.render();
    void this.refreshSectionConfigFromTemplate();
  }

  onClose(): void {
    if (this.structuralRuleHighlightTimeout !== null) {
      window.clearTimeout(this.structuralRuleHighlightTimeout);
      this.structuralRuleHighlightTimeout = null;
    }
  }

  private ensureStructuralMappingConfig(): void {
    this.templateState.semanticConfig = buildStructuralMappingConfigFromFields(
      this.getCurrentFieldContext(),
      this.templateState.semanticConfig,
      this.templateState.sectionConfig
    );
  }

  private getCurrentFieldContext() {
    return buildTemplateFieldContext(
      this.templateState.fields,
      this.templateState.sectionConfig,
      this.sectionConfigService
    );
  }

  private render(): void {
    const { contentEl } = this;
    const settings = this.settingsService.getSettings();
    prepareModalShell(contentEl, this.modalEl, "note-loom-template-config-modal");

    createModalTitle(
      contentEl,
      t(settings.language, "edit_template_title", { name: this.templateState.name })
    );

    const generalGroup = createModalSection(contentEl);

    createInfoSetting(generalGroup)
      .setName(t(settings.language, "template_name"))
      .addText((text) =>
        text.setValue(this.templateState.name).onChange((value) => {
          this.templateState.name = value.trim();
        })
      );

    createNotePathDropdownSetting(generalGroup, {
      name: t(settings.language, "template_path"),
      getLanguage: () => this.settingsService.getSettings().language,
      getPaths: () => getVaultMarkdownPaths(this.app),
      emptyLabelKey: "select_template_file_label",
      getCurrentValue: () => this.templateState.path,
      onChange: (value) => {
        this.templateState.path = value;
        this.render();
        void this.refreshSectionConfigFromTemplate();
      }
    });

    markCompactSetting(createInfoSetting(generalGroup))
      .setName(t(settings.language, "enabled"))
      .addToggle((toggle) =>
        toggle.setValue(this.templateState.enabled).onChange((value) => {
          this.templateState.enabled = value;
        })
      );

    this.renderRuntimeAnalysis(generalGroup);

    createModalHeading(contentEl, t(settings.language, "template_defaults"));

    const defaultsGroup = createModalSection(contentEl);

    createFolderPathDropdownSetting(defaultsGroup, {
      name: t(settings.language, "default_output_path"),
      getLanguage: () => this.settingsService.getSettings().language,
      getPaths: () => getVaultFolderPaths(this.app),
      emptyLabelKey: "inherits_global_default",
      getCurrentValue: () => this.templateState.defaultOutputPath,
      onChange: (value) => {
        this.templateState.defaultOutputPath = value;
        this.render();
      }
    });

    markCompactSetting(createInfoSetting(defaultsGroup))
      .setName(t(settings.language, "template_index_strategy"))
      .addDropdown((dropdown) => {
        this.buildTemplateIndexStrategyOptions(settings.language).forEach(([value, label]) => {
          dropdown.addOption(value, label);
        });
        dropdown.setValue(this.templateState.defaultIndexStrategy).onChange((value) => {
          this.templateState.defaultIndexStrategy = value as TemplateIndexStrategy;
          this.templateState.defaultIndexNotePath = "";
          this.render();
        });
      });

    markCompactSetting(createInfoSetting(defaultsGroup))
      .setName(t(settings.language, "filename_field"))
      .addDropdown((dropdown) => {
        const filenameFields = removeRepeatableEntryFields(
          this.templateState.fields,
          this.templateState.sectionConfig,
          this.sectionConfigService
        );
        const fieldNames = filenameFields.map((field) => field.name);

        if (fieldNames.length === 0) {
          dropdown.addOption("", t(settings.language, "no_fields_detected"));
          dropdown.setDisabled(true);
          dropdown.setValue("");
          return;
        }

        const filenameField = ensureFilenameField(this.templateState.filenameField, filenameFields);
        this.templateState.filenameField = filenameField;

        fieldNames.forEach((fieldName) => {
          dropdown.addOption(fieldName, fieldName);
        });

        dropdown.setValue(filenameField).onChange((value) => {
          this.templateState.filenameField = value;
        });
      });

    createModalHeading(contentEl, t(settings.language, "field_scan"));

    const scanGroup = createModalSection(contentEl);

    markActionSetting(createInfoSetting(scanGroup))
      .setName(t(settings.language, "rescan_fields"))
      .addButton((button) =>
        button.setButtonText(t(settings.language, "rescan_fields")).setCta().onClick(async () => {
          await this.rescanFields();
        })
      );

    markActionSetting(createInfoSetting(scanGroup))
      .setName(t(settings.language, "rebuild_recognition_config"))
      .setDesc(t(settings.language, "rebuild_recognition_config_desc"))
      .addButton((button) =>
        button.setButtonText(t(settings.language, "rebuild_recognition_config")).onClick(async () => {
          await this.rebuildRecognitionConfig();
        })
      );

    createSingleLeftNoteRow(
      scanGroup,
      this.scanSummary ||
        t(settings.language, "detected_fields_summary", {
          count: this.templateState.fields.length
        })
    );

    createModalHeading(contentEl, t(settings.language, "section_generation"));

    const sectionGroup = createModalSection(contentEl);
    this.renderSectionConfig(sectionGroup);

    createModalHeading(contentEl, t(settings.language, "field_config"));

    const visibleFields = removeRepeatableEntryFields(
      this.templateState.fields,
      this.templateState.sectionConfig,
      this.sectionConfigService
    );

    if (visibleFields.length === 0) {
      contentEl.createEl("p", {
        cls: "note-loom-section-note",
        text: t(settings.language, "no_fields_detected_hint")
      });
    } else {
      const fieldConfigGroup = createModalSection(
        contentEl,
        "note-loom-field-config-group"
      );
      createSingleLeftNoteRow(
        fieldConfigGroup,
        t(settings.language, "field_config_desc"),
        "note-loom-field-config-note"
      );
      const fieldList = fieldConfigGroup.createDiv({ cls: "note-loom-template-field-list" });
      visibleFields.forEach((field) => this.renderFieldConfig(fieldList, field));
    }

    createModalHeading(
      contentEl,
      t(settings.language, "semantic_mapping"),
      "note-loom-semantic-heading"
    );

    const semanticGroup = createModalSection(contentEl, "note-loom-semantic-section");
    this.renderStructuralRuleOverview(semanticGroup);

    createModalActionFooter(contentEl, {
      actions: [
        {
          text: t(settings.language, "cancel"),
          onClick: () => this.close()
        },
        {
          text: t(settings.language, "save"),
          variant: "cta",
          onClick: async () => {
            await this.saveTemplate();
          }
        }
      ]
    });
  }

  private renderFieldConfig(container: HTMLElement, field: TemplateFieldConfig): void {
    const settings = this.settingsService.getSettings();
    const fieldSetting = createInfoSetting(container);
    fieldSetting.settingEl.addClass("note-loom-template-field-item");
    fieldSetting
      .setName(field.name)
      .addToggle((toggle) =>
        toggle.setValue(field.enabledByDefault).onChange((value) => {
          this.templateState.fields = setTemplateFieldEnabled(
            this.templateState.fields,
            field.name,
            value,
            this.templateState.sectionConfig
          );
          this.render();
        })
      )
      .addText((text) =>
        text
          .setPlaceholder(t(settings.language, "field_aliases_placeholder", { field: field.name }))
          .setValue(field.aliases.join("；"))
          .onChange((value) => {
            const previousAliases =
              this.templateState.fields.find((entry) => entry.name === field.name)?.aliases ?? [];
            const nextAliases = parseAliases(value);
            const removedAliases = previousAliases.filter((alias) => !nextAliases.includes(alias));
            this.templateState.fields = setTemplateFieldAliases(
              this.templateState.fields,
              field.name,
              nextAliases,
              this.templateState.sectionConfig
            );
            this.templateState.semanticConfig = removeStructuralMappingFieldAliases(
              this.templateState.semanticConfig,
              field.name,
              removedAliases
            );
            this.ensureStructuralMappingConfig();
          })
      );

    const scannedOptions = this.getScannedFieldOptions(field.name);
    if (scannedOptions.length > 0) {
      const fieldOptionsSetting = createInfoSetting(container);
      fieldOptionsSetting.settingEl.addClass("note-loom-template-field-item");
      fieldOptionsSetting.settingEl.addClass("note-loom-template-field-options-item");
      const optionsRow = fieldOptionsSetting.controlEl.createDiv({
        cls: "note-loom-field-options-inline-row"
      });
      optionsRow.createSpan({
        cls: "note-loom-field-options-chip-prefix",
        text: t(settings.language, "field_options_compact")
      });
      const chipList = optionsRow.createDiv({
        cls: "note-loom-field-options-chip-list"
      });
      scannedOptions.forEach((option) => {
        const chip = chipList.createDiv({
          cls: "note-loom-field-options-chip"
        });
        chip.createSpan({
          cls: "note-loom-field-options-chip-label",
          text: option
        });
      });
    }
  }

  private syncFieldsWithSectionConfig(): void {
    this.templateState.fields = finalizeEditableTemplateFieldConfigs(
      this.templateState.fields,
      this.templateState.sectionConfig
    );
  }

  private renderRuntimeAnalysis(container: HTMLElement): void {
    const runtimeGateState = buildTemplateRuntimeGateState(this.runtimeAnalysis, {
      includePaths: this.includeResolution.includePaths,
      unresolvedIncludes: this.includeResolution.unresolvedIncludes
    });
    createSingleLeftNoteRow(
      container,
      this.buildRuntimeSummaryText(runtimeGateState)
    );
  }

  private buildRuntimeSummaryText(
    runtimeGateState: ReturnType<typeof buildTemplateRuntimeGateState>
  ): string {
    const language = this.settingsService.getSettings().language;
    const summaryKey =
      runtimeGateState.level === "dynamic"
        ? "template_runtime_summary_dynamic"
        : runtimeGateState.level === "assisted"
          ? "template_runtime_summary_assisted"
          : "template_runtime_summary_static";

    return t(language, summaryKey, {
      reason: this.getRuntimeSummaryReason(runtimeGateState)
    });
  }

  private getRuntimeSummaryReason(
    runtimeGateState: ReturnType<typeof buildTemplateRuntimeGateState>
  ): string {
    const language = this.settingsService.getSettings().language;

    if (this.includeResolution.unresolvedIncludes.length > 0) {
      return t(language, "template_runtime_reason_unresolved_includes", {
        count: this.includeResolution.unresolvedIncludes.length
      });
    }

    const primaryFlag = this.runtimeAnalysis.flags[0];
    if (primaryFlag) {
      return t(language, `template_runtime_flag_${primaryFlag.key}_desc`);
    }

    if (this.includeResolution.includePaths.length > 0 && runtimeGateState.level === "static") {
      return t(language, "template_runtime_reason_resolved_includes", {
        count: this.includeResolution.includePaths.length
      });
    }

    return t(language, "template_runtime_profile_empty");
  }

  private renderSectionConfig(container: HTMLElement): void {
    const settings = this.settingsService.getSettings();
    createSingleLeftNoteRow(container, t(settings.language, "section_generation_desc"));

    const sections = this.templateState.sectionConfig ?? [];
    if (sections.length === 0) {
      createSingleLeftNoteRow(container, t(settings.language, "section_generation_empty"));
      return;
    }

    sections.forEach((section) => {
      const sectionSetting = createInfoSetting(container);
      sectionSetting
        .setName(section.title)
        .setDesc(this.describeSection(section));
      sectionSetting.addDropdown((dropdown) => {
        this.buildSectionModeOptions(settings.language).forEach(([value, label]) => {
          dropdown.addOption(value, label);
        });
        dropdown.setValue(section.mode).onChange((value) => {
          section.mode = value as TemplateSectionMode;
          section.modeSource = "user";
          this.syncFieldsWithSectionConfig();
          this.render();
        });
      });
      sectionSetting.addButton((button) => {
        button
          .setButtonText(
            section.behavior
              ? t(settings.language, "section_behavior_edit")
              : t(settings.language, "section_behavior_configure")
          )
          .setDisabled(section.mode !== "generate")
          .onClick(() => {
            new SectionBehaviorConfigModal(
              this.app,
              section,
              () => this.getCurrentFieldContext(),
              this.settingsService,
              (behavior) => {
                section.behavior = behavior;
                this.syncFieldsWithSectionConfig();
                this.render();
              }
            ).open();
          });
        button.buttonEl.addClass("note-loom-section-inline-action");
      });
    });
  }

  private describeSection(section: TemplateSectionConfig): string {
    const language = this.settingsService.getSettings().language;
    const kindLabel = this.getSectionKindLabel(section, language);
    const fieldCount = section.fieldNames?.length ?? 0;
    const base =
      fieldCount > 0
        ? t(language, "section_generation_item_desc", {
            kind: kindLabel,
            count: fieldCount
          })
        : t(language, "section_generation_item_desc_no_fields", {
          kind: kindLabel
        });
    const behaviorSummary = summarizeTemplateSectionBehavior(section.behavior, language);

    return `${base} · ${behaviorSummary}`;
  }

  private getSectionKindLabel(
    section: TemplateSectionConfig,
    language: ReturnType<SettingsService["getSettings"]>["language"]
  ): string {
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

  private buildSectionModeOptions(
    language: ReturnType<SettingsService["getSettings"]>["language"]
  ): Array<[TemplateSectionMode, string]> {
    return [
      ["generate", t(language, "section_mode_generate")],
      ["preserve", t(language, "section_mode_preserve")],
      ["ignore", t(language, "section_mode_ignore")]
    ];
  }

  private async refreshSectionConfigFromTemplate(): Promise<void> {
    const templateFile = this.app.vault.getAbstractFileByPath(this.templateState.path);
    if (!(templateFile instanceof TFile) || templateFile.extension !== "md") {
      this.scannedTemplateFields = [];
      this.runtimeAnalysis = {
        level: "static",
        flags: []
      };
      this.includeResolution = {
        includePaths: [],
        unresolvedIncludes: []
      };
      return;
    }

    const runtimeState = await this.runtimeStateService.build(this.templateState, templateFile, {
      preferFreshRead: true
    });
    this.runtimeAnalysis = runtimeState.runtimeAnalysis;
    this.includeResolution = {
      includePaths: runtimeState.includeResolution.includePaths,
      unresolvedIncludes: runtimeState.includeResolution.unresolvedIncludes
    };
    const nextSectionConfig = runtimeState.sectionConfig;
    if (!nextSectionConfig) {
      return;
    }

    this.scannedTemplateFields = runtimeState.scannedFields.map((field) => ({
      ...field,
      checkboxOptions: field.checkboxOptions ? [...field.checkboxOptions] : undefined
    }));
    this.templateState.sectionConfig = nextSectionConfig;
    const currentDraftFields = this.applyScannedFieldOptions(
      resolveTemplateFieldsFromScan(
        runtimeState.scannedFields,
        this.templateState.fields,
        nextSectionConfig,
        this.templateState.semanticConfig,
        this.templateState.rulePackConfig
      ),
      runtimeState.scannedFields
    );
    this.templateState.fields = finalizeEditableTemplateFieldConfigs(
      currentDraftFields,
      this.templateState.sectionConfig
    );
    this.templateState.filenameField = ensureFilenameField(
      this.templateState.filenameField,
      removeRepeatableEntryFields(
        this.templateState.fields,
        this.templateState.sectionConfig,
        this.sectionConfigService
      )
    );
    this.ensureStructuralMappingConfig();
    this.render();
  }

  private async refreshRuntimeAnalysisFromTemplate(): Promise<void> {
    const templateFile = this.app.vault.getAbstractFileByPath(this.templateState.path);
    if (!(templateFile instanceof TFile) || templateFile.extension !== "md") {
      this.scannedTemplateFields = [];
      this.runtimeAnalysis = {
        level: "static",
        flags: []
      };
      this.includeResolution = {
        includePaths: [],
        unresolvedIncludes: []
      };
      this.render();
      return;
    }

    const runtimeState = await this.runtimeStateService.build(this.templateState, templateFile, {
      preferFreshRead: true
    });
    this.runtimeAnalysis = runtimeState.runtimeAnalysis;
    this.includeResolution = {
      includePaths: runtimeState.includeResolution.includePaths,
      unresolvedIncludes: runtimeState.includeResolution.unresolvedIncludes
    };
    this.render();
  }

  private renderStructuralRuleOverview(container: HTMLElement): void {
    const settings = this.settingsService.getSettings();
    const fieldContext = this.getCurrentFieldContext();
    const concepts = (this.templateState.semanticConfig?.conceptFields ?? [])
      .map((concept, sourceIndex) => ({
        concept,
        sourceIndex,
        status: resolveStructuralRuleStatus(concept),
        title: resolveStructuralRuleTitle(concept)
      }))
      .filter(({ concept }) => isStructuralRuleCandidate(concept, fieldContext))
      .sort((left, right) => {
        const statusDiff =
          resolveStructuralRuleStatusRank(left.status) - resolveStructuralRuleStatusRank(right.status);
        if (statusDiff !== 0) {
          return statusDiff;
        }

        return left.title.localeCompare(right.title, undefined, {
          numeric: true,
          sensitivity: "base"
        });
      });

    if (concepts.length === 0) {
      container.createEl("p", {
        cls: "note-loom-section-note note-loom-semantic-empty-note",
        text: t(settings.language, "no_semantic_candidates")
      });
      return;
    }

    const completeCount = concepts.filter((item) => item.status === "complete").length;
    const incompleteCount = concepts.length - completeCount;
    const pendingConcepts = concepts.filter((item) => item.status !== "complete");
    const completedConcepts = concepts.filter((item) => item.status === "complete");

    container.createEl("p", {
      cls: "note-loom-section-note note-loom-semantic-section-note",
      text: t(settings.language, "semantic_mapping_desc")
    });
    const summaryRow = container.createDiv({
      cls: "note-loom-structural-rule-summary-row"
    });
    summaryRow.createEl("p", {
      cls: "note-loom-section-note note-loom-semantic-section-note note-loom-structural-rule-summary-text",
      text: t(settings.language, "semantic_mapping_summary", {
        total: concepts.length,
        complete: completeCount,
        incomplete: incompleteCount
      })
    });

    if (pendingConcepts.length === 0) {
      container.createEl("p", {
        cls: "note-loom-section-note note-loom-semantic-empty-note",
        text: t(settings.language, "all_structural_rules_complete")
      });
    } else {
      this.renderStructuralRuleGroup(container, pendingConcepts);
    }

    if (completedConcepts.length > 0) {
      const completedGroup = container.createDiv({
        cls: "note-loom-structural-rule-collapsible-group"
      });
      const completedHeader = completedGroup.createDiv({
        cls: "note-loom-structural-rule-group-header"
      });
      completedHeader.createDiv({
        cls: "note-loom-structural-rule-group-title",
        text: t(settings.language, "completed_structural_rules_group", {
          count: completedConcepts.length
        })
      });
      const completedToggle = completedHeader.createEl("button", {
        text: this.showCompletedStructuralRules
          ? t(settings.language, "hide_completed_structural_rules")
          : t(settings.language, "view_completed_structural_rules")
      });
      completedToggle.addEventListener("click", () => {
        this.showCompletedStructuralRules = !this.showCompletedStructuralRules;
        this.render();
      });

      if (this.showCompletedStructuralRules) {
        const list = completedGroup.createDiv({
          cls: "note-loom-structural-rule-list is-compact"
        });
        completedConcepts.forEach(({ concept, sourceIndex, status }) => {
          this.renderStructuralRuleCard(list, concept, sourceIndex, status, { compact: true });
        });
      }
    }
  }

  private renderStructuralRuleGroup(
    container: HTMLElement,
    items: Array<{
      concept: NonNullable<TemplateConfig["semanticConfig"]>["conceptFields"][number];
      sourceIndex: number;
      status: ReturnType<typeof resolveStructuralRuleStatus>;
      title: string;
    }>
  ): void {
    const list = container.createDiv({ cls: "note-loom-structural-rule-list" });
    items.forEach(({ concept, sourceIndex, status }) => {
      this.renderStructuralRuleCard(list, concept, sourceIndex, status);
    });
  }

  private renderStructuralRuleCard(
    container: HTMLElement,
    concept: NonNullable<TemplateConfig["semanticConfig"]>["conceptFields"][number],
    sourceIndex: number,
    status: ReturnType<typeof resolveStructuralRuleStatus>,
    options?: {
      compact?: boolean;
    }
  ): void {
    const settings = this.settingsService.getSettings();
    const summary = resolveStructuralRuleSummary(concept);
    const title = resolveStructuralRuleTitle(concept);
    const targetNames = resolveStructuralRuleTargetNames(concept);
    const row = container.createDiv({
      cls: `note-loom-structural-rule-row${options?.compact ? " is-compact" : ""} is-${status}${
        this.highlightedStructuralRuleId === concept.id ? " is-recently-updated" : ""
      }`
    });
    const info = row.createDiv({ cls: "note-loom-structural-rule-info" });
    info.createDiv({
      cls: "note-loom-structural-rule-title",
      text: title || t(settings.language, "structural_rule_system_topic_placeholder")
    });
    info.createDiv({
      cls: "note-loom-structural-rule-summary",
      text: t(settings.language, summary.key, summary.vars)
    });

    if (!options?.compact && targetNames.length > 0) {
      info.createDiv({
        cls: "note-loom-structural-rule-meta",
        text: t(settings.language, "structural_rule_target_summary", {
          fields: targetNames.join("；")
        })
      });
    }

    const systemTopic = resolveStructuralRuleSystemTopic(concept);
    if (!options?.compact && shouldShowStructuralRuleSystemTopic(title, systemTopic)) {
      info.createDiv({
        cls: "note-loom-structural-rule-meta",
        text: t(settings.language, "structural_rule_system_topic_summary", {
          topic: systemTopic
        })
      });
    }

    const actions = row.createDiv({ cls: "note-loom-structural-rule-actions" });
    actions.createDiv({
      cls: `note-loom-structural-rule-status-badge is-${status}`,
      text: t(settings.language, `structural_rule_status_${status}`)
    });

    const configureButton = actions.createEl("button", {
      text: status === "complete" ? t(settings.language, "edit") : t(settings.language, "structural_rule_configure")
    });
    if (status !== "complete") {
      configureButton.addClass("mod-cta");
    }
    configureButton.addEventListener("click", () => {
      this.openStructuralRuleConfig(concept, sourceIndex);
    });
  }

  private openStructuralRuleConfig(
    concept: NonNullable<TemplateConfig["semanticConfig"]>["conceptFields"][number],
    sourceIndex: number
  ): void {
    new StructuralRuleConfigModal(
      this.app,
      concept,
      () => this.getCurrentFieldContext(),
      this.settingsService,
      (nextConcept) => {
        const currentSemanticConfig = this.templateState.semanticConfig;
        if (!currentSemanticConfig) {
          return;
        }

        this.templateState.semanticConfig = {
          ...currentSemanticConfig,
          version: Math.max(1, currentSemanticConfig.version || 1),
          conceptFields: replaceConceptFieldById(
            currentSemanticConfig.conceptFields,
            concept.id,
            nextConcept,
            sourceIndex
          )
        };
        this.highlightStructuralRule(nextConcept.id);
        this.render();
      }
    ).open();
  }

  private highlightStructuralRule(conceptId: string): void {
    this.highlightedStructuralRuleId = conceptId;

    if (this.structuralRuleHighlightTimeout !== null) {
      window.clearTimeout(this.structuralRuleHighlightTimeout);
    }

    this.structuralRuleHighlightTimeout = window.setTimeout(() => {
      if (this.highlightedStructuralRuleId === conceptId) {
        this.highlightedStructuralRuleId = null;
        this.render();
      }
      this.structuralRuleHighlightTimeout = null;
    }, 1800);
  }

  private buildTemplateIndexStrategyOptions(
    language: ReturnType<SettingsService["getSettings"]>["language"]
  ): Array<[TemplateIndexStrategy, string]> {
    return [
      ["inherit", t(language, "template_index_strategy_inherit")],
      ["disabled", t(language, "template_index_strategy_disabled")]
    ];
  }

  private async rescanFields(options: { resetRecognitionConfig?: boolean } = {}): Promise<boolean> {
    const settings = this.settingsService.getSettings();
    const templateFile = this.app.vault.getAbstractFileByPath(this.templateState.path);

    if (!(templateFile instanceof TFile) || templateFile.extension !== "md") {
      new Notice(t(settings.language, "template_path_markdown_error"));
      return false;
    }

    const runtimeState = await this.runtimeStateService.build(this.templateState, templateFile, {
      preferFreshRead: true,
      resetRecognitionConfig: options.resetRecognitionConfig
    });
    this.runtimeAnalysis = runtimeState.runtimeAnalysis;
    this.includeResolution = {
      includePaths: runtimeState.includeResolution.includePaths,
      unresolvedIncludes: runtimeState.includeResolution.unresolvedIncludes
    };
    const nextSectionConfig = runtimeState.sectionConfig;
    this.scannedTemplateFields = runtimeState.scannedFields.map((field) => ({
      ...field,
      checkboxOptions: field.checkboxOptions ? [...field.checkboxOptions] : undefined
    }));
    const currentDraftFields = this.applyScannedFieldOptions(
      resolveTemplateFieldsFromScan(
        runtimeState.scannedFields,
        this.templateState.fields,
        nextSectionConfig,
        this.templateState.semanticConfig,
        this.templateState.rulePackConfig
      ),
      runtimeState.scannedFields
    );
    this.templateState.fields = finalizeEditableTemplateFieldConfigs(
      currentDraftFields,
      nextSectionConfig
    );

    this.templateState.filenameField = ensureFilenameField(
      this.templateState.filenameField,
      removeRepeatableEntryFields(
        this.templateState.fields,
        nextSectionConfig,
        this.sectionConfigService
      )
    );
    this.ensureStructuralMappingConfig();
    this.templateState.sectionConfig = nextSectionConfig;

    this.scanSummary = t(settings.language, "detected_fields_from_template", {
      count: runtimeState.scannedFields.length,
      path: templateFile.path
    });
    this.render();
    return true;
  }

  private async rebuildRecognitionConfig(): Promise<void> {
    const settings = this.settingsService.getSettings();
    this.templateState.semanticConfig = undefined;
    this.templateState.fields = resetFieldRecognitionConfig(this.templateState.fields);
    const rescanned = await this.rescanFields({ resetRecognitionConfig: true });
    if (rescanned) {
      new Notice(t(settings.language, "rebuild_recognition_config_success"));
    }
  }

  private getScannedFieldOptions(fieldName: string): string[] {
    const scannedField = this.scannedTemplateFields.find((field) => field.name === fieldName);
    return scannedField?.checkboxOptions ? [...scannedField.checkboxOptions] : [];
  }

  private applyScannedFieldOptions(
    fields: TemplateFieldConfig[],
    scannedFields: ScannedTemplateField[]
  ): TemplateFieldConfig[] {
    const scannedFieldMap = new Map(scannedFields.map((field) => [field.name, field] as const));
    return fields.map((field) => {
      const scannedField = scannedFieldMap.get(field.name);
      if (!scannedField) {
        return field;
      }

      return {
        ...field,
        checkboxOptions: scannedField.checkboxOptions ? [...scannedField.checkboxOptions] : []
      };
    });
  }

  private async saveTemplate(): Promise<void> {
    const settings = this.settingsService.getSettings();
    if (!this.templateState.name.trim()) {
      new Notice(t(settings.language, "template_name_required"));
      return;
    }

    if (!this.templateState.path.trim()) {
      new Notice(t(settings.language, "template_path_required"));
      return;
    }

    const templateFile = this.app.vault.getAbstractFileByPath(this.templateState.path);
    if (!(templateFile instanceof TFile) || templateFile.extension !== "md") {
      new Notice(t(settings.language, "template_path_markdown_error"));
      return;
    }

    this.templateState.path = normalizePath(this.templateState.path);
    this.templateState.filenameField = ensureFilenameField(
      this.templateState.filenameField,
      removeRepeatableEntryFields(
        this.templateState.fields,
        this.templateState.sectionConfig,
        this.sectionConfigService
      )
    );
    this.ensureStructuralMappingConfig();

    await this.settingsService.upsertTemplate(this.templateState);
    new Notice(t(settings.language, "saved_template", { name: this.templateState.name }));
    this.onSaved();
    this.close();
  }
}
