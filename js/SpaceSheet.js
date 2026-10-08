/* Keep X's own Space DOM intact while making its surrounding portal non-modal. */
class SpaceSheet {
  constructor(sheet) {
    this.sheet = sheet;
    this.disposed = false;
    this.queued = false;
    this.records = [];
    this.hadSheetClass = sheet.classList.contains("ss-sheet");
    sheet.classList.add("ss-sheet");
    this.refresh();
    this.observer = new MutationObserver(() => {
      if (this.queued || this.disposed) return;
      this.queued = true;
      queueMicrotask(() => {
        this.queued = false;
        if (!this.disposed) this.refresh();
      });
    });
    this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["inert", "aria-hidden", "aria-modal"] });
  }

  addClass(element, name) {
    if (element.classList.contains(name)) return;
    this.records.push({ element, name, className: true });
    element.classList.add(name);
  }

  attribute(element, name, value, background = false) {
    if (element.getAttribute(name) === value) return;
    if (!this.records.some(record => record.element === element && record.name === name && !record.className)) {
      this.records.push({ element, name, previous: element.getAttribute(name), value, background });
    }
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  backdropMask(element) {
    // X renders an additional, empty modal underneath the Space's menu portal.
    // Its mask and fullscreen geometry distinguish it from Share/report dialogs.
    if (element.getAttribute("role") !== "dialog" || element.children.length || element.textContent.trim()) return null;
    const bounds = element.getBoundingClientRect();
    if (bounds.width < window.innerWidth * 0.8 || bounds.height < window.innerHeight * 0.8) return null;
    return [...(element.parentElement?.children || [])].find(sibling => sibling !== element && sibling.getAttribute("data-testid") === "mask") || null;
  }

  hasOtherModal() {
    const dialogs = [...document.querySelectorAll('[aria-modal="true"], [role="dialog"]')];
    const backdrops = dialogs.filter(element => this.backdropMask(element));
    return dialogs.some(element => {
      if (element === this.sheet || element.contains(this.sheet)) return false;
      if (this.backdropMask(element)) return false;
      if (!element.textContent.trim() && !element.querySelector('button,a,input,[role="button"],[contenteditable="true"]') && backdrops.some(backdrop => element.contains(backdrop))) return false;
      // A zero-height wrapper can contain the visible content of a real dialog.
      // getClientRects retains that wrapper; do not require a positive own height.
      return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    });
  }

  unlockPortal(element) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    let child = element;
    for (let parent = child.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = child.parentElement) {
      if (parent.id === "layers" || parent.id === "react-root" || parent.getAttribute("role") === "menu") break;
      this.addClass(parent, "ss-overlay-path");
      if (parent.getAttribute("aria-modal") === "true") this.attribute(parent, "aria-modal", "false");
      if (parent.hasAttribute("inert")) this.attribute(parent, "inert", null);
      if (parent.tabIndex >= 0) this.attribute(parent, "tabindex", "-1");
      for (const sibling of parent.children) {
        if (sibling === child || sibling === this.sheet || sibling.contains(this.sheet)) continue;
        // Touch only empty portal decorations, never native menus or controls.
        if (sibling.children.length || sibling.textContent.trim()) continue;
        const bounds = sibling.getBoundingClientRect();
        if (bounds.width >= width * 0.8 && bounds.height >= height * 0.8) {
          this.addClass(sibling, "ss-overlay-backdrop");
        } else if (sibling.tabIndex >= 0 || (bounds.width <= 2 && bounds.height <= 2)) {
          this.addClass(sibling, "ss-focus-guard");
          if (sibling.tabIndex >= 0) this.attribute(sibling, "tabindex", "-1");
        }
      }
      child = parent;
    }
  }

  refresh() {
    if (this.disposed || !this.sheet.isConnected) return;
    // Share/report dialogs retain their own modality. Resume browsing when they close.
    if (this.hasOtherModal()) {
      this.restoreLocks();
      return;
    }

    this.unlockPortal(this.sheet);
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      const mask = this.backdropMask(dialog);
      if (!mask) continue;
      this.addClass(dialog, "ss-overlay-backdrop");
      this.addClass(mask, "ss-overlay-backdrop");
      this.attribute(dialog, "aria-modal", "false");
      if (dialog.tabIndex >= 0) this.attribute(dialog, "tabindex", "-1");
      this.unlockPortal(dialog);
    }
    this.attribute(this.sheet, "aria-modal", "false");
    this.addClass(document.documentElement, "ss-page-unlocked");

    // Native modal implementations may hide or inert the background's root.
    // Restrict restoration to the actual main landmark's ancestor chain.
    for (const main of document.querySelectorAll('main, [role="main"]')) {
      if (this.sheet.contains(main)) continue;
      for (let node = main; node && node !== document.documentElement; node = node.parentElement) {
        if (node.contains(this.sheet)) break;
        if (node.hasAttribute("inert")) this.attribute(node, "inert", null, true);
        if (node.getAttribute("aria-hidden") === "true") this.attribute(node, "aria-hidden", null, true);
      }
    }
  }

  restoreLocks() {
    const sheetRemoved = !this.sheet.isConnected;
    for (const record of this.records.splice(0).reverse()) {
      const { element, name, previous, value, className, background } = record;
      if (className) element.classList.remove(name);
      // X removes its background locks when the native sheet closes. Restoring
      // our earlier snapshot now would make the live page inaccessible again.
      else if (background && sheetRemoved) continue;
      else if (element.getAttribute(name) === value) {
        if (previous === null) element.removeAttribute(name);
        else element.setAttribute(name, previous);
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.restoreLocks();
    if (!this.hadSheetClass) this.sheet.classList.remove("ss-sheet");
  }
}
