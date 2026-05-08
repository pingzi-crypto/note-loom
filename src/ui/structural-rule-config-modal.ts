import { App, ButtonComponent, Modal, Notice, TextComponent, ToggleComponent } from "obsidian";

import { t } from "../i18n";
import { SettingsService } from "../services/settings-service";
import type { TemplateFieldContext } from "../services/template-field-state-service";
import {
  resolveNonEnumValueType,
  resolveStructuralRuleStatus,
  resolveStructuralRuleSystemTopic,
  resolveStructuralRuleTitle,
} from "../services/template-structural-rule-service";
import type {
  EnumOptionConfig,
  RenderTargetRef,
  StructuralMappingFieldConfig,
} from "../types/template";
import {
  createModalActionFooter,
  createModalSection,
  createSingleLeftNoteRow,
  createModalTitle,
  prepareModalShell
} from "./ui-entry";

function cloneConcept(concept: StructuralMappingFieldConfig): StructuralMappingFieldConfig {
  return JSON.parse(JSON.stringify(concept)) as StructuralMappingFieldConfig;
}

function parseAliases(value: string): string[] {
  return value
    .split(/[,\uFF0C;\uFF1B\r\n]+/)
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}

function serializeDelimitedValues(values: string[]): string {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join("；");
}

function createBlankRenderTargetId(): string {
  return `target-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createBlankEnumOption(): EnumOptionConfig {
  return {
    label: "",
    normalizedValue: "",
    aliases: []
  };
}

export class StructuralRuleConfigModal extends Modal {
  private readonly draft: StructuralMappingFieldConfig;
  private targetSearchQuery = "";

  constructor(
    app: App,
    private readonly concept: StructuralMappingFieldConfig,
    private readonly getFieldContext: () => TemplateFieldContext,
    private readonly settingsService: SettingsService,
    private readonly onSave: (nextConcept: StructuralMappingFieldConfig) => void
  ) {
    super(app);
    this.draft = cloneConcept(concept);
  }

  private getCurrentFieldContext(): TemplateFieldContext {
    return this.getFieldContext();
  }

  private getCurrentFields() {
    return this.getCurrentFieldContext().fields;
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const settings = this.settingsService.getSettings();
    const { contentEl } = this;
    prepareModalShell(
      contentEl,
      this.modalEl,
      "note-loom-template-config-modal",
      "note-loom-structural-rule-modal"
    );

    const title =
      resolveStructuralRuleTitle(this.draft) ||
      t(settings.language, "structural_rule_system_topic_placeholder");

    createModalTitle(
      contentEl,
      t(settings.language, "structural_rule_config_title", { name: title })
    );

    const summaryGroup = createModalSection(contentEl);
    this.renderSummaryBar(summaryGroup);

    const inputGroup = createModalSection(contentEl);
    this.renderSectionIntro(inputGroup, {
      title: t(settings.language, "structural_rule_input_section"),
      description: t(settings.language, "structural_rule_input_section_desc")
    });
    this.renderAliasEditor(inputGroup);

    const outputGroup = createModalSection(contentEl);
    this.renderSectionIntro(outputGroup, {
      title: t(settings.language, "structural_rule_output_section"),
      description: t(settings.language, "structural_rule_output_section_desc")
    });
    this.renderRenderTargetSelector(outputGroup);

    const enumGroup = createModalSection(contentEl);
    this.renderSectionIntro(enumGroup, {
      title: t(settings.language, "structural_rule_enum_section"),
      description: t(settings.language, "structural_rule_enum_section_desc")
    });
    const enumSummaryText =
      this.draft.valueType === "enum"
        ? t(settings.language, "structural_rule_enum_enabled_summary", {
            complete: this.draft.enumOptions.filter(
              (option) => option.label.trim().length > 0 && option.normalizedValue.trim().length > 0
            ).length,
            total: this.draft.enumOptions.length
          })
        : t(settings.language, "structural_rule_enum_disabled_summary");

    this.renderEnumToggleCard(enumGroup, {
      title: t(settings.language, "concept_enum_toggle"),
      summary: enumSummaryText,
      value: this.draft.valueType === "enum",
      onChange: (enabled) => {
        if (enabled) {
          this.draft.valueType = "enum";
          if (this.draft.enumOptions.length === 0) {
            this.draft.enumOptions.push(createBlankEnumOption());
          }
        } else {
          this.draft.valueType = resolveNonEnumValueType(this.draft, this.getCurrentFieldContext());
          this.draft.enumOptions = [];
        }

        this.render();
      }
    });

    if (this.draft.valueType === "enum") {
      const enumControls = enumGroup.createDiv({ cls: "note-loom-structural-rule-enum-section" });
      const noteActionRow = enumControls.createDiv({
        cls: "note-loom-structural-rule-enum-note-action-row"
      });
      noteActionRow.createEl("p", {
        cls:
          "note-loom-section-note note-loom-structural-rule-inline-note note-loom-structural-rule-helper-copy setting-item-description",
        text: t(settings.language, "enum_option_row_desc")
      });
      const addButtonWrap = noteActionRow.createDiv({
        cls: "note-loom-structural-rule-enum-action"
      });
      const addButton = new ButtonComponent(addButtonWrap);
      addButton
        .setButtonText(t(settings.language, "add_enum_option"))
        .onClick(() => {
          this.draft.enumOptions.push(createBlankEnumOption());
          this.render();
        });

      const enumList = enumControls.createDiv({ cls: "note-loom-semantic-enum-list" });
      this.draft.enumOptions.forEach((option, index) => {
        this.renderEnumOption(enumList, option, index);
      });
    }

    createModalActionFooter(contentEl, {
      actions: [
        {
          text: t(settings.language, "cancel"),
          onClick: () => this.close()
        },
        {
          text: t(settings.language, "save"),
          variant: "cta",
          onClick: () => this.commit()
        }
      ]
    });
  }

  private renderSummaryBar(container: HTMLElement): void {
    const settings = this.settingsService.getSettings();
    const systemTopic =
      resolveStructuralRuleSystemTopic(this.draft) ||
      t(settings.language, "structural_rule_system_topic_placeholder");
    const status = resolveStructuralRuleStatus(this.draft);
    const row = container.createDiv({ cls: "note-loom-structural-rule-modal-summary" });
    const topic = row.createDiv({ cls: "note-loom-structural-rule-modal-summary-topic" });
    topic.createSpan({
      cls: "note-loom-structural-rule-modal-summary-label",
      text: `${t(settings.language, "structural_rule_system_topic")}：`
    });
    topic.createSpan({
      cls: [
        "note-loom-structural-rule-modal-summary-value",
        systemTopic === t(settings.language, "structural_rule_system_topic_placeholder")
          ? "is-placeholder"
          : ""
      ].join(" "),
      text: systemTopic
    });
    topic.setAttribute("title", systemTopic);

    row.createDiv({
      cls: `note-loom-structural-rule-status-badge is-${status}`,
      text: t(settings.language, `structural_rule_status_${status}`)
    });
  }

  private renderSectionIntro(
    container: HTMLElement,
    options: {
      title: string;
      description: string;
    }
  ): void {
    const intro = container.createDiv({ cls: "note-loom-structural-rule-section-intro" });
    intro.createDiv({
      cls: "note-loom-structural-rule-section-title setting-item-name",
      text: options.title
    });
    intro.createDiv({
      cls: "note-loom-structural-rule-section-desc setting-item-description",
      text: options.description
    });
  }

  private renderAliasEditor(container: HTMLElement): void {
    const settings = this.settingsService.getSettings();
    const aliases = this.draft.aliases.filter((alias) => alias.trim().length > 0);
    const sourceHints = this.draft.sourceHints.filter((hint) => hint.trim().length > 0);
    const phraseEntries = Array.from(
      new Map(
        [...sourceHints.map((value) => [value, "source_hint"] as const), ...aliases.map((value) => [value, "alias"] as const)]
      ).entries()
    ).map(([value, source]) => ({
      value,
      source
    }));
    const editor = container.createDiv({ cls: "note-loom-structural-rule-alias-editor" });
    const summary = editor.createEl("p", {
      cls: "note-loom-section-note note-loom-structural-rule-section-note",
      text:
        phraseEntries.length === 0
          ? t(settings.language, "structural_rule_input_none_added")
          : t(settings.language, "structural_rule_input_added_summary", {
              count: phraseEntries.length,
              values: phraseEntries.map((entry) => entry.value).join("；")
            })
    });
    summary.setAttribute("title", summary.textContent ?? "");

    if (phraseEntries.length > 0) {
      const chipList = editor.createDiv({ cls: "note-loom-structural-rule-chip-list" });
      phraseEntries.forEach((entry) => {
        const chip = chipList.createDiv({ cls: "note-loom-structural-rule-chip" });
        chip.createSpan({
          cls: "note-loom-structural-rule-chip-label",
          text: entry.value
        });
        if (entry.source === "alias") {
          const removeButton = new ButtonComponent(chip);
          removeButton
            .setButtonText("×")
            .onClick(() => {
              this.draft.aliases = this.draft.aliases.filter((alias) => alias.trim() !== entry.value);
              this.render();
            });
          removeButton.buttonEl.addClass("note-loom-structural-rule-chip-remove");
          removeButton.buttonEl.setAttribute("aria-label", t(settings.language, "remove"));
        }
      });
    }

    const inputRow = editor.createDiv({ cls: "note-loom-structural-rule-add-row" });
    const aliasInput = new TextComponent(inputRow);
    aliasInput.setPlaceholder(t(settings.language, "concept_aliases_placeholder"));
    aliasInput.inputEl.addClass("note-loom-structural-rule-add-input");

    const addButton = new ButtonComponent(inputRow);
    addButton.setButtonText(t(settings.language, "apply_field_value"));

    const commit = (): void => {
      const nextValues = parseAliases(aliasInput.getValue());
      if (nextValues.length === 0) {
        return;
      }

      this.draft.aliases = Array.from(new Set([...aliases, ...nextValues]));
      this.render();
    };

    aliasInput.onChange(() => {
      addButton.setDisabled(parseAliases(aliasInput.getValue()).length === 0);
    });
    aliasInput.inputEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }

      event.preventDefault();
      commit();
    });

    addButton.setDisabled(true).onClick(commit);
  }

  private renderRenderTargetSelector(container: HTMLElement): void {
    const settings = this.settingsService.getSettings();
    const picker = container.createDiv({ cls: "note-loom-structural-rule-target-picker" });
    const summary = picker.createEl("p", {
      cls: "note-loom-section-note note-loom-structural-rule-section-note",
      text: ""
    });

    const searchRow = picker.createDiv({ cls: "note-loom-structural-rule-add-row" });
    const searchInput = new TextComponent(searchRow);
    searchInput.setPlaceholder(t(settings.language, "structural_rule_output_search_placeholder"));
    searchInput.setValue(this.targetSearchQuery);
    searchInput.inputEl.addClass("note-loom-structural-rule-add-input");

    const clearButton = new ButtonComponent(searchRow);
    clearButton.setButtonText(t(settings.language, "clear_selection"));

    const list = picker.createDiv({ cls: "note-loom-structural-rule-target-list" });

    const updateSummary = (): void => {
      const selectedTargetNames = this.draft.renderTargets
        .map((target) => target.fieldName.trim())
        .filter((fieldName) => fieldName.length > 0);
      const text =
        selectedTargetNames.length === 0
          ? t(settings.language, "structural_rule_output_none_selected")
          : t(settings.language, "structural_rule_output_selected_summary", {
              count: selectedTargetNames.length,
              fields: selectedTargetNames.join("；")
            });
      summary.setText(text);
      summary.setAttribute("title", text);
    };

    const renderList = (): void => {
      list.empty();
      clearButton.setDisabled(this.targetSearchQuery.length === 0);
      const normalizedSearch = this.targetSearchQuery.trim().toLocaleLowerCase();
      const selectedTargetNames = this.draft.renderTargets
        .map((target) => target.fieldName.trim())
        .filter((fieldName) => fieldName.length > 0);
      const visibleFields = this.getCurrentFields().filter((field) => {
        if (!normalizedSearch) {
          return true;
        }

        return (
          field.name.toLocaleLowerCase().includes(normalizedSearch) ||
          field.aliases.some((alias) => alias.toLocaleLowerCase().includes(normalizedSearch))
        );
      });

      if (visibleFields.length === 0) {
        list.createEl("p", {
          cls: "note-loom-section-note note-loom-structural-rule-section-note",
          text: t(settings.language, "structural_rule_output_search_empty")
        });
        return;
      }

      visibleFields.forEach((field) => {
        const row = list.createDiv({ cls: "note-loom-structural-rule-target-row" });
        const info = row.createDiv({ cls: "note-loom-structural-rule-target-info" });
        info.createDiv({
          cls: "note-loom-structural-rule-target-name setting-item-name",
          text: field.name
        });
        info.createDiv({
          cls: "note-loom-structural-rule-target-meta setting-item-description",
          text: t(settings.language, "structural_rule_output_field_kind", {
            kind: this.resolveFieldKindLabel(field.kind ?? "text")
          })
        });

        const controls = row.createDiv({ cls: "note-loom-structural-rule-target-control" });
        const toggle = new ToggleComponent(controls);
        toggle.setValue(selectedTargetNames.includes(field.name)).onChange((value) => {
          const nextNames = this.getCurrentFields()
            .map((item) => item.name)
            .filter((fieldName) => {
              if (fieldName === field.name) {
                return value;
              }

              return selectedTargetNames.includes(fieldName);
            });
          this.updateRenderTargetsFromFieldNames(nextNames);
          updateSummary();
          renderList();
        });
      });
    };

    searchInput.onChange((value) => {
      this.targetSearchQuery = value;
      renderList();
    });

    clearButton.onClick(() => {
      this.targetSearchQuery = "";
      searchInput.setValue("");
      renderList();
    });

    updateSummary();
    renderList();
  }

  private renderToggleRow(
    container: HTMLElement,
    options: {
      title: string;
      description?: string;
      value: boolean;
      onChange: (value: boolean) => void;
    }
  ): void {
    const controls = this.createSplitRow(container, {
      title: options.title,
      description: options.description,
      controlsClass: "note-loom-semantic-controls-meta"
    });
    const toggle = new ToggleComponent(controls);
    toggle.setValue(options.value).onChange(options.onChange);
  }

  private renderEnumToggleCard(
    container: HTMLElement,
    options: {
      title: string;
      summary: string;
      value: boolean;
      onChange: (value: boolean) => void;
    }
  ): void {
    const parts = this.createSplitRowParts(container, {
      title: options.title,
      controlsClass: "note-loom-semantic-controls-meta note-loom-structural-rule-enum-toggle-control"
    });
    parts.row.addClass("note-loom-structural-rule-enum-toggle-card");
    const summary = parts.info.createDiv({
      cls: "note-loom-semantic-split-description note-loom-structural-rule-helper-copy note-loom-structural-rule-enum-toggle-summary setting-item-description",
      text: options.summary
    });
    summary.setAttribute("title", options.summary);

    const toggle = new ToggleComponent(parts.controls);
    toggle.setValue(options.value).onChange(options.onChange);
  }

  private renderEnumOption(
    container: HTMLElement,
    option: EnumOptionConfig,
    index: number
  ): void {
    const settings = this.settingsService.getSettings();
    const optionCard = container.createDiv({ cls: "note-loom-semantic-enum-item" });
    const optionGrid = optionCard.createDiv({ cls: "note-loom-semantic-enum-option-grid" });
    const summaryBlock = optionGrid.createDiv({ cls: "note-loom-semantic-enum-option-summary-block" });
    summaryBlock.createDiv({
      cls: "note-loom-semantic-enum-title note-loom-semantic-enum-option-heading setting-item-name",
      text: `${t(settings.language, "enum_option_item")} ${index + 1}`
    });
    summaryBlock.createDiv({
      cls: "note-loom-semantic-enum-description note-loom-structural-rule-helper-copy note-loom-structural-rule-enum-option-summary setting-item-description",
      text:
        option.normalizedValue.trim().length > 0 && option.normalizedValue.trim() !== option.label.trim()
          ? t(settings.language, "enum_option_summary_custom_internal")
          : t(settings.language, "enum_option_summary_default_internal")
    });

    const columnTitles = optionGrid.createDiv({ cls: "note-loom-semantic-enum-column-titles" });
    columnTitles.createDiv({
      cls: "note-loom-semantic-labeled-control-title setting-item-description",
      text: t(settings.language, "enum_option_display_input_label")
    });
    columnTitles.createDiv({
      cls: "note-loom-semantic-labeled-control-title setting-item-description",
      text: t(settings.language, "enum_option_normalized_input_label")
    });
    const inputs = optionGrid.createDiv({ cls: "note-loom-semantic-enum-inputs" });
    const displayControl = inputs.createDiv({ cls: "note-loom-semantic-labeled-control" });
    const normalizedControl = inputs.createDiv({ cls: "note-loom-semantic-labeled-control" });

    const displayInput = new TextComponent(displayControl);
    const normalizedInput = new TextComponent(normalizedControl);

    displayInput
      .setPlaceholder(t(settings.language, "enum_option_display_placeholder"))
      .setValue(option.label)
      .onChange((value) => {
        const previousLabel = option.label.trim();
        const nextLabel = value.trim();
        const shouldMirrorNormalized =
          option.normalizedValue.trim().length === 0 || option.normalizedValue.trim() === previousLabel;

        option.label = nextLabel;

        if (shouldMirrorNormalized) {
          option.normalizedValue = nextLabel;
          normalizedInput.setValue(nextLabel);
        }
      });

    normalizedInput
      .setPlaceholder(t(settings.language, "enum_option_normalized_placeholder"))
      .setValue(option.normalizedValue)
      .onChange((value) => {
        option.normalizedValue = value.trim();
      });
  }

  private createSplitRow(
    container: HTMLElement,
    options: {
      title: string;
      description?: string;
      controlsClass: string;
    }
  ): HTMLElement {
    return this.createSplitRowParts(container, options).controls;
  }

  private createSplitRowParts(
    container: HTMLElement,
    options: {
      title: string;
      description?: string;
      controlsClass: string;
    }
  ): { row: HTMLElement; info: HTMLElement; controls: HTMLElement } {
    const row = container.createDiv({ cls: "note-loom-semantic-split-row note-loom-semantic-split-row-center" });
    const info = row.createDiv({
      cls: "note-loom-semantic-split-info note-loom-info-stack"
    });

    info.createDiv({
      cls: "note-loom-semantic-split-title note-loom-info-stack-line setting-item-name",
      text: options.title
    });

    if (options.description) {
      info.createDiv({
        cls:
          "note-loom-semantic-split-description note-loom-info-stack-line setting-item-description",
        text: options.description
      });
    }

    const controls = row.createDiv({
      cls: `note-loom-semantic-split-controls ${options.controlsClass}`
    });

    return { row, info, controls };
  }

  private resolveTargetKind(fieldName: string): RenderTargetRef["kind"] {
    return this.getCurrentFields().find((field) => field.name === fieldName)?.kind ?? "text";
  }

  private resolveFieldKindLabel(kind: RenderTargetRef["kind"]): string {
    const language = this.settingsService.getSettings().language;
    switch (kind) {
      case "inline_field":
        return t(language, "field_kind_inline_field");
      case "checkbox_group":
        return t(language, "field_kind_checkbox_group");
      case "frontmatter":
        return t(language, "field_kind_frontmatter");
      case "wiki_link":
        return t(language, "field_kind_wiki_link");
      case "text":
      default:
        return t(language, "field_kind_text");
    }
  }

  private updateRenderTargetsFromFieldNames(nextFieldNames: string[]): void {
    const previousTargets = [...this.draft.renderTargets];
    const usedTargetIndexes = new Set<number>();

    this.draft.renderTargets = nextFieldNames.map((fieldName) => {
      const existingIndex = previousTargets.findIndex(
        (target, index) => !usedTargetIndexes.has(index) && target.fieldName === fieldName
      );

      if (existingIndex >= 0) {
        usedTargetIndexes.add(existingIndex);
        const existingTarget = previousTargets[existingIndex];
        if (existingTarget) {
          return {
            id: existingTarget.id,
            fieldName,
            kind: this.resolveTargetKind(fieldName),
            required: existingTarget.required
          };
        }
      }

      return {
        id: createBlankRenderTargetId(),
        fieldName,
        kind: this.resolveTargetKind(fieldName),
        required: true
      };
    });
  }

  private syncConceptLabel(): void {
    if (this.draft.label.trim().length > 0) {
      return;
    }

    this.draft.label = this.draft.renderTargets[0]?.fieldName?.trim() || this.concept.label.trim();
  }

  private commit(): void {
    this.syncConceptLabel();
    this.draft.enumOptions = this.draft.enumOptions.map((option) => ({
      ...option,
      aliases: []
    }));
    this.onSave(cloneConcept(this.draft));
    new Notice(
      t(this.settingsService.getSettings().language, "saved_structural_rule", {
        name: this.draft.label || this.concept.label || this.concept.id
      })
    );
    this.close();
  }
}
