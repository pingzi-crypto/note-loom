import { addIcon, MarkdownView, Notice, Plugin, TFile } from "obsidian";

import {
  GENERATE_COMMAND_ID,
  RIBBON_ICON,
  RIBBON_ICON_SVG,
} from "./constants";
import { t } from "./i18n";
import { FieldMatcher } from "./services/field-matcher";
import { FileService } from "./services/file-service";
import { IndexService } from "./services/index-service";
import { DiagnosticsService } from "./services/diagnostics-service";
import { RibbonService } from "./services/ribbon-service";
import { SettingsService } from "./services/settings-service";
import { TemplaterService } from "./services/templater-service";
import { TemplateLibraryService } from "./services/template-library-service";
import { TemplateRenderer } from "./services/template-renderer";
import { TemplateScanner } from "./services/template-scanner";
import { GenerateModal } from "./ui/generate-modal";
import { TemplateExtractorSettingTab } from "./ui/settings-tab";

export default class TemplateExtractorPlugin extends Plugin {
  private readonly settingsService = new SettingsService(this);
  private readonly templateScanner = new TemplateScanner();
  private readonly templateLibraryService = new TemplateLibraryService(
    this.app,
    this.settingsService,
    this.templateScanner
  );
  private readonly fieldMatcher = new FieldMatcher();
  private readonly templateRenderer = new TemplateRenderer();
  private readonly fileService = new FileService(this.app);
  private readonly indexService = new IndexService(this.app);
  private readonly templaterService = new TemplaterService(this.app);
  private readonly diagnosticsService = new DiagnosticsService(this.app, this.settingsService);
  private readonly ribbonService = new RibbonService(this);

  async onload(): Promise<void> {
    await this.settingsService.load();
    addIcon(RIBBON_ICON, RIBBON_ICON_SVG);

    this.addSettingTab(
      new TemplateExtractorSettingTab(
        this.app,
        this,
        this.settingsService,
        this.templateLibraryService,
        this.templateScanner,
        this.diagnosticsService,
        () => this.syncRibbonIcon()
      )
    );

    this.addCommand({
      id: GENERATE_COMMAND_ID,
      name: t(this.settingsService.getSettings().language, "generator_title"),
      callback: () => {
        this.openGenerateModal();
      }
    });

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          void this.handleDeletedMarkdownFile(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          void this.settingsService.replaceManagedIndexPath(oldPath, file.path);
          void this.settingsService.replaceTemplatePath(oldPath, file.path);
        }
      })
    );

    this.syncRibbonIcon();

    new Notice(t(this.settingsService.getSettings().language, "plugin_loaded"));
  }

  onunload(): void {
    this.ribbonService.remove();
  }

  private syncRibbonIcon(): void {
    const settings = this.settingsService.getSettings();
    this.ribbonService.sync(settings.showRibbonIcon, t(settings.language, "generator_title"), () => {
      this.openGenerateModal();
    });
  }

  private openGenerateModal(): void {
    const activeFile = this.getActiveMarkdownFile();

    if (!activeFile) {
      new Notice(t(this.settingsService.getSettings().language, "open_markdown_note_first"));
      return;
    }

    new GenerateModal(
      this.app,
      activeFile,
      this.settingsService,
      this.templateScanner,
      this.fieldMatcher,
      this.templateRenderer,
      this.fileService,
      this.indexService,
      this.templaterService,
      this.diagnosticsService
    ).open();
  }

  private getActiveMarkdownFile(): TFile | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    return activeView?.file ?? null;
  }

  private async handleDeletedMarkdownFile(file: TFile): Promise<void> {
    const managedEntries = this.settingsService.getManagedIndexEntriesForCreatedNote(file.path);
    if (managedEntries.length === 0) {
      return;
    }

    for (const entry of managedEntries) {
      try {
        await this.indexService.removeLinkEntry(entry);
      } catch {
        // Ignore cleanup failures here. The next write into the same index note prunes stale entries.
      }
    }

    await this.settingsService.removeManagedIndexEntriesForCreatedNote(file.path);
  }
}
