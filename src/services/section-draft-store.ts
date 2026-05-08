import type { TemplateSectionConfig } from "../types/template";
import type {
  TemplateSectionDraftCollections,
  SectionPendingFieldBinding
} from "./template-field-state-service";
import {
  getInitialSectionPendingFieldValue,
  getSectionPendingReviewStatus,
  readSectionPendingFieldValue,
  writeSectionPendingFieldValue,
  type TemplateFieldReviewStatus
} from "./template-field-state-service";
import {
  TemplateSectionDraftService,
  type TemplateSectionDraftExtraction,
  type TemplateSectionDraftTrace
} from "./template-section-draft-service";

export interface SectionDraftStoreInitializeInput {
  sectionConfig: TemplateSectionConfig[] | undefined;
  extraction: TemplateSectionDraftExtraction | null;
  templateContent: string;
}

export class SectionDraftStore {
  private extraction: TemplateSectionDraftExtraction | null = null;
  private templateContent = "";
  private repeatableSectionDrafts = new Map<string, string>();
  private fieldBlockSectionDrafts = new Map<string, Record<string, string>>();
  private groupedFieldBlockSectionDrafts = new Map<string, Record<string, Record<string, string>>>();
  private tableBlockSectionDrafts = new Map<string, Array<Record<string, string>>>();
  private mixedFieldBlockSectionDrafts = new Map<string, Record<string, string>>();

  constructor(private readonly sectionDraftService: TemplateSectionDraftService) {}

  reset(): void {
    this.extraction = null;
    this.templateContent = "";
    this.repeatableSectionDrafts = new Map();
    this.fieldBlockSectionDrafts = new Map();
    this.groupedFieldBlockSectionDrafts = new Map();
    this.tableBlockSectionDrafts = new Map();
    this.mixedFieldBlockSectionDrafts = new Map();
  }

  initialize(input: SectionDraftStoreInitializeInput): void {
    this.extraction = input.extraction;
    this.templateContent = input.templateContent;
    this.initializeRepeatableSectionDrafts(input.sectionConfig);
    this.initializeFieldBlockSectionDrafts(input.sectionConfig);
    this.initializeGroupedFieldBlockSectionDrafts(input.sectionConfig);
    this.initializeTableBlockSectionDrafts(input.sectionConfig);
    this.initializeMixedFieldBlockSectionDrafts(input.sectionConfig);
  }

  getRepeatableDraft(sectionId: string): string {
    return this.repeatableSectionDrafts.get(sectionId) ?? "";
  }

  getFieldBlockDraft(sectionId: string): Record<string, string> | undefined {
    return this.fieldBlockSectionDrafts.get(sectionId);
  }

  getFieldBlockSectionDrafts(): Map<string, Record<string, string>> {
    return this.fieldBlockSectionDrafts;
  }

  getGroupedFieldBlockDraft(sectionId: string): Record<string, Record<string, string>> | undefined {
    return this.groupedFieldBlockSectionDrafts.get(sectionId);
  }

  getTableBlockDraft(sectionId: string): Array<Record<string, string>> | undefined {
    return this.tableBlockSectionDrafts.get(sectionId);
  }

  getTableBlockSectionDrafts(): Map<string, Array<Record<string, string>>> {
    return this.tableBlockSectionDrafts;
  }

  getMixedFieldBlockDraft(sectionId: string): Record<string, string> {
    return this.mixedFieldBlockSectionDrafts.get(sectionId) ?? {};
  }

  getMixedFieldBlockSectionDrafts(): Map<string, Record<string, string>> {
    return this.mixedFieldBlockSectionDrafts;
  }

  getGroupedFieldBlockSectionDrafts(): Map<string, Record<string, Record<string, string>>> {
    return this.groupedFieldBlockSectionDrafts;
  }

  getSectionDraftTrace(sectionId: string): TemplateSectionDraftTrace | undefined {
    return this.extraction?.sectionDraftTraces.get(sectionId);
  }

  getSectionDraftTraces(): Map<string, TemplateSectionDraftTrace> {
    return this.extraction?.sectionDraftTraces ?? new Map<string, TemplateSectionDraftTrace>();
  }

  getCollections(): TemplateSectionDraftCollections {
    return {
      currentSectionDraftExtraction: this.extraction,
      fieldBlockSectionDrafts: this.fieldBlockSectionDrafts,
      groupedFieldBlockSectionDrafts: this.groupedFieldBlockSectionDrafts,
      mixedFieldBlockSectionDrafts: this.mixedFieldBlockSectionDrafts,
      currentTemplateContent: this.templateContent
    };
  }

  getInitialPendingFieldValue(
    binding: SectionPendingFieldBinding,
    sectionConfig: TemplateSectionConfig[] | undefined
  ): string {
    return getInitialSectionPendingFieldValue(
      binding,
      sectionConfig,
      this.getCollections(),
      this.sectionDraftService
    );
  }

  readPendingFieldValue(
    binding: SectionPendingFieldBinding,
    sectionConfig: TemplateSectionConfig[] | undefined
  ): string {
    return readSectionPendingFieldValue(binding, sectionConfig, this.getCollections());
  }

  getPendingReviewStatus(
    binding: SectionPendingFieldBinding,
    value: string,
    sectionConfig: TemplateSectionConfig[] | undefined
  ): TemplateFieldReviewStatus {
    return getSectionPendingReviewStatus(
      binding,
      value,
      sectionConfig,
      this.getCollections(),
      this.sectionDraftService
    );
  }

  writePendingFieldValue(
    binding: SectionPendingFieldBinding,
    value: string,
    sectionConfig: TemplateSectionConfig[] | undefined
  ): void {
    const nextCollections = writeSectionPendingFieldValue(
      binding,
      value,
      sectionConfig,
      this.getCollections()
    );
    this.fieldBlockSectionDrafts = nextCollections.fieldBlockSectionDrafts;
    this.groupedFieldBlockSectionDrafts = nextCollections.groupedFieldBlockSectionDrafts;
    this.mixedFieldBlockSectionDrafts = nextCollections.mixedFieldBlockSectionDrafts;
  }

  private initializeRepeatableSectionDrafts(sectionConfig: TemplateSectionConfig[] | undefined): void {
    const nextDrafts = new Map<string, string>();
    (sectionConfig ?? [])
      .filter(
        (section) =>
          (section.mode === "generate" && section.kind === "repeatable_entries") ||
          this.sectionDraftService.isRepeatableTextSection(section) ||
          this.sectionDraftService.isTaskListSection(section)
      )
      .forEach((section) => {
        const extractedDraft = this.extraction?.repeatableDrafts.get(section.id) ?? "";
        const existingDraft = this.repeatableSectionDrafts.get(section.id) ?? "";
        const shouldPreferExtracted =
          extractedDraft.trim().length > 0 &&
          this.sectionDraftService.isFieldBackedTaskListSection(section, this.templateContent);
        nextDrafts.set(
          section.id,
          shouldPreferExtracted
            ? extractedDraft
            : existingDraft || extractedDraft
        );
      });
    this.repeatableSectionDrafts = nextDrafts;
  }

  private initializeFieldBlockSectionDrafts(sectionConfig: TemplateSectionConfig[] | undefined): void {
    const nextDrafts = new Map<string, Record<string, string>>();
    (sectionConfig ?? [])
      .filter((section) => this.sectionDraftService.isFieldBlockSection(section))
      .forEach((section) => {
        nextDrafts.set(
          section.id,
          this.sectionDraftService.createFieldBlockDraft(
            section,
            this.extraction?.fieldBlockDrafts.get(section.id),
            this.fieldBlockSectionDrafts.get(section.id)
          )
        );
      });
    this.fieldBlockSectionDrafts = nextDrafts;
  }

  private initializeGroupedFieldBlockSectionDrafts(sectionConfig: TemplateSectionConfig[] | undefined): void {
    const nextDrafts = new Map<string, Record<string, Record<string, string>>>();
    (sectionConfig ?? [])
      .filter((section) => this.sectionDraftService.isGroupedFieldBlockSection(section))
      .forEach((section) => {
        nextDrafts.set(
          section.id,
          this.sectionDraftService.createGroupedFieldBlockDraft(
            section,
            this.extraction?.groupedFieldBlockDrafts.get(section.id),
            this.groupedFieldBlockSectionDrafts.get(section.id)
          )
        );
      });
    this.groupedFieldBlockSectionDrafts = nextDrafts;
  }

  private initializeTableBlockSectionDrafts(sectionConfig: TemplateSectionConfig[] | undefined): void {
    const nextDrafts = new Map<string, Array<Record<string, string>>>();
    (sectionConfig ?? [])
      .filter((section) => this.sectionDraftService.isTableBlockSection(section))
      .forEach((section) => {
        nextDrafts.set(
          section.id,
          this.sectionDraftService.createTableBlockDraft(
            section,
            this.extraction?.tableBlockDrafts.get(section.id),
            this.tableBlockSectionDrafts.get(section.id)
          )
        );
      });
    this.tableBlockSectionDrafts = nextDrafts;
  }

  private initializeMixedFieldBlockSectionDrafts(sectionConfig: TemplateSectionConfig[] | undefined): void {
    const nextDrafts = new Map<string, Record<string, string>>();
    (sectionConfig ?? [])
      .filter((section) => this.sectionDraftService.isMixedFieldBlockSection(section))
      .forEach((section) => {
        nextDrafts.set(
          section.id,
          this.sectionDraftService.createMixedFieldBlockDraft(
            section,
            this.extraction?.mixedFieldBlockDrafts.get(section.id),
            this.mixedFieldBlockSectionDrafts.get(section.id),
            this.templateContent
          )
        );
      });
    this.mixedFieldBlockSectionDrafts = nextDrafts;
  }
}
