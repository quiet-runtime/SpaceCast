/* Keep native preview frames offscreen until the integrated window is ready. */
(() => {
  const ATTRIBUTE = "data-ss-presentation";
  const records = new Map();
  const owners = new WeakMap();
  let declined = new WeakMap();
  let route = "";
  let sequence = 0;

  function routeKey() {
    return location.pathname + (new URLSearchParams(location.search).get("spacecast") === "native" ? "?spacecast=native" : "");
  }

  function previewRoute() {
    return /^\/i\/spaces\/[A-Za-z0-9_-]+\/peek(?:\/|$)/.test(location.pathname);
  }

  function allowedRoute() {
    return new URLSearchParams(location.search).get("spacecast") !== "native" &&
      (!/^\/i\/spaces\/[A-Za-z0-9_-]+(?:\/|$)/.test(location.pathname) || previewRoute());
  }

  function controls(sheet) {
    return [...sheet.querySelectorAll('button, [role="button"]')]
      .filter(element => !element.closest("#spacecast-panel"));
  }

  function label(element) {
    return (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function nativeManager(sheet) {
    return controls(sheet).some(element => /^(?:leave|manage space)$/i.test(label(element)));
  }

  function candidate(sheet) {
    if (sheet.hasAttribute("data-ss-persistent") || nativeManager(sheet)) return false;
    if (/^(?:share|report|block|mute|embed)(?:\b|$)/i.test(sheet.getAttribute("aria-label") || "")) return false;
    if ([...sheet.querySelectorAll('h1, h2, [role="heading"]')].some(heading =>
      !heading.matches('[data-testid="tweetText"]') && /^(?:share|report|block|mute|embed)(?: (?:this )?(?:space|post|tweet|account))?$/i.test(label(heading)))) return false;
    const title = !!sheet.querySelector('[data-testid="tweetText"]');
    const join = controls(sheet).some(element =>
      /^(?:start (?:listening(?: anonymously)?|speaking)|join(?: (?:this )?space)?)$/i.test(label(element)));
    // X can attach the preview before pushState changes the background route.
    // Require stronger evidence there so ordinary article/share sheets stay visible.
    return previewRoute() ? title || join :
      (title && (join || !!sheet.querySelector('[data-testid^="UserAvatar-Container-"]'))) ||
      (/^space$/i.test(sheet.getAttribute("aria-label") || "") && join);
  }

  function mark(record, element) {
    const previousOwner = owners.get(element);
    const previous = previousOwner ? previousOwner.marks.get(element) : element.getAttribute(ATTRIBUTE);
    if (!record.marks.has(element)) record.marks.set(element, previous);
    owners.set(element, record);
    element.setAttribute(ATTRIBUTE, record.state);
  }

  function finish(record) {
    if (records.get(record.sheet) !== record) return;
    clearTimeout(record.timer);
    clearTimeout(record.poll);
    records.delete(record.sheet);
    for (const [element, previous] of record.marks) {
      if (owners.get(element) !== record) continue;
      owners.delete(element);
      if (element.getAttribute(ATTRIBUTE) !== record.state) continue;
      if (previous === null) element.removeAttribute(ATTRIBUTE);
      else element.setAttribute(ATTRIBUTE, previous);
    }
    if (record.sheet.isConnected) declined.set(record.sheet, record.route);
    else declined.delete(record.sheet);
  }

  function begin(sheet, state) {
    const previous = records.get(sheet);
    if (previous) finish(previous);
    const record = { sheet, route: routeKey(), marks: new Map() };
    record.state = state;
    record.generation = ++sequence;
    records.set(sheet, record);
    mark(record, sheet);
    record.timer = setTimeout(() => finish(record), state === "closing" ? 2000 : 1500);
    if (state === "opening") {
      const poll = () => {
        if (records.get(sheet) !== record) return;
        sync();
        if (records.get(sheet) === record) record.poll = setTimeout(poll, 50);
      };
      record.poll = setTimeout(poll, 50);
    }
    return record;
  }

  function prepare(sheet, explicit = true) {
    if (!sheet?.isConnected || !allowedRoute() || !candidate(sheet)) return false;
    const record = records.get(sheet);
    if (record?.state === "opening") return true;
    if (!explicit && (record?.state === "closing" || declined.get(sheet) === routeKey())) return false;
    begin(sheet, "opening");
    return true;
  }

  function ready(sheet, pending) {
    const record = records.get(sheet);
    if (!record || record.state !== "opening") return;
    const generation = record.generation;
    const reveal = () => {
      if (records.get(sheet) === record && record.state === "opening" && record.generation === generation) finish(record);
    };
    if (pending && typeof pending.then === "function") Promise.resolve(pending).then(reveal, reveal);
    else reveal();
  }

  function dismiss(sheet) {
    if (!sheet?.isConnected || nativeManager(sheet)) return;
    const record = begin(sheet, "closing");
    // These empty decorations were identified by our own SpaceSheet instance.
    // Retain their invisibility when its cleanup restores X's portal classes.
    for (const element of document.querySelectorAll(".ss-overlay-backdrop, .ss-focus-guard")) {
      if (element.children.length || element.textContent.trim()) continue;
      mark(record, element);
    }
  }

  function release(sheet) {
    const record = records.get(sheet);
    if (record?.state === "opening") finish(record);
    else if (!record && sheet?.isConnected) declined.set(sheet, routeKey());
  }

  function sync() {
    const nextRoute = routeKey();
    const changed = nextRoute !== route;
    if (changed) { route = nextRoute; declined = new WeakMap(); }
    for (const record of records.values()) {
      if (!record.sheet.isConnected || nativeManager(record.sheet) ||
          (record.state === "opening" && !allowedRoute())) finish(record);
      else if (record.state === "opening") record.route = route;
    }
    if (allowedRoute()) {
      for (const sheet of document.querySelectorAll('[data-testid="sheetDialog"]')) {
        if (!sheet.classList.contains("ss-sheet") && candidate(sheet)) prepare(sheet, false);
      }
    }
    if (changed && [...records.values()].some(record => record.state === "opening"))
      window.dispatchEvent(new Event("spacecast:presentationsync"));
  }

  globalThis.SpaceCastPresentation = { prepare, ready, dismiss, release, sync };
  new MutationObserver(sync).observe(document, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["data-testid", "aria-label", "data-ss-persistent"],
  });
  window.addEventListener("popstate", sync);
  window.addEventListener("pageshow", sync);
  sync();
})();
