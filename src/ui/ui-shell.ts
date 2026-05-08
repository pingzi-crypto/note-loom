function buildClassName(baseClass: string, extraClass?: string): string {
  return [baseClass, extraClass]
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join(" ");
}

// Shared shell helpers for modal pages and grouped setting cards.
// This file owns the repeated title / section / footer / group skeleton so
// individual pages do not recreate another page-level layout wrapper.

export function prepareModalShell(
  contentEl: HTMLElement,
  modalEl: HTMLElement,
  ...modalClasses: string[]
): void {
  contentEl.empty();
  contentEl.addClass("note-loom-modal-content");
  modalEl.addClass("note-loom-modal");
  modalClasses.forEach((className) => {
    if (className.trim().length > 0) {
      modalEl.addClass(className);
    }
  });
}

export function createModalTitle(container: HTMLElement, text: string): HTMLHeadingElement {
  return container.createEl("h2", {
    cls: "note-loom-modal-title",
    text
  });
}

export function createModalHeading(
  container: HTMLElement,
  text: string,
  extraClass?: string
): HTMLHeadingElement {
  return container.createEl("h3", {
    cls: buildClassName("note-loom-modal-heading", extraClass),
    text
  });
}

export function createModalSection(container: HTMLElement, extraClass?: string): HTMLDivElement {
  return container.createDiv({
    cls: buildClassName("note-loom-modal-section", extraClass)
  });
}

export function createModalFooter(container: HTMLElement, extraClass?: string): HTMLDivElement {
  return container.createDiv({
    cls: buildClassName("note-loom-modal-footer", extraClass)
  });
}

type ModalActionButtonVariant = "default" | "cta" | "warning";

export interface ModalActionButton {
  text: string;
  onClick: () => void | Promise<void>;
  variant?: ModalActionButtonVariant;
  disabled?: boolean;
  className?: string;
}

export interface ModalActionFooterOptions {
  extraClass?: string;
  beforeActions?: (footer: HTMLDivElement) => void;
  actions: ModalActionButton[];
}

function applyModalActionButtonVariant(
  button: HTMLButtonElement,
  variant: ModalActionButtonVariant = "default"
): void {
  if (variant === "cta") {
    button.addClass("mod-cta");
  } else if (variant === "warning") {
    button.addClass("mod-warning");
  }
}

export function createModalActionFooter(
  container: HTMLElement,
  options: ModalActionFooterOptions
): HTMLDivElement {
  const footer = createModalFooter(container, options.extraClass);
  options.beforeActions?.(footer);

  options.actions.forEach((action) => {
    const button = footer.createEl("button", { text: action.text });
    applyModalActionButtonVariant(button, action.variant);
    if (action.className) {
      button.addClass(action.className);
    }
    if (action.disabled) {
      button.disabled = true;
    }
    button.addEventListener("click", () => {
      void action.onClick();
    });
  });

  return footer;
}

export function createSettingGroup(container: HTMLElement, extraClass?: string): HTMLDivElement {
  return container.createDiv({
    cls: buildClassName("note-loom-setting-group", extraClass)
  });
}
