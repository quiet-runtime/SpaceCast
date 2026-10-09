const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const load = name => fs.readFileSync(path.join(__dirname, '../js', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flags = { following: false, followed_by: false, blocking: false, blocked_by: false, muting: false, follow_request_sent: false };

function setup({ deep = false, manyContexts = false, loaderValue } = {}) {
  const listeners = new Map();
  const calls = [], messages = []; let update;
  const window = { innerWidth: 1024, innerHeight: 768, addEventListener(name, handler) { listeners.set(name, handler); }, postMessage(...args) { messages.push(args); } };
  const loader = { create(options) { update = options.onUpdate; return { get(input) { if (!input.isCurrent()) return null; calls.push(input); return loaderValue; } }; } };
  const context = vm.createContext({ window, location: { origin: 'https://x.com' }, performance: { now: () => 0 }, document: {}, URL,
    ...(loaderValue === undefined ? {} : { SpaceRelationshipLoader: loader }) });
  vm.runInContext(load('RelationshipReader.js'), context);
  vm.runInContext(load('RelationshipBadges.js'), context);
  const card = { isConnected: true, getAttribute: () => 'card1', getClientRects: () => [{ width: 70, height: 90, top: 0, left: 0, right: 70, bottom: 90 }], closest(selector) { return selector === '[data-testid="sheetDialog"]' ? sheet : null; } };
  const sheet = { isConnected: true, getAttribute: () => 'true', getBoundingClientRect: () => ({ top: 0, left: 0, right: 800, bottom: 600 }), matches: () => true, closest: () => null, querySelectorAll: () => [card] };
  const roster = { user_id: '123', twitter_screen_name: 'Person', periscope_user_id: 'native123' };
  const props = { audioSpaceId: 'room1', host: roster, cohosts: [], participants: { admins: [roster], speakers: [], listeners: [] } };
  const user = { id_str: '123', screen_name: 'Person', ...flags };
  const state = { entities: { users: { entities: { 123: user } } } };
  const native = { viewerUserId: '456', store: { getState: () => state } };
  let contextList = { memoizedValue: native, next: null };
  if (manyContexts) for (let n = 0; n < 31; n++) contextList = { memoizedValue: { harmless: n }, next: contextList };
  const chain = Array.from({ length: deep ? 214 : 12 }, () => ({ memoizedProps: {} }));
  for (let i = 0; i < chain.length - 1; i++) { chain[i].return = chain[i + 1]; chain[i + 1].child = chain[i]; }
  chain[0].stateNode = card;
  chain[2].memoizedProps = { screenName: 'Person' };
  chain[7].memoizedProps = props;
  chain[8].dependencies = { firstContext: contextList };
  chain.at(-1).tag = 3;
  chain.at(-1).stateNode = { current: chain.at(-1) };
  card.__reactFiber$fixture = chain[0];
  return { context, card, sheet, roster, props, user, state, native, chain, calls, messages, update: () => update?.(), read: () => plain(context.SpaceCastRelationshipReader.read(sheet, 'room1', ['card1'])) };
}

test('preview reads exact native roster identity without joined-room periscope props', () => {
  const s = setup({ deep: true, manyContexts: true });
  s.user.following = s.user.followed_by = true;
  assert.deepEqual(s.read(), [{ token: 'card1', userId: '123', screenName: 'person', self: false, following: true, followedBy: true, blocking: false, blockedBy: false, muting: false, followRequested: false }]);
});

test('host repeated in admins is deduplicated but conflicting ids are rejected', () => {
  const s = setup();
  assert.equal(s.read().length, 1);
  s.props.participants.speakers.push({ ...s.roster, user_id: '999' });
  assert.deepEqual(s.read(), []);
});

test('wrong room and mismatched card screen name cannot borrow another roster entry', () => {
  const s = setup();
  s.props.audioSpaceId = 'room2'; assert.deepEqual(s.read(), []);
  s.props.audioSpaceId = 'room1'; s.chain[2].memoizedProps.screenName = 'other'; assert.deepEqual(s.read(), []);
});

test('unknown cache records or missing viewer never become negative relationship facts', () => {
  for (const alter of [s => delete s.state.entities.users.entities['123'], s => delete s.native.viewerUserId,
    s => { s.user.id_str = '999'; }, s => { s.user.screen_name = 'other'; }]) {
    const s = setup(); alter(s);
    const result = s.read()[0];
    for (const key of ['following', 'followedBy', 'blocking', 'blockedBy', 'muting', 'followRequested']) assert.equal(result[key], null);
    assert.equal(s.context.SpaceCastRelationships.describe(result).kind, 'unknown');
  }
});

test('only literal booleans are evidence, and field getters are not invoked', () => {
  const s = setup(); let reads = 0;
  s.user.followed_by = 'true';
  Object.defineProperty(s.user, 'following', { get() { reads++; return true; } });
  const result = s.read()[0];
  assert.equal(reads, 0); assert.equal(result.following, null); assert.equal(result.followedBy, null);
});

test('viewer account displays You and viewer conflicts discard all relationship flags', () => {
  const s = setup(); s.native.viewerUserId = '123';
  assert.equal(s.context.SpaceCastRelationships.describe(s.read()[0]).kind, 'self');
  s.chain[9].dependencies = { firstContext: { memoizedValue: { viewerUserId: '999' } } };
  assert.equal(s.context.SpaceCastRelationships.describe(s.read()[0]).kind, 'unknown');
});

test('current alternate wins over stale React state and supports shared bailout returns', () => {
  const s = setup();
  const stale = s.chain.map(fiber => ({ ...fiber }));
  for (let i = 0; i < stale.length; i++) {
    stale[i].alternate = s.chain[i]; s.chain[i].alternate = stale[i];
    stale[i].return = stale[i + 1] || null; stale[i].child = stale[i - 1] || null;
  }
  stale[2].memoizedProps = { screenName: 'unrelated' };
  stale.at(-1).stateNode = s.chain.at(-1).stateNode;
  s.card.__reactFiber$fixture = stale[0];
  assert.equal(s.read()[0].screenName, 'person');
  s.chain[1].return = stale[2];
  assert.equal(s.read()[0].screenName, 'person');
});

test('native teardown, cycles and duplicate card tokens fail safely', () => {
  const s = setup();
  s.sheet.isConnected = false; assert.deepEqual(s.read(), []); s.sheet.isConnected = true;
  s.sheet.querySelectorAll = () => [s.card, s.card]; assert.deepEqual(s.read(), []);
  s.sheet.querySelectorAll = () => [s.card]; s.chain[4].return = s.chain[3]; assert.deepEqual(s.read(), []);
});

test('labels are explicit and No follow requires fully known negative flags', () => {
  const s = setup(); const base = s.read()[0], describe = s.context.SpaceCastRelationships.describe;
  assert.equal(describe(base).text, 'No follow');
  assert.equal(describe({ ...base, followedBy: null }).text, 'Unknown');
  for (const [patch, kind] of [[{ following: true, followedBy: true }, 'mutual'], [{ following: true }, 'following'],
    [{ followedBy: true }, 'follower'], [{ blocking: true }, 'blocked'], [{ blockedBy: true }, 'blockedBy'],
    [{ muting: true }, 'muted'], [{ followRequested: true }, 'requested']]) assert.equal(describe({ ...base, ...patch }).kind, kind);
  assert.match(describe({ ...base, blocking: true, following: true }).title, /blocked.*follow/);
});

test('appearance relationship toggle defaults on and rejects nonboolean false', () => {
  const context = vm.createContext({}); vm.runInContext(load('AppearanceSettings.js'), context);
  for (const value of [undefined, null, 'false', 0]) assert.equal(context.SpaceCastAppearance.normalize({ relationshipBadges: value }).relationshipBadges, true);
  assert.equal(context.SpaceCastAppearance.normalize({ relationshipBadges: false }).relationshipBadges, false);
});

test('missing relationship fields preload via the exact native viewer, store, and visible roster identity', () => {
  const loaded = { userId: '123', screenName: 'person', following: true, followedBy: true, blocking: false, blockedBy: false, muting: false, followRequested: false };
  const s = setup({ loaderValue: loaded });
  delete s.state.entities.users.entities['123'];
  assert.equal(s.context.SpaceCastRelationships.describe(s.read()[0]).kind, 'mutual');
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].store, s.native.store);
  assert.equal(s.calls[0].viewer, '456');
  assert.equal(s.calls[0].id, '123');
  assert.equal(s.calls[0].handle, 'person');
  assert.equal(s.calls[0].isCurrent(), true);
  s.update();
  assert.deepEqual(plain(s.messages), [[{ source: 'spacecast:relationships:updated' }, 'https://x.com']]);
});

test('loaded native cache flags take precedence and complete cache records need no preload', () => {
  const s = setup({ loaderValue: { userId: '123', screenName: 'person', following: true, followedBy: true, blocking: true } });
  s.read(); assert.equal(s.calls.length, 0);
  delete s.user.followed_by;
  const result = s.read()[0];
  assert.equal(result.following, false); assert.equal(result.followedBy, true); assert.equal(result.blocking, false);
  assert.equal(s.calls.length, 1);
});

test('malformed native cache flags remain unknown instead of being replaced by a lookup result', () => {
  const s = setup({ loaderValue: { userId: '123', screenName: 'person', following: true, followedBy: true } });
  s.user.following = 'true'; delete s.user.followed_by;
  const result = s.read()[0];
  assert.equal(result.following, null); assert.equal(result.followedBy, true);
  s.user.followed_by = false; s.calls.length = 0;
  s.read(); assert.equal(s.calls.length, 0);
});

test('preload guard rejects recycled, closed, hidden, changed-room and changed-viewer participants', () => {
  for (const alter of [s => s.card.isConnected = false, s => s.sheet.isConnected = false,
    s => s.card.getAttribute = () => 'replacement', s => s.card.getClientRects = () => [],
    s => s.props.audioSpaceId = 'room2', s => s.chain[2].memoizedProps.screenName = 'replacement',
    s => s.native.viewerUserId = '789', s => s.native.store = { getState: () => s.state },
    s => s.context.document.hidden = true, s => s.sheet.getAttribute = () => 'false',
    s => s.card.getClientRects = () => [{ width: 70, height: 90, top: 900, bottom: 990, left: 0, right: 70 }]]) {
    const s = setup({ loaderValue: null }); delete s.user.following;
    s.read(); assert.equal(s.calls.length, 1);
    alter(s); assert.equal(s.calls[0].isCurrent(), false);
  }
});

test('unknown viewer, conflicting native identities, own account, and hidden cards never enqueue lookups', () => {
  for (const alter of [s => delete s.native.viewerUserId, s => s.user.id_str = '999',
    s => s.native.viewerUserId = '123', s => s.card.getClientRects = () => [], s => s.context.document.hidden = true,
    s => s.chain[9].dependencies = { firstContext: { memoizedValue: { store: { getState: () => s.state } } } },
    s => s.native.store.getState = () => { throw new Error('native store unavailable'); }]) {
    const s = setup({ loaderValue: null }); delete s.user.following;
    alter(s); s.read(); assert.equal(s.calls.length, 0);
  }
});

test('native preload notifications promptly replace the slow poll without overlapping pending reads', () => {
  class Observer { observe() {} disconnect() {} unobserve() {} }
  const scheduled = [], cleared = [];
  const window = { addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({
    crypto: { randomUUID: () => 'fixture' }, URL, performance: { now: () => 100 }, window,
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    IntersectionObserver: Observer, MutationObserver: Observer,
    setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, clearTimeout: id => cleared.push(id),
    location: { origin: 'https://x.com' },
  });
  vm.runInContext(load('RelationshipBadges.js'), context);
  const sheet = { isConnected: true, dataset: {}, getAttribute: () => null, setAttribute() {}, addEventListener() {}, querySelectorAll: () => [] };
  const controller = context.SpaceCastRelationships.create(sheet, 'room1');
  controller.entries.set({}, { token: 'card1' }); controller.lastRead = 0;
  controller.queue(); assert.equal(scheduled.at(-1).delay, 1400);
  controller.receive({ source: window, origin: 'https://x.com', data: { source: 'spacecast:relationships:updated' } });
  assert.equal(scheduled.at(-1).delay, 80); assert.deepEqual(cleared, [1]);
  controller.pending = { id: 'request' }; controller.timer = null;
  controller.receive({ source: window, origin: 'https://x.com', data: { source: 'spacecast:relationships:updated' } });
  assert.equal(scheduled.length, 2); assert.equal(controller.urgent, true);
  controller.pending = null; controller.queue();
  assert.equal(scheduled.at(-1).delay, 80);
  controller.receive({ source: window, origin: 'https://unrelated.invalid', data: { source: 'spacecast:relationships:updated' } });
  assert.equal(scheduled.length, 3);
});

function pendingAppearance() {
  class Observer { observe() {} disconnect() {} unobserve() {} }
  const timers = [], messages = [], attributes = new Map();
  let resolveSettings, rejectSettings;
  const context = vm.createContext({
    crypto: { randomUUID: () => 'fixture' }, URL, performance: { now: () => 0 },
    window: { addEventListener() {}, removeEventListener() {}, postMessage: message => messages.push(message) },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    IntersectionObserver: Observer, MutationObserver: Observer,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {},
    location: { origin: 'https://x.com' },
    SpaceCastAppearance: { load: () => new Promise((resolve, reject) => { resolveSettings = resolve; rejectSettings = reject; }), subscribe: () => () => {} },
  });
  vm.runInContext(load('RelationshipBadges.js'), context);
  const sheet = { isConnected: true, dataset: {}, getAttribute: name => attributes.get(name), setAttribute: (name, value) => attributes.set(name, value), addEventListener() {}, querySelectorAll: () => [] };
  const controller = context.SpaceCastRelationships.create(sheet, 'room1');
  controller.entries.set({}, { token: 'card1', handle: 'person', visible: true });
  controller.valid = () => true; controller.render = () => {};
  return { controller, sheet, timers, messages, resolve: resolveSettings, reject: rejectSettings };
}

test('persisted disabled badges never queue a request before or after initial settings load', async () => {
  const s = pendingAppearance();
  assert.equal(s.controller.enabled, false);
  assert.equal(s.sheet.getAttribute('data-ss-relation-enabled'), 'false');
  s.controller.queue(true); await s.controller.read();
  assert.equal(s.timers.length, 0); assert.equal(s.messages.length, 0);
  s.resolve({ relationshipBadges: false }); await new Promise(resolve => setImmediate(resolve));
  s.controller.queue(true); await s.controller.read();
  assert.equal(s.controller.enabled, false);
  assert.equal(s.timers.length, 0); assert.equal(s.messages.length, 0);
});

test('a settings change during initial load wins over that older settings result', async () => {
  for (const enabled of [true, false]) {
    const s = pendingAppearance();
    s.controller.configure(enabled);
    s.resolve({ relationshipBadges: !enabled }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.controller.enabled, enabled);
    assert.equal(s.sheet.getAttribute('data-ss-relation-enabled'), String(enabled));
    if (!enabled) assert.equal(s.timers.length, 0);
  }
});

test('unavailable initial settings fall back to defaults without defeating a newer opt-out', async () => {
  for (const optedOut of [true, false]) {
    const s = pendingAppearance();
    if (optedOut) s.controller.configure(false);
    s.reject(new Error('Storage unavailable')); await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.controller.enabled, !optedOut);
  }
});

test('a response from before disable and re-enable cannot repaint an old relationship', async () => {
  class Observer { observe() {} disconnect() {} unobserve() {} }
  const context = vm.createContext({
    crypto: { randomUUID: () => 'fixture' }, URL, performance: { now: () => 10 },
    window: { addEventListener() {}, removeEventListener() {} },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    IntersectionObserver: Observer, MutationObserver: Observer,
    setTimeout: () => 1, clearTimeout() {}, location: { origin: 'https://x.com' },
  });
  vm.runInContext(load('RelationshipBadges.js'), context);
  const sheet = { isConnected: true, dataset: {}, getAttribute: () => null, setAttribute() {}, addEventListener() {}, querySelectorAll: () => [] };
  const controller = context.SpaceCastRelationships.create(sheet, 'room1');
  const entry = { token: 'card1', handle: 'person', visible: true };
  controller.entries.set({}, entry);
  controller.valid = () => true;
  controller.refresh = controller.queue = () => {};
  const rendered = [];
  controller.render = (...args) => rendered.push(args);
  let deliver;
  controller.request = () => new Promise(resolve => { deliver = resolve; });
  const reading = controller.read();
  controller.configure(false); controller.configure(true);
  deliver({ people: [{ token: 'card1', userId: '123', screenName: 'person', self: false,
    following: true, followedBy: true, blocking: false, blockedBy: false, muting: false, followRequested: false }] });
  await reading;
  assert.equal(rendered.length, 0);
});

test('pending data for a removed and re-registered same-handle card cannot append a duplicate badge', async () => {
  class Observer { observe() {} disconnect() {} unobserve() {} }
  const context = vm.createContext({
    crypto: { randomUUID: () => 'fixture' }, URL, performance: { now: () => 10 },
    window: { addEventListener() {}, removeEventListener() {} },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    IntersectionObserver: Observer, MutationObserver: Observer,
    setTimeout: () => 1, clearTimeout() {}, location: { origin: 'https://x.com' },
  });
  vm.runInContext(load('RelationshipBadges.js'), context);
  const sheet = { isConnected: true, dataset: {}, contains: () => true, getAttribute: () => null, setAttribute() {}, addEventListener() {}, querySelectorAll: () => [] };
  const controller = context.SpaceCastRelationships.create(sheet, 'room1');
  let token = 'old';
  const card = { getAttribute: () => token, classList: { contains: () => true }, querySelectorAll: () => [{ getAttribute: () => '/person' }] };
  const old = { token, handle: 'person', visible: true };
  controller.entries.set(card, old);
  controller.refresh = controller.queue = () => {};
  const rendered = [];
  controller.render = (...args) => rendered.push(args);
  let deliver;
  controller.request = () => new Promise(resolve => { deliver = resolve; });
  const reading = controller.read();
  token = 'new'; controller.entries.set(card, { token, handle: 'person', visible: true });
  deliver({ people: [{ token: 'old', userId: '123', screenName: 'person', self: false,
    following: true, followedBy: true, blocking: false, blockedBy: false, muting: false, followRequested: false }] });
  await reading;
  assert.equal(rendered.length, 0);
});
