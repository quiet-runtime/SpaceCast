/* Read-only access to relationships already loaded by X for the visible preview. */
(() => {
  "use strict";
  if (globalThis.SpaceCastRelationshipReader) return;
  const FIELDS = Object.freeze({ following: "following", followedBy: "followed_by", blocking: "blocking", blockedBy: "blocked_by", muting: "muting", followRequested: "follow_request_sent" });
  const own = (object, key) => object && (typeof object === "object" || typeof object === "function")
    ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
  const handle = value => typeof value === "string" && /^[A-Za-z0-9_]{1,15}$/.test(value) ? value.toLowerCase() : null;
  const userId = value => typeof value === "string" && /^\d{1,32}$/.test(value) ? value : null;
  const key = value => typeof value === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(value) ? value : null;
  const room = value => typeof value === "string" && /^[A-Za-z0-9]{1,64}$/.test(value) ? value : null;
  const unknown = () => Object.fromEntries(Object.keys(FIELDS).map(name => [name, null]));
  const excluded = '[data-ss-persistent],article,[data-testid="tweet"],[data-testid="tweetDetail"],[data-spacex-owned]';

  function chainFrom(first, committed) {
    const nodes = [], seen = new Set();
    for (let fiber = first; fiber && nodes.length < 256; fiber = own(fiber, 'return')) {
      if (seen.has(fiber)) return [];
      seen.add(fiber); nodes.push(fiber);
      if (committed.has(fiber) || committed.has(own(fiber, 'alternate'))) break;
    }
    return nodes;
  }

  function ownsChild(parent, child) {
    const seen = new Set();
    for (let node = own(parent, 'child'); node; node = own(node, 'sibling')) {
      if (seen.has(node) || seen.size >= 2048) return false;
      if (node === child) return true;
      seen.add(node);
    }
    return false;
  }

  function ancestry(card, committed) {
    const keys = Object.getOwnPropertyNames(card).filter(key => key.startsWith('__reactFiber$'));
    if (keys.length !== 1) return [];
    const first = own(card, keys[0]);
    if (own(first, 'stateNode') !== card) return [];
    const initial = chainFrom(first, committed);
    if (!initial.length) return [];
    const alternate = own(first, 'alternate');
    if (alternate && (alternate === first || own(alternate, 'alternate') !== first || own(alternate, 'stateNode') !== card)) return [];
    // Older native trees can expose only a single ancestry. Once React exposes
    // alternates or a HostRoot, use the committed root rather than stale props.
    if (!initial.some(fiber => own(fiber, 'tag') === 3 || own(fiber, 'alternate') || committed.has(fiber))) return initial;
    const paths = [], seen = new Set();
    const stack = [first, alternate].filter(Boolean).map(fiber => ({ fiber, previous: null, length: 1 }));
    while (stack.length) {
      const path = stack.pop(), { fiber } = path;
      if (seen.has(fiber) || seen.size >= 1024) return [];
      seen.add(fiber);
      const known = committed.get(fiber);
      if (known) {
        if (own(known.rootState, 'current') !== known.root) return [];
        paths.push({ path, tail: known.parent });
        continue;
      }
      if (own(fiber, 'tag') === 3) {
        if (own(own(fiber, 'stateNode'), 'current') === fiber) paths.push({ path, tail: null });
        continue;
      }
      if (path.length >= 256) continue;
      const parent = own(fiber, 'return'), other = own(parent, 'alternate');
      if (other && (other === parent || own(other, 'alternate') !== parent)) continue;
      // A bailout can share a child list and leave the child's return pointer
      // on the other parent. Check both parents without walking unrelated trees.
      for (const candidate of [parent, other].filter(Boolean)) {
        if (!ownsChild(candidate, fiber)) continue;
        stack.push({ fiber: candidate, previous: path, length: path.length + 1 });
      }
    }
    if (paths.length !== 1) return [];
    const current = [];
    for (let path = paths[0].path; path; path = path.previous) current.push(path.fiber);
    current.reverse();
    for (let tail = paths[0].tail; tail; tail = tail.parent) current.push(tail.fiber);
    const root = current[current.length - 1], rootState = own(root, 'stateNode');
    let parent = null;
    // Sibling cards share almost all ancestors. Cache only the proven committed
    // path for this synchronous read, retaining root validation on every reuse.
    for (let index = current.length - 1; index >= 0; index--) {
      const known = committed.get(current[index]);
      parent = known?.root === root && known.parent === parent ? known : { fiber: current[index], parent, root, rootState };
      committed.set(current[index], parent);
    }
    return current;
  }

  function identity(chain, expectedRoom) {
    let screenName = null;
    for (const fiber of chain) {
      const props = own(fiber, "memoizedProps");
      const name = handle(own(props, "screenName"));
      if (name) {
        if (screenName && screenName !== name) return null;
        screenName = name;
      }
      const nativeRoom = room(own(props, "audioSpaceId"));
      const participants = own(props, "participants");
      if (!nativeRoom || !participants || typeof participants !== "object") continue;
      if (nativeRoom !== expectedRoom || !screenName) return null;
      const records = [own(props, "host")];
      for (const list of [own(props, "cohosts"), ...["admins", "speakers", "listeners"].map(name => own(participants, name))]) {
        if (list === undefined) continue;
        if (!Array.isArray(list) || list.length > 2048) return null;
        records.push(...list);
      }
      const ids = new Set();
      for (const record of records) if (handle(own(record, "twitter_screen_name")) === screenName) {
        const id = userId(own(record, "user_id"));
        if (!id) return null;
        ids.add(id);
      }
      return ids.size === 1 ? { userId: [...ids][0], screenName } : null;
    }
    return null;
  }

  function contexts(chain, cached) {
    const values = [], valuesSeen = new Set();
    for (const fiber of chain) {
      if (!cached.has(fiber)) {
        const dependenciesSeen = new Set(), local = [];
        let invalid = false;
        for (let dependency = own(own(fiber, 'dependencies'), 'firstContext'); dependency; dependency = own(dependency, 'next')) {
          if (dependenciesSeen.has(dependency) || dependenciesSeen.size >= 64) { invalid = true; break; }
          dependenciesSeen.add(dependency); local.push(own(dependency, 'memoizedValue'));
        }
        cached.set(fiber, invalid ? null : local);
      }
      const local = cached.get(fiber);
      if (!local) return null;
      for (const value of local) {
        if (!valuesSeen.has(value)) { valuesSeen.add(value); values.push(value); }
      }
    }
    return values;
  }

  function read(sheet, expectedRoom, requested) {
    const people = [], stores = new Map(), committed = new Map(), contextValues = new Map();
    try {
      if (!room(expectedRoom) || !Array.isArray(requested) || requested.length > 2048 ||
          !requested.length || requested.some(value => !key(value)) || new Set(requested).size !== requested.length ||
          !sheet?.isConnected || !sheet.matches('[data-testid="sheetDialog"]') || sheet.closest(excluded)) return people;
      const wanted = new Set(requested), cards = new Map();
      for (const card of sheet.querySelectorAll(".ss-person[data-ss-relation-key]")) {
        const token = card.getAttribute("data-ss-relation-key");
        if (wanted.has(token)) cards.set(token, cards.has(token) ? null : card);
      }
      for (const [token, card] of cards) {
        try {
          if (!card?.isConnected || card.closest(excluded) || card.closest('[data-testid="sheetDialog"]') !== sheet) continue;
          const chain = ancestry(card, committed), person = identity(chain, expectedRoom);
          if (!person) continue;
          const values = contexts(chain, contextValues), viewers = new Set(), samples = [];
          let invalid = values === null;
          for (const value of values || []) {
            const viewer = userId(own(value, "viewerUserId"));
            if (viewer) viewers.add(viewer);
            const store = own(value, "store"), getState = own(store, "getState");
            if (typeof getState !== "function") continue;
            if (!stores.has(store)) {
              try { stores.set(store, Reflect.apply(getState, store, [])); }
              catch { stores.set(store, null); }
            }
            const user = own(own(own(own(stores.get(store), "entities"), "users"), "entities"), person.userId);
            if (user === undefined) continue;
            if (userId(own(user, "id_str")) !== person.userId || handle(own(user, "screen_name")) !== person.screenName) { invalid = true; continue; }
            samples.push(user);
          }
          invalid ||= viewers.size !== 1;
          const flags = unknown();
          if (!invalid && samples.length) for (const [output, input] of Object.entries(FIELDS)) {
            const flagsFound = samples.map(sample => own(sample, input));
            flags[output] = flagsFound.every(value => typeof value === "boolean" && value === flagsFound[0]) ? flagsFound[0] : null;
          }
          people.push({ token, ...person, self: !invalid && viewers.has(person.userId), ...flags });
        } catch { /* Recycled or unfamiliar native cards remain unknown. */ }
      }
    } catch { /* A closing native preview is not relationship evidence. */ }
    return people;
  }

  Object.defineProperty(globalThis, "SpaceCastRelationshipReader", { value: Object.freeze({ read }), configurable: false });
  let lastRequest = -Infinity;
  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.source !== "spacecast:relationships:request" ||
        !key(data.id) || !key(data.sheet) || !room(data.roomId) || !Array.isArray(data.tokens) || data.tokens.length > 2048 ||
        data.tokens.some(value => !key(value)) || performance.now() - lastRequest < 150) return;
    lastRequest = performance.now();
    const sheets = [...document.querySelectorAll('[data-testid="sheetDialog"][data-ss-relation-sheet]')]
      .filter(sheet => sheet.getAttribute("data-ss-relation-sheet") === data.sheet);
    const people = sheets.length === 1 ? read(sheets[0], data.roomId, data.tokens) : [];
    window.postMessage({ source: "spacecast:relationships:response", id: data.id, sheet: data.sheet, roomId: data.roomId, people }, location.origin);
  });
})();
