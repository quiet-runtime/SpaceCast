/* Reconcile presentation with X's current preview DOM without replacing controls. */
class SpacePreviewLayout {
  constructor(sheet, panelElement = null) {
    this.sheet = sheet;
    this.panel = panelElement;
    this.tags = new Map();
    this.directions = new Map();
    this.disposed = false;
    this.refresh();
    // React replaces className when native controls change state. Repair only
    // our existing tags before paint; rescanning the whole sheet on every
    // native hover/press class change would create needless layout work.
    this.classObserver = new MutationObserver(records => {
      if (this.disposed) return;
      for (const element of new Set(records.map(record => record.target))) {
        if (!this.sheet.contains(element)) continue;
        for (const name of this.tags.get(element) || []) {
          if (!element.classList.contains(name)) element.classList.add(name);
        }
      }
    });
    this.classObserver.observe(sheet, { attributes: true, subtree: true, attributeFilter: ["class"] });
  }

  static isJoinControl(element) {
    if (!element?.matches('button, [role="button"]')) return false;
    const label = (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim();
    return /^(?:start (?:listening(?: anonymously)?|speaking)|join(?: (?:this )?space)?)$/i.test(label);
  }

  static isProfileLink(element) {
    try {
      const url = new URL(element.getAttribute("href"), "https://x.com");
      return url.protocol === "https:" && /^(?:www\.)?(?:x|twitter)\.com$/.test(url.hostname) &&
        /^\/[A-Za-z0-9_]{1,30}\/?$/.test(url.pathname) &&
        !/^\/(?:help|privacy|tos|settings|home|explore|search|notifications|messages|i)\/?$/i.test(url.pathname);
    } catch { return false; }
  }

  owned(element) {
    return element === this.panel || element?.classList.contains("ss-sheet-grip") ||
      element?.classList.contains("ss-window-minimize") || element?.classList.contains("ss-glass-lens") ||
      element?.classList.contains("spacecast-resize-handle");
  }

  directChild(parent, element) {
    if (!parent || !element || parent === element) return null;
    let child = element;
    while (child.parentElement && child.parentElement !== parent) child = child.parentElement;
    return child.parentElement === parent ? child : null;
  }

  refresh() {
    if (this.disposed || !this.sheet.isConnected) return;
    this.body = this.heading = this.closeButton = this.details = null;
    const wanted = new Map();
    const autoDirection = new Set();
    const tag = (element, name) => {
      if (!element) return;
      if (!wanted.has(element)) wanted.set(element, new Set());
      wanted.get(element).add(name);
    };
    const controls = element => [...element.querySelectorAll('button, [role="button"]')]
      .filter(control => !this.panel?.contains(control) && !this.owned(control));
    const joinControls = element => [element, ...controls(element)].filter(SpacePreviewLayout.isJoinControl);
    const switches = element => [element, ...element.querySelectorAll('[role="switch"]')]
      .filter(control => control.matches('[role="switch"]'));
    const styleAnonymous = (section, toggles) => {
      for (const toggle of toggles) {
        let surface = toggle;
        if (toggle.matches('input[type="checkbox"]')) {
          const parent = toggle.parentElement;
          // X draws its checkbox with two sibling divs, not children of the input.
          const artwork = parent && [...parent.children].filter(element => element !== toggle);
          if (parent && section.contains(parent) && artwork.every(element =>
            element.matches('div, span') && !element.textContent.trim() && !controls(element).length &&
            !element.querySelector('input, [role="switch"]'))) {
            surface = parent;
            tag(toggle, "ss-anonymous-input");
            for (const element of artwork) tag(element, "ss-anonymous-artwork");
          }
        }
        tag(surface, "ss-anonymous-switch");
        if (surface === toggle) for (const element of toggle.children) tag(element, "ss-anonymous-artwork");
        let rowFound = false;
        for (let wrapper = surface.parentElement; wrapper && section.contains(wrapper); wrapper = wrapper.parentElement) {
          const hasLabel = !joinControls(wrapper).length && [...wrapper.children]
            .some(element => !element.contains(surface) && element.textContent.trim());
          tag(wrapper, !rowFound && hasLabel ? "ss-anonymous-row" : "ss-anonymous-wrap");
          rowFound ||= hasLabel;
          if (wrapper === section) break;
        }
      }
    };
    const styleActions = (footer, joins, toggles) => {
      tag(footer, "ss-native-footer");
      for (const button of joins) {
        tag(button, "ss-native-listen");
        for (let wrapper = button.parentElement; wrapper && wrapper !== footer && footer.contains(wrapper); wrapper = wrapper.parentElement) {
          tag(wrapper, "ss-native-actions");
        }
      }
      if (joins.includes(footer)) return;
      for (const element of footer.children) {
        if (!joins.some(button => element === button || element.contains(button)) &&
            !toggles.some(toggle => element === toggle || element.contains(toggle))) tag(element, "ss-notice");
      }
    };
    this.body = [...this.sheet.children].find(element => !this.owned(element)) || null;
    if (!this.body) { this.commit(wanted, autoDirection); return; }
    tag(this.body, "ss-sheet-body");
    const children = [...this.body.children].filter(element => !this.owned(element));
    this.closeButton = controls(this.body).find(button =>
      /^(?:close|dismiss)(?: space)?$/i.test((button.getAttribute("aria-label") || "").trim())) || null;
    const toolbar = this.directChild(this.body, this.closeButton) || children.find(element =>
      element.querySelector('button[aria-label="Share"], button[aria-label="More"]'));
    tag(toolbar, "ss-native-toolbar");
    const afterToolbar = children.slice(Math.max(0, children.indexOf(toolbar) + 1));
    this.heading = afterToolbar.find(element => element.querySelector('[data-testid="tweetText"], h1, h2, [role="heading"]')) ||
      afterToolbar.find(element => element.textContent.trim()) || null;
    if (!this.heading) { this.commit(wanted, autoDirection); return; }
    const nestedTitle = this.heading.querySelector('h1, h2, [role="heading"]');
    const title = nestedTitle || this.heading.lastElementChild || this.heading;
    // Some X layouts put heading and details into a single wrapper.
    const headingIsSection = !!nestedTitle && this.heading !== nestedTitle &&
      (joinControls(this.heading).length > 0 || !!this.heading.querySelector('[data-testid^="UserAvatar-Container-"]'));
    tag(headingIsSection ? nestedTitle : this.heading, "ss-native-heading");
    tag(title, "ss-sheet-title");
    autoDirection.add(title);
    if (!headingIsSection && this.heading.children.length > 1) {
      const recorded = [...this.heading.children].find(element => element !== title && /^(?:[●•]\s*)?REC$/i.test(element.textContent.trim()));
      if (recorded) { tag(recorded, "ss-sheet-rec"); tag(this.body, "ss-has-rec"); }
    }
    const anchor = headingIsSection ? nestedTitle : this.heading;
    if (this.panel && anchor.nextElementSibling !== this.panel) anchor.after(this.panel);
    const details = headingIsSection ? this.heading : afterToolbar[afterToolbar.indexOf(this.heading) + 1];
    this.details = details || null;
    if (details) {
      tag(details, headingIsSection ? "ss-native-section" : "ss-native-details");
      for (const child of details.children) {
        if (this.owned(child) || child === nestedTitle) continue;
        const joins = joinControls(child);
        const toggles = switches(child);
        if (toggles.length) styleAnonymous(child, toggles);
        // Native actions take priority over anchors in their explanatory copy.
        if (joins.length) {
          styleActions(child, joins, toggles);
          continue;
        }
        if (toggles.length) {
          tag(child, "ss-anonymous");
          continue;
        }
        const profileLinks = [...child.querySelectorAll("a[href]")].filter(link => SpacePreviewLayout.isProfileLink(link) &&
          (link.querySelector("img, svg") || link.querySelector('[data-testid^="UserAvatar-Container-"]') ||
            link.closest('[data-testid^="UserAvatar-Container-"]')));
        if (profileLinks.length) {
          tag(child, "ss-people-wrap");
          let grid = child;
          while (grid.children.length === 1 && grid.firstElementChild.contains(profileLinks[0])) {
            const next = grid.firstElementChild;
            const looksLikeCard = next.children.length > 1 && profileLinks.filter(link => next.contains(link)).length === 1 &&
              next.firstElementChild.contains(profileLinks[0]) &&
              [...next.children].slice(1).some(element => element.textContent.trim());
            if (looksLikeCard) break;
            grid = next;
          }
          tag(grid, "ss-people");
          for (const card of grid.children) {
            if (!profileLinks.some(link => card.contains(link))) continue;
            tag(card, "ss-person");
            tag(card.children[0], "ss-person-avatar");
            tag(card.children[1], "ss-person-name");
            tag(card.children[2], "ss-person-role");
          }
        } else if (!child.matches('button, [role="button"]') && !controls(child).length) {
          tag(child, "ss-listeners");
          tag(child.firstElementChild, "ss-listeners-inner");
        }
      }
    }
    this.commit(wanted, autoDirection);
  }

  commit(wanted, autoDirection) {
    for (const [element, names] of this.tags) {
      for (const name of [...names]) {
        if (wanted.get(element)?.has(name)) continue;
        element.classList.remove(name);
        names.delete(name);
      }
      if (!names.size) this.tags.delete(element);
    }
    for (const [element, names] of wanted) {
      for (const name of names) {
        if (element.classList.contains(name)) continue;
        element.classList.add(name);
        if (!this.tags.has(element)) this.tags.set(element, new Set());
        this.tags.get(element).add(name);
      }
    }
    for (const [element, previous] of this.directions) {
      if (autoDirection.has(element)) continue;
      this.restoreDirection(element, previous);
      this.directions.delete(element);
    }
    for (const element of autoDirection) {
      if (element.getAttribute("dir") === "auto") continue;
      if (!this.directions.has(element)) this.directions.set(element, element.getAttribute("dir"));
      element.setAttribute("dir", "auto");
    }
  }

  restoreDirection(element, previous) {
    if (element.getAttribute("dir") !== "auto") return;
    if (previous === null) element.removeAttribute("dir");
    else element.setAttribute("dir", previous);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.classObserver?.disconnect();
    this.commit(new Map(), new Set());
  }
}
