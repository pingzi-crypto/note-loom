import { App, Modal, Notice } from "obsidian";

import { t } from "../i18n";
import { SettingsService } from "../services/settings-service";
import type { TemplateFieldContext } from "../services/template-field-state-service";
import type {
  TemplateFieldConfig,
  TemplateSectionBehaviorConfig,
  TemplateSectionBehaviorFieldConfig,
  TemplateSectionBehaviorGroupConfig,
  TemplateSectionMixedFieldBlockFieldConfig,
  TemplateSectionMixedFieldBlockItemConfig,
  TemplateSectionMixedFieldBlockOptionConfig,
  TemplateSectionConfig
} from "../types/template";
import {
  createInfoSetting,
  createModalActionFooter,
  createModalSection,
  createModalTitle,
  createSingleLeftNoteRow,
  prepareModalShell
} from "./ui-entry";
import { getSectionBehaviorTypeLabel } from "./section-behavior-labels";

function cloneBehavior(
  behavior: TemplateSectionBehaviorConfig | undefined
): TemplateSectionBehaviorConfig | undefined {
  return behavior ? (JSON.parse(JSON.stringify(behavior)) as TemplateSectionBehaviorConfig) : undefined;
}

function parseAliases(value: string): string[] {
  return value
    .split(/[,\uFF0C;\uFF1B\r\n]+/)
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}

function serializeAliases(values: string[] | undefined): string {
  return (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join("；");
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createFieldDraft(label = ""): TemplateSectionBehaviorFieldConfig {
  return {
    id: createId("field"),
    label,
    aliases: [],
    inputKind: undefined
  };
}

function createGroupDraft(label = ""): TemplateSectionBehaviorGroupConfig {
  return {
    id: createId("group"),
    label,
    aliases: [],
    presenceFieldName: undefined
  };
}

function createDefaultBehavior(
  type:
    | "repeatable_text"
    | "task_list"
    | "field_block"
    | "grouped_field_block"
    | "table_block"
    | "mixed_field_block"
): TemplateSectionBehaviorConfig {
  switch (type) {
    case "repeatable_text":
      return {
        kind: "repeatable_text",
        sourceAliases: [],
        parserId: undefined,
        overrideMode: "append"
      };
    case "task_list":
      return {
        kind: "task_list",
        sourceAliases: [],
        taskPrefix: "- [ ] ",
        overrideMode: "replace"
      };
    case "grouped_field_block":
      return {
        kind: "grouped_field_block",
        sourceAliases: [],
        groups: [createGroupDraft()],
        fields: [createFieldDraft()],
        fallbackFieldId: undefined,
        groupHeadingPrefix: "> ## ",
        linePrefix: "> - ",
        separator: "：",
        overrideMode: "replace"
      };
    case "table_block":
      return {
        kind: "table_block",
        sourceAliases: [],
        columns: [createFieldDraft()],
        overrideMode: "replace"
      };
    case "mixed_field_block":
      return {
        kind: "mixed_field_block",
        sourceAliases: [],
        items: [
          {
            id: createId("mixed-item"),
            kind: "text_field",
            label: "",
            aliases: [],
            targetFieldName: undefined,
            inputKind: "text"
          }
        ],
        overrideMode: "replace"
      };
    default:
      return {
        kind: "field_block",
        sourceAliases: [],
        fields: [createFieldDraft()],
        linePrefix: "> - ",
        separator: "：",
        overrideMode: "replace"
      };
  }
}

function resolveBehaviorTypeKey(
  behavior: TemplateSectionBehaviorConfig | undefined
):
  | "none"
  | "repeatable_text"
  | "task_list"
  | "field_block"
  | "grouped_field_block"
  | "table_block"
  | "mixed_field_block" {
  return behavior?.kind ?? "none";
}

function createMixedFieldItem(label = ""): Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "text_field" }> {
  return {
    id: createId("mixed-item"),
    kind: "text_field",
    label,
    aliases: [],
    targetFieldName: undefined,
    inputKind: "text"
  };
}

function createMixedInlineField(
  label = "",
  fieldName = ""
): TemplateSectionMixedFieldBlockFieldConfig {
  return {
    id: createId("mixed-inline-field"),
    label,
    fieldName,
    aliases: []
  };
}

function createMixedOption(label = ""): TemplateSectionMixedFieldBlockOptionConfig {
  return {
    id: createId("mixed-option"),
    label,
    value: label,
    aliases: []
  };
}

function createMixedTaskListItem(
  label = ""
): Extract<TemplateSectionMixedFieldBlockItemConfig, { kind: "task_list" }> {
  return {
    id: createId("mixed-item"),
    kind: "task_list",
    label,
    aliases: [],
    targetFieldName: undefined,
    taskPrefix: "- [ ] "
  };
}

export class SectionBehaviorConfigModal extends Modal {
  private draftBehavior: TemplateSectionBehaviorConfig | undefined;

  constructor(
    app: App,
    private readonly section: TemplateSectionConfig,
    private readonly getFieldContext: () => TemplateFieldContext,
    private readonly settingsService: SettingsService,
    private readonly onSave: (behavior: TemplateSectionBehaviorConfig | undefined) => void
  ) {
    super(app);
    this.draftBehavior = cloneBehavior(section.behavior);
  }

  private getCurrentFieldContext(): TemplateFieldContext {
    return this.getFieldContext();
  }

  private getCurrentFields(): TemplateFieldConfig[] {
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
      "note-loom-section-behavior-modal"
    );

    createModalTitle(
      contentEl,
      t(settings.language, "section_behavior_config_title", { name: this.section.title })
    );

    const basicGroup = createModalSection(contentEl);

    createInfoSetting(basicGroup)
      .setName(t(settings.language, "section_behavior_type"))
      .addDropdown((dropdown) => {
        (
          [
            "none",
            "repeatable_text",
            "task_list",
            "field_block",
            "table_block",
            "grouped_field_block",
            "mixed_field_block"
          ] as const
        ).forEach((type) => {
          dropdown.addOption(type, getSectionBehaviorTypeLabel(type, settings.language));
        });
        dropdown.setValue(this.draftBehavior?.kind ?? "none").onChange((value) => {
          if (value === "none") {
            this.draftBehavior = undefined;
          } else {
            this.draftBehavior = createDefaultBehavior(
              value as
                | "repeatable_text"
                | "task_list"
                | "field_block"
                | "grouped_field_block"
                | "table_block"
                | "mixed_field_block"
            );
          }
          this.render();
        });
      });
    createSingleLeftNoteRow(
      basicGroup,
      t(
        settings.language,
        `section_behavior_type_hint_${resolveBehaviorTypeKey(this.draftBehavior)}`
      )
    );

    if (this.draftBehavior) {
      const aliasesGroup = createModalSection(contentEl);
      createInfoSetting(aliasesGroup)
        .setName(t(settings.language, "section_behavior_source_aliases"))
        .setDesc(t(settings.language, "section_behavior_source_aliases_desc"))
        .addText((text) => {
          text
            .setPlaceholder(t(settings.language, "section_behavior_source_aliases_placeholder"))
            .setValue(serializeAliases(this.draftBehavior?.sourceAliases))
            .onChange((value) => {
              if (!this.draftBehavior) {
                return;
              }
              this.draftBehavior.sourceAliases = parseAliases(value);
            });
        });

      createInfoSetting(aliasesGroup)
        .setName(t(settings.language, "section_behavior_override_mode"))
        .setDesc(t(settings.language, "section_behavior_override_mode_desc"))
        .addDropdown((dropdown) => {
          dropdown.addOption("append", t(settings.language, "section_behavior_override_append"));
          dropdown.addOption("replace", t(settings.language, "section_behavior_override_replace"));
          dropdown
            .setValue(this.draftBehavior?.overrideMode ?? "replace")
            .onChange((value) => {
              if (!this.draftBehavior) {
                return;
              }
              this.draftBehavior.overrideMode = value as "append" | "replace";
            });
        });

      if (this.draftBehavior.kind === "repeatable_text") {
        this.renderRepeatableEditor(contentEl);
      } else if (this.draftBehavior.kind === "task_list") {
        this.renderTaskListEditor(contentEl);
      } else if (this.draftBehavior.kind === "field_block") {
        this.renderFieldBlockEditor(contentEl);
      } else if (this.draftBehavior.kind === "table_block") {
        this.renderTableBlockEditor(contentEl);
      } else if (this.draftBehavior.kind === "grouped_field_block") {
        this.renderGroupedFieldBlockEditor(contentEl);
      } else if (this.draftBehavior.kind === "mixed_field_block") {
        this.renderMixedFieldBlockEditor(contentEl);
      }
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

  private renderRepeatableEditor(_contentEl: HTMLElement): void {
    const behavior = this.draftBehavior;
    if (!behavior || behavior.kind !== "repeatable_text") {
      return;
    }
  }

  private renderFieldBlockEditor(contentEl: HTMLElement): void {
    const settings = this.settingsService.getSettings();
    const behavior = this.draftBehavior;
    if (!behavior || behavior.kind !== "field_block") {
      return;
    }

    const layoutGroup = createModalSection(contentEl);
    createSingleLeftNoteRow(layoutGroup, t(settings.language, "section_behavior_field_block_desc"));
    this.renderLineFormatSettings(layoutGroup, behavior, false);

    const fieldListGroup = createModalSection(contentEl);
    this.renderFieldList(fieldListGroup, behavior.fields, () => this.render(), false);
  }

  private renderTaskListEditor(contentEl: HTMLElement): void {
    const settings = this.settingsService.getSettings();
    const behavior = this.draftBehavior;
    if (!behavior || behavior.kind !== "task_list") {
      return;
    }

    const taskGroup = createModalSection(contentEl);
    createSingleLeftNoteRow(taskGroup, t(settings.language, "section_behavior_task_list_desc"));

    createInfoSetting(taskGroup)
      .setName(t(settings.language, "section_behavior_task_prefix"))
      .setDesc(t(settings.language, "section_behavior_task_prefix_desc"))
      .addText((text) => {
        text.setValue(behavior.taskPrefix ?? "").onChange((value) => {
          if (!this.draftBehavior || this.draftBehavior.kind !== "task_list") {
            return;
          }
          this.draftBehavior.taskPrefix = value;
        });
      });
  }

  private renderTableBlockEditor(contentEl: HTMLElement): void {
    const settings = this.settingsService.getSettings();
    const behavior = this.draftBehavior;
    if (!behavior || behavior.kind !== "table_block") {
      return;
    }

    const tableGroup = createModalSection(contentEl);
    createSingleLeftNoteRow(tableGroup, t(settings.language, "section_behavior_table_block_desc"));

    const columnListGroup = createModalSection(contentEl);
    this.renderFieldList(columnListGroup, behavior.columns, () => this.render(), true);
  }

  private renderGroupedFieldBlockEditor(contentEl: HTMLElement): void {
    const settings = this.settingsService.getSettings();
    const behavior = this.draftBehavior;
    if (!behavior || behavior.kind !== "grouped_field_block") {
      return;
    }

    const groupGroup = createModalSection(contentEl);
    createSingleLeftNoteRow(groupGroup, t(settings.language, "section_behavior_grouped_field_block_desc"));
    this.renderGroupList(groupGroup, behavior.groups, () => this.render());

    const formatGroup = createModalSection(contentEl);
    this.renderLineFormatSettings(formatGroup, behavior, true);

    const fieldGroup = createModalSection(contentEl);
    this.renderFieldList(fieldGroup, behavior.fields, () => this.render(), true);

    createInfoSetting(fieldGroup)
      .setName(t(settings.language, "section_behavior_fallback_field"))
      .setDesc(t(settings.language, "section_behavior_fallback_field_desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("", t(settings.language, "none_label"));
        behavior.fields.forEach((field) => {
          dropdown.addOption(field.id, field.label || field.id);
        });
        dropdown.setValue(behavior.fallbackFieldId ?? "").onChange((value) => {
          if (!this.draftBehavior || this.draftBehavior.kind !== "grouped_field_block") {
            return;
          }
          this.draftBehavior.fallbackFieldId = value || undefined;
        });
      });
  }

  private renderLineFormatSettings(
    container: HTMLElement,
    behavior:
      | Extract<TemplateSectionBehaviorConfig, { kind: "field_block" }>
      | Extract<TemplateSectionBehaviorConfig, { kind: "grouped_field_block" }>,
    showGroupHeading: boolean
  ): void {
    const settings = this.settingsService.getSettings();

    if (showGroupHeading && behavior.kind === "grouped_field_block") {
      createInfoSetting(container)
        .setName(t(settings.language, "section_behavior_group_heading_prefix"))
        .setDesc(t(settings.language, "section_behavior_group_heading_prefix_desc"))
        .addText((text) => {
          text.setValue(behavior.groupHeadingPrefix ?? "").onChange((value) => {
            if (!this.draftBehavior || this.draftBehavior.kind !== "grouped_field_block") {
              return;
            }
            this.draftBehavior.groupHeadingPrefix = value;
          });
        });
    }

    createInfoSetting(container)
      .setName(t(settings.language, "section_behavior_line_prefix"))
      .setDesc(t(settings.language, "section_behavior_line_prefix_desc"))
      .addText((text) => {
        text.setValue(behavior.linePrefix ?? "").onChange((value) => {
          if (
            !this.draftBehavior ||
            (this.draftBehavior.kind !== "field_block" && this.draftBehavior.kind !== "grouped_field_block")
          ) {
            return;
          }
          this.draftBehavior.linePrefix = value;
        });
      });

    createInfoSetting(container)
      .setName(t(settings.language, "section_behavior_separator"))
      .setDesc(t(settings.language, "section_behavior_separator_desc"))
      .addText((text) => {
        text.setValue(behavior.separator ?? "").onChange((value) => {
          if (
            !this.draftBehavior ||
            (this.draftBehavior.kind !== "field_block" && this.draftBehavior.kind !== "grouped_field_block")
          ) {
            return;
          }
          this.draftBehavior.separator = value;
        });
      });
  }

  private renderFieldList(
    container: HTMLElement,
    fields: TemplateSectionBehaviorFieldConfig[],
    rerender: () => void,
    compactTextDefault: boolean
  ): void {
    const settings = this.settingsService.getSettings();
    createInfoSetting(container)
      .setName(t(settings.language, "section_behavior_fields"))
      .addButton((button) => {
        button.setButtonText(t(settings.language, "section_behavior_add_field")).onClick(() => {
          fields.push(createFieldDraft());
          rerender();
        });
      });

    const list = container.createDiv({
      cls: "note-loom-structural-rule-list note-loom-section-behavior-rule-list is-compact"
    });
    fields.forEach((field, index) => {
      createInfoSetting(list)
        .setName(t(settings.language, "section_behavior_field_label"))
        .addText((text) => {
          text
            .setPlaceholder(t(settings.language, "section_behavior_field_label_placeholder"))
            .setValue(field.label)
            .onChange((value) => {
              field.label = value.trim();
            });
        });

      createInfoSetting(list)
        .setName(t(settings.language, "section_behavior_field_aliases"))
        .setDesc(t(settings.language, "section_behavior_field_aliases_desc"))
        .addText((text) => {
          text
            .setPlaceholder(t(settings.language, "section_behavior_field_aliases_placeholder"))
            .setValue(serializeAliases(field.aliases))
            .onChange((value) => {
              field.aliases = parseAliases(value);
            });
        });

      createInfoSetting(list)
        .setName(t(settings.language, "section_behavior_input_kind"))
        .setDesc(t(settings.language, "section_behavior_input_kind_desc"))
        .addDropdown((dropdown) => {
          dropdown.addOption("textarea", t(settings.language, "section_behavior_input_kind_textarea"));
          dropdown.addOption("text", t(settings.language, "section_behavior_input_kind_text"));
          dropdown
            .setValue(field.inputKind ?? (compactTextDefault ? "textarea" : "textarea"))
            .onChange((value) => {
              field.inputKind = value === "text" ? "text" : undefined;
            });
        })
        .addButton((button) => {
          button
            .setWarning()
            .setButtonText(t(settings.language, "remove"))
            .onClick(() => {
              fields.splice(index, 1);
              rerender();
            });
        });
    });
  }

  private renderGroupList(
    container: HTMLElement,
    groups: TemplateSectionBehaviorGroupConfig[],
    rerender: () => void
  ): void {
    const settings = this.settingsService.getSettings();
    createInfoSetting(container)
      .setName(t(settings.language, "section_behavior_groups"))
      .addButton((button) => {
        button.setButtonText(t(settings.language, "section_behavior_add_group")).onClick(() => {
          groups.push(createGroupDraft());
          rerender();
        });
      });

    const list = container.createDiv({
      cls: "note-loom-structural-rule-list note-loom-section-behavior-rule-list is-compact"
    });
    groups.forEach((group, index) => {
      createInfoSetting(list)
        .setName(t(settings.language, "section_behavior_group_label"))
        .addText((text) => {
          text
            .setPlaceholder(t(settings.language, "section_behavior_group_label_placeholder"))
            .setValue(group.label)
            .onChange((value) => {
              group.label = value.trim();
            });
        });

      createInfoSetting(list)
        .setName(t(settings.language, "section_behavior_group_aliases"))
        .setDesc(t(settings.language, "section_behavior_group_aliases_desc"))
        .addText((text) => {
          text
            .setPlaceholder(t(settings.language, "section_behavior_group_aliases_placeholder"))
            .setValue(serializeAliases(group.aliases))
            .onChange((value) => {
              group.aliases = parseAliases(value);
            });
        });

      createInfoSetting(list)
        .setName(t(settings.language, "section_behavior_presence_field"))
        .setDesc(t(settings.language, "section_behavior_presence_field_desc"))
        .addDropdown((dropdown) => {
          dropdown.addOption("", t(settings.language, "none_label"));
          this.getCurrentFields().forEach((field) => {
            dropdown.addOption(field.name, field.name);
          });
          dropdown.setValue(group.presenceFieldName ?? "").onChange((value) => {
            group.presenceFieldName = value || undefined;
          });
        })
        .addButton((button) => {
          button
            .setWarning()
            .setButtonText(t(settings.language, "remove"))
            .onClick(() => {
              groups.splice(index, 1);
              rerender();
            });
      });
    });
  }

  private renderMixedFieldBlockEditor(contentEl: HTMLElement): void {
    const settings = this.settingsService.getSettings();
    const behavior = this.draftBehavior;
    if (!behavior || behavior.kind !== "mixed_field_block") {
      return;
    }

    const itemGroup = createModalSection(contentEl);
    createSingleLeftNoteRow(itemGroup, t(settings.language, "section_behavior_mixed_field_block_desc"));

    createInfoSetting(itemGroup)
      .setName(t(settings.language, "section_behavior_items"))
      .addButton((button) => {
        button.setButtonText(t(settings.language, "section_behavior_add_item")).onClick(() => {
          behavior.items.push(createMixedFieldItem());
          this.render();
        });
      });

    behavior.items.forEach((item, index) => {
      const itemCard = createModalSection(
        contentEl,
        "note-loom-section-behavior-item-section"
      );

      createInfoSetting(itemCard)
        .setName(t(settings.language, "section_behavior_item_kind"))
        .addDropdown((dropdown) => {
          dropdown.addOption("text_field", t(settings.language, "section_behavior_item_kind_text_field"));
          dropdown.addOption(
            "inline_field_group",
            t(settings.language, "section_behavior_item_kind_inline_field_group")
          );
          dropdown.addOption("checkbox_enum", t(settings.language, "section_behavior_item_kind_checkbox_enum"));
          dropdown.addOption("task_list", t(settings.language, "section_behavior_item_kind_task_list"));
          dropdown.addOption("static_note", t(settings.language, "section_behavior_item_kind_static_note"));
          dropdown.setValue(item.kind).onChange((value) => {
            if (!this.draftBehavior || this.draftBehavior.kind !== "mixed_field_block") {
              return;
            }

            const label = item.label;
            switch (value) {
              case "inline_field_group":
                behavior.items[index] = {
                  id: item.id,
                  kind: "inline_field_group",
                  label,
                  aliases: "aliases" in item ? (item.aliases ?? []) : [],
                  fields: [createMixedInlineField()]
                };
                break;
              case "checkbox_enum":
                behavior.items[index] = {
                  id: item.id,
                  kind: "checkbox_enum",
                  label,
                  aliases: "aliases" in item ? (item.aliases ?? []) : [],
                  targetFieldName:
                    "targetFieldName" in item ? item.targetFieldName ?? undefined : undefined,
                  selectMode: "single",
                  options: [createMixedOption()]
                };
                break;
              case "task_list":
                behavior.items[index] = {
                  id: item.id,
                  kind: "task_list",
                  label,
                  aliases: "aliases" in item ? (item.aliases ?? []) : [],
                  targetFieldName:
                    "targetFieldName" in item ? item.targetFieldName ?? undefined : undefined,
                  taskPrefix:
                    "taskPrefix" in item && typeof item.taskPrefix === "string"
                      ? item.taskPrefix
                      : createMixedTaskListItem(label).taskPrefix
                };
                break;
              case "static_note":
                behavior.items[index] = {
                  id: item.id,
                  kind: "static_note",
                  label,
                  content: ""
                };
                break;
              default:
                behavior.items[index] = {
                  id: item.id,
                  kind: "text_field",
                  label,
                  aliases: "aliases" in item ? (item.aliases ?? []) : [],
                  targetFieldName:
                    "targetFieldName" in item ? item.targetFieldName ?? undefined : undefined,
                  inputKind: "text"
                };
                break;
            }
            this.render();
          });
        })
        .addButton((button) => {
          button
            .setWarning()
            .setButtonText(t(settings.language, "remove"))
            .onClick(() => {
              behavior.items.splice(index, 1);
              this.render();
            });
        });

      createInfoSetting(itemCard)
        .setName(t(settings.language, "section_behavior_item_label"))
        .addText((text) => {
          text.setValue(item.label).onChange((value) => {
            item.label = value.trim();
          });
        });

      if (item.kind !== "static_note") {
        createInfoSetting(itemCard)
          .setName(t(settings.language, "section_behavior_item_aliases"))
          .setDesc(t(settings.language, "section_behavior_field_aliases_desc"))
          .addText((text) => {
            text.setValue(serializeAliases(item.aliases)).onChange((value) => {
              item.aliases = parseAliases(value);
            });
          });
      }

      if (item.kind === "text_field") {
        createInfoSetting(itemCard)
          .setName(t(settings.language, "section_behavior_item_target_field"))
          .addDropdown((dropdown) => {
            dropdown.addOption("", t(settings.language, "none_label"));
            this.getCurrentFields().forEach((field) => {
              dropdown.addOption(field.name, field.name);
            });
            dropdown.setValue(item.targetFieldName ?? "").onChange((value) => {
              item.targetFieldName = value || undefined;
            });
          });

        createInfoSetting(itemCard)
          .setName(t(settings.language, "section_behavior_input_kind"))
          .setDesc(t(settings.language, "section_behavior_input_kind_desc"))
          .addDropdown((dropdown) => {
            dropdown.addOption("text", t(settings.language, "section_behavior_input_kind_text"));
            dropdown.addOption("textarea", t(settings.language, "section_behavior_input_kind_textarea"));
            dropdown.setValue(item.inputKind ?? "textarea").onChange((value) => {
              item.inputKind = value === "text" ? "text" : undefined;
            });
          });
      }

      if (item.kind === "inline_field_group") {
        this.renderMixedInlineFieldList(itemCard, item.fields);
      }

      if (item.kind === "checkbox_enum") {
        createInfoSetting(itemCard)
          .setName(t(settings.language, "section_behavior_item_target_field"))
          .addDropdown((dropdown) => {
            dropdown.addOption("", t(settings.language, "none_label"));
            this.getCurrentFields().forEach((field) => {
              dropdown.addOption(field.name, field.name);
            });
            dropdown.setValue(item.targetFieldName ?? "").onChange((value) => {
              item.targetFieldName = value || undefined;
            });
          });

        createInfoSetting(itemCard)
          .setName(t(settings.language, "section_behavior_item_select_mode"))
          .addDropdown((dropdown) => {
            dropdown.addOption("single", t(settings.language, "section_behavior_item_select_mode_single"));
            dropdown.addOption("multi", t(settings.language, "section_behavior_item_select_mode_multi"));
            dropdown.setValue(item.selectMode ?? "single").onChange((value) => {
              item.selectMode = value === "multi" ? "multi" : "single";
            });
          });

        this.renderMixedOptionList(itemCard, item.options);
      }

      if (item.kind === "task_list") {
        createInfoSetting(itemCard)
          .setName(t(settings.language, "section_behavior_item_target_field"))
          .addDropdown((dropdown) => {
            dropdown.addOption("", t(settings.language, "none_label"));
            this.getCurrentFields().forEach((field) => {
              dropdown.addOption(field.name, field.name);
            });
            dropdown.setValue(item.targetFieldName ?? "").onChange((value) => {
              item.targetFieldName = value || undefined;
            });
          });

        createInfoSetting(itemCard)
          .setName(t(settings.language, "section_behavior_item_task_prefix"))
          .setDesc(t(settings.language, "section_behavior_item_task_prefix_desc"))
          .addText((text) => {
            text.setValue(item.taskPrefix ?? "- [ ] ").onChange((value) => {
              item.taskPrefix = value;
            });
          });
      }

      if (item.kind === "static_note") {
        createInfoSetting(itemCard)
          .setName(t(settings.language, "section_behavior_item_content"))
          .addTextArea((text) => {
            text.setValue(item.content ?? "").onChange((value) => {
              item.content = value;
            });
            text.inputEl.rows = 2;
          });
      }
    });
  }

  private renderMixedInlineFieldList(
    container: HTMLElement,
    fields: TemplateSectionMixedFieldBlockFieldConfig[]
  ): void {
    const settings = this.settingsService.getSettings();
    createInfoSetting(container)
      .setName(t(settings.language, "section_behavior_item_fields"))
      .addButton((button) => {
        button.setButtonText(t(settings.language, "section_behavior_item_add_inline_field")).onClick(() => {
          fields.push(createMixedInlineField());
          this.render();
        });
      });

    fields.forEach((field, index) => {
      createInfoSetting(container)
        .setName(t(settings.language, "section_behavior_item_field_label"))
        .addText((text) => {
          text.setValue(field.label).onChange((value) => {
            field.label = value.trim();
          });
        });

      createInfoSetting(container)
        .setName(t(settings.language, "section_behavior_item_field_target"))
        .addDropdown((dropdown) => {
          dropdown.addOption("", t(settings.language, "none_label"));
          this.getCurrentFields().forEach((templateField) => {
            dropdown.addOption(templateField.name, templateField.name);
          });
          dropdown.setValue(field.fieldName).onChange((value) => {
            field.fieldName = value;
            if (!field.label) {
              field.label = value;
            }
          });
        })
        .addButton((button) => {
          button
            .setWarning()
            .setButtonText(t(settings.language, "remove"))
            .onClick(() => {
              fields.splice(index, 1);
              this.render();
            });
        });
    });
  }

  private renderMixedOptionList(
    container: HTMLElement,
    options: TemplateSectionMixedFieldBlockOptionConfig[]
  ): void {
    const settings = this.settingsService.getSettings();
    createInfoSetting(container)
      .setName(t(settings.language, "section_behavior_item_options"))
      .addButton((button) => {
        button.setButtonText(t(settings.language, "section_behavior_item_add_option")).onClick(() => {
          options.push(createMixedOption());
          this.render();
        });
      });

    options.forEach((option, index) => {
      createInfoSetting(container)
        .setName(t(settings.language, "section_behavior_item_option_label"))
        .addText((text) => {
          text.setValue(option.label).onChange((value) => {
            option.label = value.trim();
          });
        });

      createInfoSetting(container)
        .setName(t(settings.language, "section_behavior_item_option_value"))
        .addText((text) => {
          text.setValue(option.value).onChange((value) => {
            option.value = value.trim();
          });
        });

      createInfoSetting(container)
        .setName(t(settings.language, "section_behavior_item_option_aliases"))
        .addText((text) => {
          text.setValue(serializeAliases(option.aliases)).onChange((value) => {
            option.aliases = parseAliases(value);
          });
        })
        .addButton((button) => {
          button
            .setWarning()
            .setButtonText(t(settings.language, "remove"))
            .onClick(() => {
              options.splice(index, 1);
              this.render();
            });
        });
    });
  }

  private commit(): void {
    const settings = this.settingsService.getSettings();
    const behavior = this.draftBehavior;

    if (!behavior) {
      this.onSave(undefined);
      this.close();
      return;
    }

    if (behavior.kind === "field_block") {
      const validFields = behavior.fields.filter((field) => field.label.trim().length > 0);
      if (validFields.length === 0) {
        new Notice(t(settings.language, "section_behavior_validation_fields_required"));
        return;
      }
      behavior.fields = validFields;
    }

    if (behavior.kind === "table_block") {
      const validColumns = behavior.columns.filter((field) => field.label.trim().length > 0);
      if (validColumns.length === 0) {
        new Notice(t(settings.language, "section_behavior_validation_fields_required"));
        return;
      }
      behavior.columns = validColumns;
    }

    if (behavior.kind === "grouped_field_block") {
      const validGroups = behavior.groups.filter((group) => group.label.trim().length > 0);
      const validFields = behavior.fields.filter((field) => field.label.trim().length > 0);
      if (validGroups.length === 0) {
        new Notice(t(settings.language, "section_behavior_validation_groups_required"));
        return;
      }
      if (validFields.length === 0) {
        new Notice(t(settings.language, "section_behavior_validation_fields_required"));
        return;
      }

      behavior.groups = validGroups;
      behavior.fields = validFields;
      if (!behavior.fields.some((field) => field.id === behavior.fallbackFieldId)) {
        behavior.fallbackFieldId = undefined;
      }
    }

    if (behavior.kind === "mixed_field_block") {
      const validItems = behavior.items.filter((item) => {
        if (!item.label.trim()) {
          return false;
        }

        if (item.kind === "inline_field_group") {
          item.fields = item.fields.filter(
            (field) => field.label.trim().length > 0 && field.fieldName.trim().length > 0
          );
          return item.fields.length > 0;
        }

        if (item.kind === "checkbox_enum") {
          item.options = item.options.filter(
            (option) =>
              option.label.trim().length > 0 &&
              option.value.trim().length > 0
          );
          return item.options.length > 0;
        }

        return true;
      });

      if (validItems.length === 0) {
        new Notice(t(settings.language, "section_behavior_validation_items_required"));
        return;
      }

      behavior.items = validItems;
    }

    this.onSave(cloneBehavior(behavior));
    this.close();
  }
}
