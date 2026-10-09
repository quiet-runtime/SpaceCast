const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const load = name => fs.readFileSync(path.join(__dirname, '../js', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flags = { following: false, followed_by: false, blocking: false, blocked_by: false, muting: false, follow_request_sent: false };

function setup({ deep = false, manyContexts = false } = {}) {
  const listeners = new Map();
  const window = { addEventListener(name, handler) { listeners.set(name, handler); }, postMessage() {} };
  const context = vm.createContext({ window, location: { origin: 'https://x.com' }, performance: { now: () => 0 }, document: {}, URL });
  vm.runInContext(load('RelationshipReader.js'), context);
  vm.runInContext(load('RelationshipBadges.js'), context);
  const card = { isConnected: true, getAttribute: () => 'card1', closest(selector) { return selector === '[data-testid="sheetDialog"]' ? sheet : null; } };
  const sheet = { isConnected: true, matches: () => true, closest: () => null, querySelectorAll: () => [card] };
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
  return { context, card, sheet, roster, props, user, state, native, chain, read: () => plain(context.SpaceCastRelationshipReader.read(sheet, 'room1', ['card1'])) };
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
  const sheet = { isConnected: true, dataset: {}, setAttribute() {}, addEventListener() {}, querySelectorAll: () => [] };
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
  const sheet = { isConnected: true, dataset: {}, contains: () => true, setAttribute() {}, addEventListener() {}, querySelectorAll: () => [] };
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
