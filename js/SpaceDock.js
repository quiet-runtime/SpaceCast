/* A whole-Space presentation owned by the extension after X unmounts its popup.
 * Playback is moved, never recreated. Native React controls are not cloned. */
class SpaceDock {
  static snapshot(sheet, space, previous = {}) {
    const text = element => (element?.textContent || "").trim();
    const people = [];
    for (const card of sheet?.querySelectorAll?.(".ss-person") || []) {
      const nameNode = card.querySelector(".ss-person-name");
      const name = text(nameNode);
      const role = text(card.querySelector(".ss-person-role"));
      const profile = [...card.querySelectorAll("a[href]")].map(a => SpaceDock.profileUrl(a.getAttribute("href"))).find(Boolean);
      const avatar = card.querySelector(".ss-person-avatar img");
      const image = SpaceDock.imageUrl(avatar?.currentSrc || avatar?.getAttribute("src"));
      if (name || profile) people.push({ name: name || "Participant", role, profile: profile || "", image });
    }
    return {
      title: text(sheet?.querySelector?.(".ss-sheet-title")) || space.title || previous.title || "X Space",
      recorded: sheet?.querySelector?.(".ss-sheet-rec") ? true : previous.recorded || false,
      people: people.length ? people : previous.people || [],
      listeners: text(sheet?.querySelector?.(".ss-listeners")) || previous.listeners || "",
      notice: text(sheet?.querySelector?.(".ss-notice")) || previous.notice || "",
    };
  }

  static profileUrl(value) {
    try {
      const url = new URL(value, "https://x.com");
      if (url.protocol !== "https:" || !/^(www\.)?(x|twitter)\.com$/.test(url.hostname)) return "";
      if (!/^\/[A-Za-z0-9_]{1,30}\/?$/.test(url.pathname)) return "";
      return "https://x.com" + url.pathname;
    } catch { return ""; }
  }

  static imageUrl(value) {
    if (!value) return "";
    try { const url = new URL(value); return url.protocol === "https:" ? url.href : ""; } catch { return ""; }
  }

  constructor(panel, snapshot, options = {}) {
    this.panel = panel;
    this.space = panel.space;
    this.snapshot = snapshot;
    this.disposed = false;
    this.listeners = [];
    this.root = options.root || document.createElement("div");
    // The detached native outer element can retain its existing capture token.
    // Its old React subtree is discarded; every interactive control below is ours.
    this.root.className = "ss-sheet ss-persistent-space";
    this.root.id = "spacecast-persistent-space";
    this.root.removeAttribute("data-testid");
    this.root.removeAttribute("style");
    this.root.setAttribute("data-ss-persistent", "true");
    this.root.setAttribute("dir", "ltr");
    const body = this.node("div", "ss-sheet-body" + (snapshot.recorded ? " ss-has-rec" : ""));
    const toolbar = this.node("div", "ss-native-toolbar");
    const left = this.node("div");
    const close = this.button("Close SpaceCast", "×", "ss-dock-close");
    this.listen(close, "click", () => options.onClose?.());
    left.append(close);
    const right = this.node("div");
    const share = this.button("Copy Space link", "↗", "ss-dock-share");
    this.listen(share, "click", async () => {
      try { await navigator.clipboard.writeText(this.spaceUrl()); share.title = "Space link copied"; }
      catch { share.title = "Could not copy the Space link"; }
    });
    const nativeLink = this.button("Open native Space controls", "\u22ef", "ss-dock-native-link");
    this.handoffControl(nativeLink, options);
    right.append(share, nativeLink);
    toolbar.append(left, right);
    const heading = this.node("div", "ss-native-heading");
    if (snapshot.recorded) heading.append(this.node("span", "ss-sheet-rec", "● REC"));
    this.title = this.node("div", "ss-sheet-title", snapshot.title || this.space.title || "X Space");
    this.title.dir = "auto";
    this.title.title = this.title.textContent;
    heading.append(this.title);
    const grip = this.button("Move SpaceCast window", "⠿", "ss-sheet-grip");
    const details = this.node("div", "ss-native-details ss-dock-details");
    if (snapshot.people.length) {
      const wrap = this.node("div", "ss-people-wrap");
      const label = this.node("div", "ss-dock-people-label", "People · last seen");
      label.title = "Participant list from when the Space popup was last open";
      const people = this.node("div", "ss-people");
      for (const person of snapshot.people) {
        const card = this.node("div", "ss-person");
        const avatar = person.profile ? this.link("Open " + person.name + "’s profile in a new tab", person.profile, "ss-person-avatar") : this.node("div", "ss-person-avatar");
        if (person.image) {
          const image = document.createElement("img");
          image.src = person.image;
          image.alt = "";
          image.referrerPolicy = "no-referrer";
          avatar.append(image);
        } else avatar.textContent = Array.from(person.name).slice(0, 2).join("");
        const name = person.profile ? this.link("Open " + person.name + "’s profile in a new tab", person.profile, "ss-person-name") : this.node("div", "ss-person-name");
        name.textContent = person.name;
        name.dir = "auto";
        const role = this.node("div", "ss-person-role", person.role);
        role.dir = "auto";
        card.append(avatar, name, role);
        people.append(card);
      }
      wrap.append(label, people);
      details.append(wrap);
    }
    if (snapshot.listeners) {
      const listeners = this.node("div", "ss-listeners", snapshot.listeners);
      listeners.title = "Listener count when the Space popup was last open";
      details.append(listeners);
    }
    const footer = this.node("div", "ss-native-footer");
    footer.append(this.node("p", "ss-notice", "Keep browsing X — this Space keeps playing. Opening native controls stops this player."));
    const open = this.button("Open Space controls", "Open Space controls \u2197", "ss-native-listen ss-dock-open");
    this.handoffControl(open, options);
    footer.append(open);
    details.append(footer);
    body.append(toolbar, heading, panel.element, details, grip);
    this.root.replaceChildren(body);
    document.body.append(this.root);
    this.glass = new SpaceGlassWindow(this.root, { header: heading, titleElement: grip, controls: ["minimize"], controlsContainer: body });
    if (options.position && Number.isFinite(options.position.x) && Number.isFinite(options.position.y)) {
      this.glass.position = { ...options.position };
      this.glass.clampPosition();
    }
    if (options.minimized) this.glass.setMinimized(true);
    this.disposeAppearance = options.appearance?.(this.root, panel) || (() => {});
  }

  node(tag, className = "", text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  button(label, text, className) {
    const button = this.node("button", className, text);
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    return button;
  }

  link(label, href, className) {
    const link = this.node("a", className);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = label;
    link.setAttribute("aria-label", label);
    return link;
  }

  handoffControl(button, options) {
    this.listen(button, "click", () => options.onOpenControls?.(this.spaceUrl(true)));
  }

  listen(target, type, handler) {
    target.addEventListener(type, handler);
    this.listeners.push(() => target.removeEventListener(type, handler));
  }

  spaceUrl(native = false) { return "https://x.com/i/spaces/" + encodeURIComponent(this.space.id) + "/peek" + (native ? "?spacecast=native" : ""); }

  refresh() {
    if (this.disposed) return;
    const title = this.space.title || this.snapshot.title || "X Space";
    if (this.title.textContent !== title) this.title.textContent = title;
    if (this.title.title !== title) this.title.title = title;
    if (!this.root.isConnected) document.body.append(this.root);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of this.listeners.splice(0)) remove();
    this.disposeAppearance();
    this.glass.dispose();
    this.root.remove();
  }
}
