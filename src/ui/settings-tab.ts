import { App, Notice, Plugin, PluginSettingTab, Setting, normalizePath } from "obsidian";

import { t } from "../i18n";
import { DiagnosticsService } from "../services/diagnostics-service";
import { SettingsService } from "../services/settings-service";
import { TemplateLibraryService } from "../services/template-library-service";
import { TemplateScanner } from "../services/template-scanner";
import { getVaultFolderPaths, getVaultMarkdownPaths } from "../utils/vault-paths";
import {
  createFolderPathDropdownSetting,
  createInfoSetting,
  createNotePathDropdownSetting,
  createSettingGroup,
} from "./ui-entry";
import { TemplateConfigModal } from "./template-config-modal";
import type { ImportCandidate } from "../services/template-library-service";
import type { TemplateConfig } from "../types/template";

function isPathInsideFolder(path: string, folderPath: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedFolderPath = normalizePath(folderPath).replace(/\/$/, "");
  return normalizedPath === normalizedFolderPath || normalizedPath.startsWith(`${normalizedFolderPath}/`);
}

function collectCandidateFieldNames(candidate: ImportCandidate): Set<string> {
  return new Set(candidate.fields.map((field) => field.name.trim()).filter(Boolean));
}

function collectTemplateFieldNames(template: TemplateConfig): Set<string> {
  return new Set(template.fields.map((field) => field.name.trim()).filter(Boolean));
}

function scoreTemplateStructureMatch(candidate: ImportCandidate, template: TemplateConfig): number {
  const candidateFields = collectCandidateFieldNames(candidate);
  const templateFields = collectTemplateFieldNames(template);
  if (candidateFields.size === 0 || templateFields.size === 0) {
    return 0;
  }

  const overlap = Array.from(candidateFields).filter((fieldName) => templateFields.has(fieldName)).length;
  return overlap / Math.max(candidateFields.size, templateFields.size);
}

function findRenamedTemplateMatch(
  candidate: ImportCandidate,
  staleTemplates: TemplateConfig[],
  claimedTemplateIds: Set<string>
): TemplateConfig | undefined {
  const ranked = staleTemplates
    .filter((template) => !claimedTemplateIds.has(template.id))
    .map((template) => ({
      template,
      score: scoreTemplateStructureMatch(candidate, template)
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];

  if (!best || best.score < 0.6) {
    return undefined;
  }

  claimedTemplateIds.add(best.template.id);
  return best.template;
}

export class TemplateExtractorSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly settingsService: SettingsService,
    private readonly templateLibraryService: TemplateLibraryService,
    private readonly templateScanner: TemplateScanner,
    private readonly diagnosticsService: DiagnosticsService,
    private readonly onRibbonSettingChanged: () => void
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.settingsService.getSettings();
    containerEl.empty();
    containerEl.addClass("note-loom-settings");

    new Setting(containerEl).setName(t(settings.language, "plugin_name")).setHeading();

    new Setting(containerEl).setName(t(settings.language, "templates")).setHeading();

    const templateImportGroup = createSettingGroup(
      containerEl,
      "note-loom-form-group note-loom-three-column-group"
    );

    createFolderPathDropdownSetting(templateImportGroup, {
      name: t(settings.language, "template_root_folder"),
      getLanguage: () => this.settingsService.getSettings().language,
      getPaths: () => getVaultFolderPaths(this.app),
      emptyLabelKey: "root_label",
      getCurrentValue: () => this.settingsService.getSettings().templateRootFolder,
      onChange: async (value) => {
        await this.settingsService.update((nextSettings) => {
          nextSettings.templateRootFolder = value;
        });
        this.display();
      }
    });

    const templateImportSetting = createInfoSetting(templateImportGroup);
    templateImportSetting.settingEl.addClass("note-loom-action-only-setting");
    templateImportSetting
      .setName(t(settings.language, "batch_import_templates"))
      .setDesc(t(settings.language, "batch_import_templates_desc"))
      .addButton((button) =>
        button
          .setButtonText(t(settings.language, "import_templates"))
          .setCta()
          .setDisabled(settings.templateRootFolder.trim().length === 0)
          .onClick(async () => {
            await this.importTemplatesFromRootFolder();
          })
      );

    const templateListGroup = createSettingGroup(
      containerEl,
      "note-loom-three-column-group"
    );
    this.renderTemplateList(templateListGroup, settings.templates);

    new Setting(containerEl).setName(t(settings.language, "default_generation")).setHeading();

    const defaultGenerationFormGroup = createSettingGroup(
      containerEl,
      "note-loom-form-group note-loom-three-column-group"
    );

    createFolderPathDropdownSetting(defaultGenerationFormGroup, {
      name: t(settings.language, "default_output_path"),
      getLanguage: () => this.settingsService.getSettings().language,
      getPaths: () => getVaultFolderPaths(this.app),
      emptyLabelKey: "root_label",
      getCurrentValue: () => this.settingsService.getSettings().defaultOutputPath,
      onChange: async (value) => {
        await this.settingsService.update((nextSettings) => {
          nextSettings.defaultOutputPath = value;
        });
        this.display();
      }
    });

    createNotePathDropdownSetting(defaultGenerationFormGroup, {
      name: t(settings.language, "default_index_note_path"),
      getLanguage: () => this.settingsService.getSettings().language,
      getPaths: () => getVaultMarkdownPaths(this.app),
      emptyLabelKey: "no_index_label",
      getCurrentValue: () => this.settingsService.getSettings().defaultIndexNotePath,
      onChange: async (value) => {
        await this.settingsService.update((nextSettings) => {
          nextSettings.defaultIndexNotePath = value;
        });
        this.display();
      }
    });

    createInfoSetting(defaultGenerationFormGroup)
      .setName(t(settings.language, "default_filename_field"))
      .setDesc(t(settings.language, "default_filename_field_desc"))
      .addText((text) =>
        text
          .setPlaceholder(t(settings.language, "default_filename_field_placeholder"))
          .setValue(settings.defaultFilenameField)
          .onChange(async (value) => {
            await this.settingsService.update((nextSettings) => {
              nextSettings.defaultFilenameField = value.trim();
            });
          })
      );

    const defaultGenerationToggleGroup = createSettingGroup(
      containerEl,
      "note-loom-toggle-group note-loom-three-column-group"
    );

    createInfoSetting(defaultGenerationToggleGroup)
      .setName(t(settings.language, "write_source_metadata_default"))
      .addToggle((toggle) =>
        toggle.setValue(settings.writeSourceMetadata).onChange(async (value) => {
          await this.settingsService.update((nextSettings) => {
            nextSettings.writeSourceMetadata = value;
          });
        })
      );

    createInfoSetting(defaultGenerationToggleGroup)
      .setName(t(settings.language, "write_index_entry_default"))
      .addToggle((toggle) =>
        toggle.setValue(settings.writeIndexEntry).onChange(async (value) => {
          await this.settingsService.update((nextSettings) => {
            nextSettings.writeIndexEntry = value;
          });
        })
      );

    createInfoSetting(defaultGenerationToggleGroup)
      .setName(t(settings.language, "open_generated_note_default"))
      .addToggle((toggle) =>
        toggle.setValue(settings.openGeneratedNote).onChange(async (value) => {
          await this.settingsService.update((nextSettings) => {
            nextSettings.openGeneratedNote = value;
          });
        })
      );

    createInfoSetting(defaultGenerationToggleGroup)
      .setName(t(settings.language, "enable_alias_matching"))
      .addToggle((toggle) =>
        toggle.setValue(settings.enableAliasMatching).onChange(async (value) => {
          await this.settingsService.update((nextSettings) => {
            nextSettings.enableAliasMatching = value;
          });
        })
      );

    createInfoSetting(defaultGenerationToggleGroup)
      .setName(t(settings.language, "unmatched_fields_start_enabled"))
      .addToggle((toggle) =>
        toggle.setValue(settings.unmatchedFieldsStartEnabled).onChange(async (value) => {
          await this.settingsService.update((nextSettings) => {
            nextSettings.unmatchedFieldsStartEnabled = value;
          });
        })
      );

    new Setting(containerEl).setName(t(settings.language, "entry_points")).setHeading();

    const entryPointsGroup = createSettingGroup(
      containerEl,
      "note-loom-toggle-group note-loom-three-column-group"
    );

    createInfoSetting(entryPointsGroup)
      .setName(t(settings.language, "show_ribbon_icon"))
      .addToggle((toggle) =>
        toggle.setValue(settings.showRibbonIcon).onChange(async (value) => {
          await this.settingsService.update((nextSettings) => {
            nextSettings.showRibbonIcon = value;
          });
          this.onRibbonSettingChanged();
        })
      );

    new Setting(containerEl).setName(t(settings.language, "diagnostics")).setHeading();

    const diagnosticsGroup = createSettingGroup(
      containerEl,
      "note-loom-toggle-group note-loom-three-column-group"
    );

    createInfoSetting(diagnosticsGroup)
      .setName(t(settings.language, "diagnostics_local_log"))
      .setDesc(t(settings.language, "diagnostics_local_log_desc"))
      .addToggle((toggle) =>
        toggle.setValue(settings.diagnosticsEnabled).onChange(async (value) => {
          await this.settingsService.update((nextSettings) => {
            nextSettings.diagnosticsEnabled = value;
          });
          this.display();
        })
      );

    createInfoSetting(diagnosticsGroup)
      .setName(t(settings.language, "diagnostics_export"))
      .setDesc(t(settings.language, "diagnostics_export_desc"))
      .addButton((button) =>
        button
          .setButtonText(t(settings.language, "diagnostics_export_button"))
          .onClick(async () => {
            const result = await this.diagnosticsService.exportPackage();
            new Notice(t(settings.language, "diagnostics_exported", {
              path: result.path,
              count: String(result.eventCount)
            }));
          })
      );

    createInfoSetting(diagnosticsGroup)
      .setName(t(settings.language, "diagnostics_clear"))
      .setDesc(t(settings.language, "diagnostics_clear_desc"))
      .addButton((button) =>
        button
          .setButtonText(t(settings.language, "diagnostics_clear_button"))
          .onClick(async () => {
            await this.diagnosticsService.clear();
            new Notice(t(settings.language, "diagnostics_cleared"));
          })
      );

    const languageGroup = createSettingGroup(
      containerEl,
      "note-loom-three-column-group"
    );

    const languageSetting = createInfoSetting(languageGroup);
    languageSetting.settingEl.addClass("note-loom-centered-setting");
    languageSetting
      .setName(t(settings.language, "language"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("auto", t(settings.language, "language_auto"))
          .addOption("zh", t(settings.language, "language_zh"))
          .addOption("en", t(settings.language, "language_en"))
          .setValue(settings.language)
          .onChange(async (value) => {
            await this.settingsService.update((nextSettings) => {
              nextSettings.language = value as typeof settings.language;
            });
            this.display();
          });
      });
  }

  private async importTemplatesFromRootFolder(): Promise<void> {
    const settings = this.settingsService.getSettings();
    const folderPath = settings.templateRootFolder.trim();

    if (!folderPath) {
      return;
    }

    try {
      const candidates = await this.templateLibraryService.scanFolder(folderPath);
      const validCandidates = candidates.filter((candidate) => candidate.valid);
      const existingTemplatesByPath = new Map(
        settings.templates.map((template) => [normalizePath(template.path), template] as const)
      );
      const candidatePaths = new Set(validCandidates.map((candidate) => normalizePath(candidate.path)));
      const staleTemplatesInRoot = settings.templates.filter((template) => (
        isPathInsideFolder(template.path, folderPath) &&
        !candidatePaths.has(normalizePath(template.path))
      ));
      const claimedStaleTemplateIds = new Set<string>();

      if (validCandidates.length === 0) {
        new Notice(t(settings.language, "no_new_templates_to_import"));
        return;
      }

      const syncItems = validCandidates.map((candidate) => {
        const existingTemplate =
          existingTemplatesByPath.get(normalizePath(candidate.path)) ??
          findRenamedTemplateMatch(candidate, staleTemplatesInRoot, claimedStaleTemplateIds);
        return {
          existingTemplate,
          template: this.templateLibraryService.buildTemplateConfig(
            candidate,
            {
              enabled: true,
              defaultOutputPath: settings.defaultOutputPath,
              defaultIndexNotePath: settings.defaultIndexNotePath,
              filenameField: settings.defaultFilenameField
            },
            existingTemplate
          )
        };
      });
      const templates = syncItems.map((item) => item.template);

      await this.settingsService.update((nextSettings) => {
        const templateIdsToReplace = new Set(templates.map((template) => template.id));
        const templatePathsToReplace = new Set(templates.map((template) => normalizePath(template.path)));
        nextSettings.templates = nextSettings.templates.filter((template) => {
          const normalizedPath = normalizePath(template.path);
          if (!isPathInsideFolder(normalizedPath, folderPath)) {
            return true;
          }

          if (templateIdsToReplace.has(template.id) || templatePathsToReplace.has(normalizedPath)) {
            return false;
          }

          return candidatePaths.has(normalizedPath);
        });

        templates.forEach((template) => {
          const index = nextSettings.templates.findIndex((item) => item.id === template.id);
          if (index >= 0) {
            nextSettings.templates[index] = template;
            return;
          }

          nextSettings.templates.push(template);
        });
      });

      const importedCount = syncItems.filter((item) => !item.existingTemplate).length;
      const refreshedCount = syncItems.length - importedCount;
      new Notice(t(settings.language, "synced_templates", {
        imported: importedCount,
        refreshed: refreshedCount
      }));
      this.display();
    } catch (error) {
      const messageKey = error instanceof Error ? error.message : "scan_failed";
      new Notice(t(settings.language, messageKey));
    }
  }

  private renderTemplateList(container: HTMLElement, templates: TemplateConfig[]): void {
    const settings = this.settingsService.getSettings();
    if (templates.length === 0) {
      container.createEl("p", {
        text: t(settings.language, "no_templates_configured")
      });
      return;
    }

    for (const template of templates) {
      const templateSetting = createInfoSetting(container);
      templateSetting.settingEl.addClass("note-loom-template-item");
      templateSetting.settingEl.addClass("note-loom-toolbar-item");
      templateSetting.setName(template.name);
      templateSetting.descEl.empty();
      templateSetting.descEl.addClass("note-loom-template-desc");

      const metaRow = templateSetting.descEl.createDiv({
        cls: "note-loom-template-meta-row"
      });
      metaRow.createSpan({
        cls: "note-loom-template-badge",
        text: `${t(settings.language, "fields_count")}: ${template.fields.length}`
      });

      templateSetting
        .addToggle((toggle) =>
          toggle.setValue(template.enabled).onChange(async (value) => {
            await this.settingsService.update((settings) => {
              const nextTemplate = settings.templates.find((item) => item.id === template.id);
              if (nextTemplate) {
                nextTemplate.enabled = value;
              }
            });
          })
        )
        .addButton((button) =>
          button.setButtonText(t(settings.language, "edit")).onClick(() => {
            new TemplateConfigModal(
              this.app,
              template,
              this.settingsService,
              this.templateScanner,
              () => this.display()
            ).open();
          })
        )
        .addButton((button) =>
          button.setWarning().setButtonText(t(settings.language, "remove")).onClick(async () => {
            await this.settingsService.removeTemplate(template.id);
            new Notice(t(settings.language, "removed_template", { name: template.name }));
            this.display();
          })
        );
    }
  }

}
