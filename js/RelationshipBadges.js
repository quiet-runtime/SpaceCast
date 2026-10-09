/* Visible relationship labels; native controls and React-owned children stay intact. */
(() => {
  "use strict";
  const FLAGS = ["following", "followedBy", "blocking", "blockedBy", "muting", "followRequested"];
  const labels = {
    mutual: ["↔", "Mutual", "You follow each other"], following: ["→", "Following", "You follow this account"],
    follower: ["←", "Follows you", "This account follows you"], blocked: ["⊘", "Blocked", "You blocked this account"],
    blockedBy: ["⊘", "Blocks you", "This account blocks you"], muted: ["◌", "Muted", "You muted this account"],
    requested: ["◷", "Requested", "Your follow request is pending"], self: ["•", "You", "Your signed-in account"],
    none: ["·", "No follow", "Neither account follows the other"], unknown: ["?", "Unknown", "X has not supplied a verified relationship for this account"],
  };
  function describe(person) {
    const kinds = [];
    if (person?.self === true) kinds.push("self");
    else if (person) {
      if (person.blocking === true) kinds.push("blocked");
      if (person.blockedBy === true) kinds.push("blockedBy");
      if (person.following === true && person.followedBy === true) kinds.push("mutual");
      else {
        if (person.following === true) kinds.push("following");
        if (person.followedBy === true) kinds.push("follower");
      }
      if (person.muting === true) kinds.push("muted");
      if (person.followRequested === true) kinds.push("requested");
      if (!kinds.length && FLAGS.every(key => person[key] === false)) kinds.push("none");
    }
    if (!kinds.length) kinds.push("unknown");
    const [icon, text] = labels[kinds[0]];
    return { kind: kinds[0], icon, text, title: kinds.map(kind => labels[kind][2]).join(" · ") };
  }
  function profileHandle(card) {
    const handles = new Set();
    for (const link of card.querySelectorAll("a[href]")) {
      try {
        const url = new URL(link.getAttribute("href"), "https://x.com");
        const match = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(url.pathname);
        if (url.protocol === "https:" && /^(?:www\.)?(?:x|twitter)\.com$/.test(url.hostname) && match) handles.add(match[1].toLowerCase());
      } catch { /* An unrelated link is not account identity. */ }
    }
    return handles.size === 1 ? [...handles][0] : null;
  }

  class RelationshipBadges {
    constructor(sheet, roomId) {
      this.sheet = sheet;
      this.roomId = roomId;
      this.prefix = "scr-" + crypto.randomUUID();
      this.nextToken = 0;
      this.entries = new Map();
      const appearance = globalThis.SpaceCastAppearance;
      this.enabled = typeof appearance?.load !== "function";
      this.settingsRevision = 0;
      this.disposed = false;
      this.timer = null;
      this.lastRead = -Infinity;
      this.serial = 0;
      this.generation = 0;
      this.pending = null;
      this.urgent = false;
      sheet.setAttribute("data-ss-relation-sheet", this.prefix);
      sheet.setAttribute("data-ss-relation-enabled", String(this.enabled));
      this.receive = event => {
        const data = event.data, pending = this.pending;
        if (event.source !== window || event.origin !== location.origin) return;
        if (data?.source === "spacecast:relationships:updated") { this.queue(true); return; }
        if (!pending ||
            data?.source !== "spacecast:relationships:response" || data.id !== pending.id ||
            data.sheet !== this.prefix || data.roomId !== this.roomId) return;
        clearTimeout(pending.timer);
        this.pending = null;
        pending.resolve(data);
      };
      window.addEventListener("message", this.receive);
      this.visible = () => this.queue(true);
      document.addEventListener("visibilitychange", this.visible);
      this.intersections = new IntersectionObserver(entries => {
        for (const item of entries) {
          const entry = this.entries.get(item.target);
          if (entry) entry.visible = item.isIntersecting;
        }
        this.queue(true);
      }, { root: sheet, rootMargin: "40px" });
      this.observer = new MutationObserver(records => {
        const nativeChange = records.some(record => {
          if (record.target.closest?.(".ss-relationship")) return false;
          if (record.type === "attributes") return true;
          const changed = [...record.addedNodes, ...record.removedNodes];
          return changed.some(node => !node.classList?.contains("ss-relationship"));
        });
        if (nativeChange) this.refresh();
      });
      this.observer.observe(sheet, { subtree: true, childList: true, attributes: true, attributeFilter: ["href", "data-testid"] });
      this.onAppearance = event => this.configure(event.detail?.relationshipBadges !== false);
      sheet.addEventListener("spacecast:appearancechange", this.onAppearance);
      const initialSettingsRevision = this.settingsRevision;
      const initialize = enabled => {
        if (this.settingsRevision === initialSettingsRevision) this.configure(enabled);
      };
      this.unsubscribe = appearance?.subscribe(settings => this.configure(settings.relationshipBadges !== false));
      if (typeof appearance?.load === "function") {
        // Loading account data is opt-out. Wait for the persisted preference
        // before sending the first request, and never overwrite a newer change.
        try { Promise.resolve(appearance.load()).then(settings => initialize(settings?.relationshipBadges !== false), () => initialize(true)); }
        catch { initialize(true); }
      }
      this.refresh();
    }
    valid(card, entry) {
      return this.entries.get(card) === entry && card.getAttribute("data-ss-relation-key") === entry.token &&
        this.sheet.isConnected && this.sheet.contains(card) && card.classList.contains("ss-person") && profileHandle(card) === entry.handle;
    }
    render(card, entry, person) {
      const info = describe(person);
      const signature = JSON.stringify(info);
      if (entry.signature === signature && entry.badge?.parentElement === card) return;
      entry.badge?.remove();
      const badge = document.createElement("span");
      badge.className = "ss-relationship";
      badge.setAttribute("data-ss-relationship", info.kind);
      badge.setAttribute("dir", "ltr");
      badge.setAttribute("role", "img");
      badge.setAttribute("aria-label", info.title);
      badge.title = info.title + " · Relative to your signed-in X account";
      const icon = document.createElement("span"), text = document.createElement("span");
      icon.setAttribute("aria-hidden", "true"); icon.textContent = info.icon;
      text.setAttribute("aria-hidden", "true"); text.textContent = info.text;
      badge.append(icon, text);
      card.append(badge);
      entry.badge = badge;
      entry.signature = signature;
    }
    forget(card, entry) {
      entry.badge?.remove();
      this.intersections.unobserve(card);
      if (card.getAttribute("data-ss-relation-key") === entry.token) card.removeAttribute("data-ss-relation-key");
      this.entries.delete(card);
    }
    refresh() {
      if (this.disposed) return;
      let added = false;
      for (const [card, entry] of this.entries) if (!this.valid(card, entry)) this.forget(card, entry);
      for (const card of this.sheet.querySelectorAll(".ss-person")) {
        const handle = profileHandle(card);
        if (!handle || this.entries.has(card)) continue;
        const entry = { handle, token: this.prefix + ":" + (++this.nextToken), visible: false, badge: null, signature: "" };
        this.entries.set(card, entry);
        added = true;
        card.setAttribute("data-ss-relation-key", entry.token);
        this.intersections.observe(card);
      }
      if (this.enabled) for (const [card, entry] of this.entries) if (!entry.badge) this.render(card, entry, null);
      this.queue(added);
    }
    queue(urgent = false) {
      if (this.disposed || !this.enabled || document.hidden || !this.entries.size) return;
      this.urgent ||= urgent;
      if (this.pending || (this.timer !== null && !this.urgent)) return;
      if (this.timer !== null) clearTimeout(this.timer);
      const interval = this.urgent ? 180 : 1500;
      this.urgent = false;
      this.timer = setTimeout(() => this.read(), Math.max(0, interval - (performance.now() - this.lastRead)));
    }
    request(tokens) {
      return new Promise(resolve => {
        const id = this.prefix + ":" + (++this.serial);
        const timer = setTimeout(() => {
          if (this.pending?.id === id) { this.pending = null; resolve(null); }
        }, 1200);
        this.pending = { id, timer, resolve };
        window.postMessage({ source: "spacecast:relationships:request", id, sheet: this.prefix, roomId: this.roomId, tokens }, location.origin);
      });
    }
    async read() {
      this.timer = null;
      if (this.disposed || !this.enabled || document.hidden || !this.sheet.isConnected) return;
      if (this.sheet.dataset.minimized === "true" || this.sheet.dataset.resizing === "true" || this.sheet.dataset.dragging === "true") {
        this.lastRead = performance.now(); this.queue(); return;
      }
      const generation = this.generation;
      const active = [...this.entries].filter(([card, entry]) => entry.visible && this.valid(card, entry));
      if (!active.length) return;
      this.lastRead = performance.now();
      const data = await this.request(active.map(([, entry]) => entry.token));
      if (this.disposed || !this.enabled || generation !== this.generation) return;
      const people = new Map(), duplicate = new Set();
      for (const person of Array.isArray(data?.people) && data.people.length <= 2048 ? data.people : []) {
        if (!person || typeof person.token !== "string" || typeof person.userId !== "string" || !/^\d{1,32}$/.test(person.userId) ||
            typeof person.screenName !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(person.screenName) || typeof person.self !== "boolean" ||
            FLAGS.some(key => person[key] !== null && typeof person[key] !== "boolean")) continue;
        if (people.has(person.token)) duplicate.add(person.token);
        people.set(person.token, person);
      }
      for (const [card, entry] of active) {
        if (!this.valid(card, entry)) continue;
        const person = people.get(entry.token);
        this.render(card, entry, person && !duplicate.has(entry.token) && person.screenName.toLowerCase() === entry.handle ? person : null);
      }
      this.queue();
    }
    configure(enabled) {
      if (this.disposed) return;
      this.settingsRevision++;
      if (this.enabled !== enabled) this.generation++;
      this.enabled = enabled;
      if (this.sheet.getAttribute('data-ss-relation-enabled') !== String(enabled)) this.sheet.setAttribute('data-ss-relation-enabled', String(enabled));
      if (enabled) this.refresh();
      else {
        clearTimeout(this.timer); this.timer = null;
        for (const entry of this.entries.values()) { entry.badge?.remove(); entry.badge = null; entry.signature = ""; }
      }
    }
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      clearTimeout(this.timer);
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve(null); this.pending = null; }
      window.removeEventListener("message", this.receive);
      document.removeEventListener("visibilitychange", this.visible);
      this.sheet.removeEventListener("spacecast:appearancechange", this.onAppearance);
      this.unsubscribe?.();
      this.observer.disconnect();
      for (const [card, entry] of this.entries) this.forget(card, entry);
      this.intersections.disconnect();
      if (this.sheet.getAttribute("data-ss-relation-sheet") === this.prefix) {
        this.sheet.removeAttribute("data-ss-relation-sheet");
        this.sheet.removeAttribute("data-ss-relation-enabled");
      }
    }
  }
  globalThis.SpaceCastRelationships = Object.freeze({ create: (sheet, roomId) => new RelationshipBadges(sheet, roomId), describe });
})();
