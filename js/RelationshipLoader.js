/* Load only the visible room's missing relationships through X's native client. */
(() => {
  'use strict';
  if (globalThis.SpaceRelationshipLoader) return;
  const FIELDS = Object.freeze({ following: 'following', followedBy: 'followed_by', blocking: 'blocking', blockedBy: 'blocked_by', muting: 'muting' });
  const OPERATION = Object.freeze({
    queryId: 'ubfbnAM4qTlMTOYleYhXSg', operationName: 'UsersByRestIds', operationType: 'query',
    metadata: Object.freeze({ featureSwitches: Object.freeze([
      'profile_label_improvements_pcf_label_in_post_enabled', 'responsive_web_profile_redirect_enabled',
      'rweb_tipjar_consumption_enabled', 'verified_phone_label_enabled', 'responsive_web_graphql_timeline_navigation_enabled',
    ]), fieldToggles: Object.freeze(['withPayments', 'withDmBlocks', 'withAuxiliaryUserLabels']) }),
  });
  const CAPACITY = 512, BATCH = 20, TTL = 60_000, MISSING_RETRY = 30_000, ERROR_RETRY = 15_000, RATE_RETRY = 60_000;
  const idOf = value => typeof value === 'string' && /^\d{1,32}$/.test(value) ? value : null;
  const handleOf = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(value) ? value.toLowerCase() : null;
  const own = (object, key) => object && (typeof object === 'object' || typeof object === 'function')
    ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
  const bool = value => typeof value === 'boolean' ? value : null;

  function normalize(user, expected) {
    if (own(user, '__typename') !== 'User' || idOf(own(user, 'rest_id')) !== expected.id
      || handleOf(own(own(user, 'core'), 'screen_name')) !== expected.handle) return null;
    const perspectives = own(user, 'relationship_perspectives');
    const value = { userId: expected.id, screenName: expected.handle };
    for (const [field, nativeField] of Object.entries(FIELDS)) value[field] = bool(own(perspectives, nativeField));
    const top = bool(own(user, 'follow_request_sent')), nested = bool(own(perspectives, 'follow_request_sent'));
    value.followRequested = top !== null && nested !== null && top !== nested ? null : top ?? nested;
    return Object.freeze(value);
  }

  function retryDelay(error) {
    try {
      const statuses = [error?.status, error?.statusCode, error?.httpStatus, error?.response?.status];
      const errors = [error?.code, ...(Array.isArray(error?.errors) ? error.errors.map(item => item?.code) : [])];
      return statuses.includes(429) || errors.includes(88) || errors.includes(429) ? RATE_RETRY : ERROR_RETRY;
    } catch (_) { return ERROR_RETRY; }
  }

  function create({ onUpdate } = {}) {
    const cache = new Map(), pending = new Map(), stores = new WeakMap();
    let storeNumber = 0, timer = null, inFlight = false, blockedUntil = 0, epoch = 0, disposed = false;
    const current = item => {
      try { return !disposed && !globalThis.document?.hidden && item.isCurrent() === true; }
      catch (_) { return false; }
    };
    const put = (key, value, expires) => {
      cache.delete(key); cache.set(key, { value, expires });
      while (cache.size > CAPACITY) cache.delete(cache.keys().next().value);
    };
    const schedule = (delay = 0) => {
      if (disposed || inFlight || timer !== null || !pending.size) return;
      timer = setTimeout(() => { timer = null; void flush(); }, delay);
    };

    async function flush() {
      if (disposed || inFlight || globalThis.document?.hidden) return;
      const wait = blockedUntil - Date.now();
      if (wait > 0) { schedule(wait); return; }
      const selected = [];
      for (const [key, item] of pending) {
        if (!current(item)) { pending.delete(key); continue; }
        if (!selected.length || (item.store === selected[0].store && item.viewer === selected[0].viewer)) selected.push(item);
        if (selected.length >= BATCH) break;
      }
      if (!selected.length) return;
      // Conflicting names for one account are not a safe request identity.
      const handles = new Map(), conflicts = new Set();
      for (const item of pending.values()) {
        if (item.store !== selected[0].store || item.viewer !== selected[0].viewer) continue;
        if (handles.has(item.id) && handles.get(item.id) !== item.handle) conflicts.add(item.id);
        handles.set(item.id, item.handle);
      }
      const batch = selected.filter(item => !conflicts.has(item.id));
      for (const item of pending.values()) if (item.store === selected[0].store && item.viewer === selected[0].viewer && conflicts.has(item.id)) {
        pending.delete(item.key); put(item.key, null, Date.now() + MISSING_RETRY);
      }
      if (!batch.length) { schedule(); return; }
      const requestEpoch = epoch;
      inFlight = true;
      let notify = false;
      try {
        const { store } = batch[0];
        // Redux supplies its own authenticated client. No native state is written.
        const response = await store.dispatch((_dispatch, _getState, extra) => {
          if (epoch !== requestEpoch || !batch.every(current)) return null;
          const api = extra?.api;
          if (typeof api?.withEndpoint !== 'function') return null;
          return api.withEndpoint(({ apiClient } = {}) => {
            if (typeof apiClient?.graphQL !== 'function' || epoch !== requestEpoch || !batch.every(current)) return null;
            return apiClient.graphQL(OPERATION, { userIds: [...new Set(batch.map(item => item.id))] }, undefined, { timeout: 15_000 });
          });
        });
        if (epoch !== requestEpoch || disposed) return;
        const users = own(response, 'users'), byId = new Map(), duplicates = new Set();
        if (Array.isArray(users) && users.length <= 100) for (const entry of users) {
          const user = own(entry, 'result'), id = idOf(own(user, 'rest_id'));
          if (!id) continue;
          if (byId.has(id)) duplicates.add(id);
          byId.set(id, user);
        }
        for (const item of batch) {
          if (!current(item)) continue;
          const value = duplicates.has(item.id) ? null : normalize(byId.get(item.id), item);
          const complete = value && Object.keys(FIELDS).every(field => value[field] !== null) && value.followRequested !== null;
          put(item.key, value, Date.now() + (complete ? TTL : MISSING_RETRY));
          notify = true;
        }
      } catch (error) {
        if (epoch === requestEpoch && !disposed) {
          const retry = retryDelay(error); blockedUntil = Date.now() + retry;
          for (const item of batch) if (current(item)) put(item.key, null, blockedUntil);
        }
      } finally {
        for (const item of batch) if (pending.get(item.key) === item) pending.delete(item.key);
        inFlight = false;
        if (notify && !disposed && epoch === requestEpoch) {
          try { onUpdate?.(); } catch (_) { /* A renderer cannot break the queue. */ }
        }
        schedule(Math.max(0, blockedUntil - Date.now()));
      }
    }

    function get({ store, viewer, id, handle, isCurrent } = {}) {
      try {
        viewer = idOf(viewer); id = idOf(id); handle = handleOf(handle);
        if (!store || typeof store.dispatch !== 'function' || !viewer || !id || viewer === id || !handle
          || typeof isCurrent !== 'function' || !current({ isCurrent })) return null;
        if (!stores.has(store)) stores.set(store, ++storeNumber);
        const key = `${stores.get(store)}:${viewer}:${id}:${handle}`, cached = cache.get(key);
        if (cached && cached.expires > Date.now()) {
          cache.delete(key); cache.set(key, cached); return cached.value;
        }
        cache.delete(key);
        if (!pending.has(key) && pending.size < CAPACITY) pending.set(key, { key, store, viewer, id, handle, isCurrent });
        schedule(Math.max(0, blockedUntil - Date.now()));
      } catch (_) { /* Unsupported native context stays unknown. */ }
      return null;
    }

    function clear() {
      epoch++; cache.clear(); pending.clear(); blockedUntil = 0;
      if (timer !== null) { clearTimeout(timer); timer = null; }
    }
    function dispose() { disposed = true; clear(); }
    return Object.freeze({ get, clear, dispose });
  }
  globalThis.SpaceRelationshipLoader = Object.freeze({ create });
})();
