/* A movable, non-modal shell. Playback and recording remain owned by SpaceCast. */
class SpaceGlassWindow {
  static POSITION_KEY = "spacecast.glass-window-position";
  static SIZE_KEY = "spacecast.glass-window-size";
  static rememberedSize = null;

  constructor(panel, options = {}) {
    const { onClose = () => {}, onMinimize = () => {} } = options;
    this.panel = panel;
    this.onClose = onClose;
    this.onMinimize = onMinimize;
    this.listeners = [];
    this.disposed = false;
    this.minimized = false;
    this.drag = null;
    this.resize = null;
    this.sizePreference = this.readSize();
    this.frame = null;
    this.header = options.header || panel.querySelector(".ss-brand-row");
    if (!this.header) throw new Error("SpaceCast window requires a header");
    this.content = options.content || (options.header ? null : panel.querySelector(".ss-window-content"));
    this.previous = {
      role: panel.getAttribute("role"),
      label: panel.getAttribute("aria-label"),
      modal: panel.getAttribute("aria-modal"),
      position: panel.style.position, left: panel.style.left, top: panel.style.top,
      right: panel.style.right, bottom: panel.style.bottom,
      widthVariable: panel.style.getPropertyValue("--ss-window-width"),
      heightVariable: panel.style.getPropertyValue("--ss-window-height"),
    };
    panel.classList.add("ss-glass-window");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-label", "SpaceCast player and recorder");
    panel.dataset.minimized = "false";
    this.header.classList.add("ss-window-drag");
    const brand = this.header.querySelector(".ss-brand");
    if (brand) brand.title = "SpaceCast · drag to move";

    this.ownsTitle = !options.titleElement;
    this.title = options.titleElement || document.createElement("span");
    if (this.ownsTitle) {
      this.title.className = "ss-window-title";
      this.title.dir = "auto";
    }
    this.title.tabIndex = 0;
    this.title.setAttribute("role", "button");
    this.title.setAttribute("aria-label", "Move SpaceCast window");
    this.title.setAttribute("aria-description", "Drag to move. Arrow keys move the window; Shift moves farther. Home resets its position. Enter collapses or expands it.");
    this.title.setAttribute("aria-expanded", "true");
    if (this.ownsTitle) {
      this.title.textContent = "SpaceCast";
      const badge = this.header.querySelector(".ss-state-badge");
      this.header.insertBefore(this.title, badge);
    }

    const controls = options.controls || ["details", "minimize", "close"];
    this.ownsActions = !options.controlsContainer;
    this.actions = options.controlsContainer || document.createElement("div");
    this.insertedControls = [];
    if (this.ownsActions) this.actions.className = "ss-window-actions";
    if (controls.includes("details")) {
      this.details = document.createElement("a");
      this.details.className = "ss-window-details";
      this.details.target = "_blank";
      this.details.rel = "noopener noreferrer";
      this.details.setAttribute("aria-label", "Open Space details");
      this.details.title = "Open Space details in a new tab";
      this.details.appendChild(this.icon("details"));
      this.details.hidden = true;
      this.insertedControls.push(this.details);
    }
    if (controls.includes("minimize")) {
      this.minimizeButton = this.button("ss-window-minimize", "Minimize SpaceCast", "minimize");
      this.minimizeButton.setAttribute("aria-expanded", "true");
      this.insertedControls.push(this.minimizeButton);
      this.listen(this.minimizeButton, "click", () => this.setMinimized(!this.minimized));
    }
    if (controls.includes("close")) {
      this.closeButton = this.button("ss-window-close", "Close SpaceCast", "close");
      this.insertedControls.push(this.closeButton);
      this.listen(this.closeButton, "click", () => this.onClose());
    }
    this.actions.append(...this.insertedControls);
    if (this.ownsActions) this.header.appendChild(this.actions);

    // A native sheet may lay out its heading and grip as separate grid items.
    // Capturing on the heading still keeps every drag listener local to the sheet.
    const handles = options.titleElement ? [this.header, this.title] : [this.header];
    for (const handle of handles) {
      this.listen(handle, "dblclick", event => {
        if (handle !== this.header && this.header.contains?.(handle)) return;
        if (!this.isInteractive(event.target)) {
          event.preventDefault();
          this.setMinimized(!this.minimized);
        }
      });
      this.listen(handle, "pointerdown", event => this.startDrag(event));
    }
    this.listen(this.title, "keydown", event => this.keyMove(event));
    this.listen(this.header, "pointermove", event => this.moveDrag(event));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      this.listen(this.header, type, event => this.endDrag(event));
    }
    this.resizeHandles = [];
    for (const direction of ["n", "e", "s", "w", "ne", "nw", "sw", "se"]) {
      const handle = document.createElement(direction === "se" ? "button" : "div");
      handle.className = "spacecast-resize-handle";
      handle.dataset.direction = direction;
      if (direction === "se") {
        handle.type = "button";
        handle.setAttribute("aria-label", "Resize SpaceCast window");
        handle.title = "Drag to resize. Double-click to fit content. Arrow keys resize; Shift moves faster; Home or Enter fits content.";
        this.resizeGrip = handle;
        this.listen(handle, "keydown", event => this.keyResize(event));
        this.listen(handle, "dblclick", event => { event.preventDefault(); this.resetSize(); });
      } else handle.setAttribute("aria-hidden", "true");
      this.listen(handle, "pointerdown", event => this.startResize(event, direction, handle));
      this.listen(handle, "pointermove", event => this.moveResize(event));
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) this.listen(handle, type, event => this.endResize(event));
      this.resizeHandles.push(handle);
      panel.appendChild(handle);
    }
    this.listen(window, "resize", () => this.scheduleClamp());
    if (window.visualViewport) {
      this.listen(window.visualViewport, "resize", () => this.scheduleClamp());
      this.listen(window.visualViewport, "scroll", () => this.scheduleClamp());
    }
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.scheduleClamp());
      this.resizeObserver.observe(panel);
    }
    Object.assign(panel.style, { position: "fixed", right: "auto", bottom: "auto" });
    this.applySize();
    const restored = this.readPosition();
    this.position = restored || this.defaultPosition();
    this.clampPosition();
    this.scheduleClamp();
  }

  listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.listeners.push(() => target.removeEventListener(type, listener));
  }

  icon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(key, value);
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", {
      details: "M14 4h6v6m0-6L10 14M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5",
      minimize: "M5 12h14",
      restore: "M5 9l7-5 7 5M5 15l7 5 7-5",
      close: "M6 6l12 12M6 18L18 6",
    }[name]);
    svg.appendChild(path);
    return svg;
  }

  button(className, label, icon) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.appendChild(this.icon(icon));
    return button;
  }

  setSpace(space) {
    if (this.disposed) return;
    const key = JSON.stringify([space?.id, space?.url, space?.title]);
    if (key === this.spaceKey) return;
    this.spaceKey = key;
    if (this.ownsTitle) this.title.textContent = space?.title || "SpaceCast";
    this.title.title = (space?.title ? space.title + " · " : "") + "Drag to move; double-click to minimize";
    if (!this.details) return;
    // Space metadata is untrusted. Only create links to actual X Space routes.
    let id = typeof space?.id === "string" && /^[A-Za-z0-9]+$/.test(space.id) ? space.id : "";
    try {
      const url = new URL(space?.url || "");
      if (url.protocol === "https:" && /^(www\.)?(x|twitter)\.com$/.test(url.hostname)) {
        id = url.pathname.match(/^\/i\/spaces\/([A-Za-z0-9]+)(?:\/|$)/)?.[1] || id;
      }
    } catch {}
    this.details.hidden = !id;
    if (id) this.details.href = "https://x.com/i/spaces/" + id + "/peek?spacecast=native";
    else this.details.removeAttribute("href");
  }

  viewport() {
    const view = window.visualViewport;
    return { width: view?.width || window.innerWidth, height: view?.height || window.innerHeight, x: view?.offsetLeft || 0, y: view?.offsetTop || 0 };
  }

  defaultPosition() {
    const view = this.viewport();
    const width = this.panel.getBoundingClientRect().width || Math.min(520, view.width - 24);
    return { x: view.x + view.width - width - 24, y: view.y + 96 };
  }

  readPosition() {
    try {
      const value = JSON.parse(localStorage.getItem(SpaceGlassWindow.POSITION_KEY));
      if (value && typeof value.x === "number" && typeof value.y === "number" && Number.isFinite(value.x) && Number.isFinite(value.y)) return { x: value.x, y: value.y };
    } catch {}
    return null;
  }

  savePosition() {
    try { localStorage.setItem(SpaceGlassWindow.POSITION_KEY, JSON.stringify(this.position)); } catch {}
  }

  readSize() {
    try {
      const value = JSON.parse(localStorage.getItem(SpaceGlassWindow.SIZE_KEY));
      if (value && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0) {
        return { width: value.width, height: value.height };
      }
    } catch {}
    return SpaceGlassWindow.rememberedSize ? { ...SpaceGlassWindow.rememberedSize } : null;
  }

  saveSize() {
    SpaceGlassWindow.rememberedSize = this.sizePreference ? { ...this.sizePreference } : null;
    try { localStorage.setItem(SpaceGlassWindow.SIZE_KEY, JSON.stringify(this.sizePreference)); } catch {}
  }

  sizeBounds() {
    const view = this.viewport();
    const width = Math.max(1, view.width - 24);
    const height = Math.max(1, view.height - 24);
    return { minWidth: Math.min(360, width), minHeight: Math.min(260, height), maxWidth: width, maxHeight: height };
  }

  applySize() {
    if (!this.sizePreference) {
      delete this.panel.dataset.resized;
      this.panel.style.removeProperty("--ss-window-width");
      this.panel.style.removeProperty("--ss-window-height");
      return;
    }
    const bounds = this.sizeBounds();
    const width = Math.round(Math.max(bounds.minWidth, Math.min(this.sizePreference.width, bounds.maxWidth)));
    const height = Math.round(Math.max(bounds.minHeight, Math.min(this.sizePreference.height, bounds.maxHeight)));
    this.panel.dataset.resized = "true";
    this.panel.style.setProperty("--ss-window-width", width + "px");
    this.panel.style.setProperty("--ss-window-height", height + "px");
    this.resizeGrip?.setAttribute("aria-description", "Expanded size " + width + " by " + height + " pixels. Arrow keys resize; Shift moves faster. Home, Enter, or double-click fits content.");
  }

  resetSize() {
    this.endResize();
    this.sizePreference = null;
    this.saveSize();
    this.clampPosition();
    this.scheduleClamp();
  }

  startResize(event, direction, handle) {
    if (this.disposed || this.minimized || this.drag || this.resize || event.button !== 0 || event.isPrimary === false) return;
    const rect = this.panel.getBoundingClientRect();
    this.resize = { pointerId: event.pointerId, handle, direction, x: event.clientX, y: event.clientY,
      left: this.position.x, top: this.position.y, width: rect.width, height: rect.height, userSelect: this.panel.style.userSelect };
    this.panel.dataset.resizing = "true";
    this.panel.style.userSelect = "none";
    try { handle.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
  }

  moveResize(event) {
    const resize = this.resize;
    if (!resize || event.pointerId !== resize.pointerId) return;
    const bounds = this.sizeBounds();
    const view = this.viewport();
    const dx = event.clientX - resize.x;
    const dy = event.clientY - resize.y;
    const west = resize.direction.includes("w"), north = resize.direction.includes("n");
    const width = resize.width + (west ? -dx : resize.direction.includes("e") ? dx : 0);
    const height = resize.height + (north ? -dy : resize.direction.includes("s") ? dy : 0);
    const maxWidth = Math.min(bounds.maxWidth, west ? resize.left + resize.width - view.x - 12 : view.x + view.width - resize.left - 12);
    const maxHeight = Math.min(bounds.maxHeight, north ? resize.top + resize.height - view.y - 12 : view.y + view.height - resize.top - 12);
    this.sizePreference = {
      width: Math.round(Math.max(Math.min(bounds.minWidth, maxWidth), Math.min(width, maxWidth))),
      height: Math.round(Math.max(Math.min(bounds.minHeight, maxHeight), Math.min(height, maxHeight))),
    };
    this.position.x = west ? resize.left + resize.width - this.sizePreference.width : resize.left;
    this.position.y = north ? resize.top + resize.height - this.sizePreference.height : resize.top;
    this.clampPosition();
    event.preventDefault();
  }

  endResize(event) {
    if (!this.resize || (event && event.pointerId !== this.resize.pointerId)) return;
    const resize = this.resize;
    this.resize = null;
    this.panel.style.userSelect = resize.userSelect;
    delete this.panel.dataset.resizing;
    try { if (resize.handle.hasPointerCapture(resize.pointerId)) resize.handle.releasePointerCapture(resize.pointerId); } catch {}
    this.saveSize();
    this.savePosition();
  }

  keyResize(event) {
    if (this.minimized) return;
    if (["Home", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      this.resetSize();
      return;
    }
    const step = event.shiftKey ? 50 : 10;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    const rect = this.panel.getBoundingClientRect();
    const bounds = this.sizeBounds();
    this.sizePreference = { width: Math.max(bounds.minWidth, Math.min(rect.width + delta[0], bounds.maxWidth)), height: Math.max(bounds.minHeight, Math.min(rect.height + delta[1], bounds.maxHeight)) };
    this.clampPosition();
    this.saveSize();
    this.savePosition();
    event.preventDefault();
  }

  clampPosition() {
    if (this.disposed) return;
    this.applySize();
    const view = this.viewport();
    const rect = this.panel.getBoundingClientRect();
    const gutter = this.sizePreference ? 12 : 8;
    const left = view.x + gutter;
    const top = view.y + gutter;
    this.position.x = Math.round(Math.max(left, Math.min(this.position.x, Math.max(left, view.x + view.width - rect.width - gutter))));
    this.position.y = Math.round(Math.max(top, Math.min(this.position.y, Math.max(top, view.y + view.height - rect.height - gutter))));
    this.panel.style.left = this.position.x + "px";
    this.panel.style.top = this.position.y + "px";
  }

  scheduleClamp() {
    if (this.disposed || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.clampPosition();
    });
  }

  isInteractive(target) {
    const control = target?.closest?.("button, a, input, select, textarea, summary, [role='button'], [contenteditable='true']");
    return !!control && control !== this.title;
  }

  startDrag(event) {
    if (this.disposed || this.drag || this.resize || event.button !== 0 || event.isPrimary === false || this.isInteractive(event.target)) return;
    this.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: this.position.x, originY: this.position.y, userSelect: this.panel.style.userSelect };
    this.panel.dataset.dragging = "true";
    this.panel.style.userSelect = "none";
    try { this.header.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
  }

  moveDrag(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.position.x = this.drag.originX + event.clientX - this.drag.x;
    this.position.y = this.drag.originY + event.clientY - this.drag.y;
    this.clampPosition();
    event.preventDefault();
  }

  endDrag(event) {
    if (!this.drag || (event && event.pointerId !== this.drag.pointerId)) return;
    const drag = this.drag;
    this.drag = null;
    this.panel.style.userSelect = drag.userSelect;
    delete this.panel.dataset.dragging;
    try { if (this.header.hasPointerCapture(drag.pointerId)) this.header.releasePointerCapture(drag.pointerId); } catch {}
    this.savePosition();
  }

  keyMove(event) {
    const step = event.shiftKey ? 50 : 10;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (delta) {
      this.position.x += delta[0];
      this.position.y += delta[1];
    } else if (event.key === "Home") this.position = this.defaultPosition();
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.setMinimized(!this.minimized);
      return;
    } else return;
    event.preventDefault();
    this.clampPosition();
    this.savePosition();
  }

  setMinimized(minimized) {
    if (this.disposed) return;
    this.endResize();
    this.minimized = !!minimized;
    this.panel.dataset.minimized = String(this.minimized);
    if (this.content) this.content.hidden = this.minimized;
    const label = this.minimized ? "Restore SpaceCast" : "Minimize SpaceCast";
    if (this.minimizeButton) {
      this.minimizeButton.title = label;
      this.minimizeButton.setAttribute("aria-label", label);
      this.minimizeButton.setAttribute("aria-expanded", String(!this.minimized));
      this.minimizeButton.replaceChildren(this.icon(this.minimized ? "restore" : "minimize"));
    }
    this.title.setAttribute("aria-expanded", String(!this.minimized));
    this.scheduleClamp();
    this.onMinimize(this.minimized);
  }

  dispose() {
    if (this.disposed) return;
    this.endDrag();
    this.endResize();
    this.disposed = true;
    for (const remove of this.listeners.splice(0)) remove();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.resizeObserver?.disconnect();
    for (const handle of this.resizeHandles) handle.remove();
    if (this.ownsTitle) this.title.remove();
    if (this.ownsActions) this.actions.remove();
    else for (const control of this.insertedControls) control.remove();
    this.header.classList.remove("ss-window-drag");
    this.panel.classList.remove("ss-glass-window");
    delete this.panel.dataset.minimized;
    delete this.panel.dataset.resized;
    if (this.content) this.content.hidden = false;
    for (const [name, value] of [["role", this.previous.role], ["aria-label", this.previous.label], ["aria-modal", this.previous.modal]]) {
      if (value === null) this.panel.removeAttribute(name);
      else this.panel.setAttribute(name, value);
    }
    for (const name of ["position", "left", "top", "right", "bottom"]) this.panel.style[name] = this.previous[name];
    for (const [name, value] of [["--ss-window-width", this.previous.widthVariable], ["--ss-window-height", this.previous.heightVariable]]) {
      if (value) this.panel.style.setProperty(name, value);
      else this.panel.style.removeProperty(name);
    }
  }
}
