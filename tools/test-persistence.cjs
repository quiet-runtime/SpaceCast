const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/SpaceCast.js'), 'utf8');
const navigation = source.slice(source.indexOf('function requestSpaceClose('), source.indexOf('new MutationObserver(() => {', source.indexOf('function reconcileSpace()')));

function setup({ connected = false, route = '/explore', paused = false, docked = false, nativeActive = false, openedDuringNative = false } = {}) {
  const calls = { pause: 0, dock: 0, native: 0, release: 0, close: 0, opened: [], resumed: [], refresh: 0 };
  const sheet = { isConnected: connected, style: { left: '45px', top: '75px' }, dataset: { minimized: 'false' } };
  const panel = {
    space: { id: 'spaceOne', title: 'Original Space' }, element: { isConnected: connected, style: {} },
    audio: { muted: false, pause() { calls.pause++; } },
    nativeSheet: sheet, spaceSnapshot: { title: 'Original Space', people: [] }, nativeDismissal: false,
    wantsPlayback() { return !paused; }, resumeAfterMove(value) { calls.resumed.push(value); },
    releaseShell() { calls.release++; this.nativeSheet = null; this.dock = null; },
    refreshShell() { calls.refresh++; }, requestClose(callback) { if (!this.pendingClose) this.pendingClose = callback; },
    dispose() {},
  };
  const engine = { hls: {}, cache: {} };
  const session = { space: panel.space, panel, controller: new AbortController(), openedDuringNative, ...engine };
  if (docked) panel.dock = { root: { style: {} }, refresh() { panel.element.isConnected = true; } };
  const location = { pathname: route, search: '' };
  let native = null;
  const context = vm.createContext({
    URLSearchParams, AbortController, location, clearTimeout() {}, queueMicrotask() {}, console: { warn() {} },
    document: { addEventListener() {} }, nativeListeningActive() { return nativeActive; },
    SpaceDock: { snapshot(_sheet, _space, prior) { return prior; } },
    nativeSpaceSheet() { return native; },
    mountSpaceDock(target, options) { calls.dock++; calls.dockOptions = options; target.element.isConnected = true; target.dock = { refresh() { target.element.isConnected = true; } }; },
    mountPanel(target) { calls.native++; target.nativeSheet = native; target.element.isConnected = true; return true; },
    closeSpaceSession() { calls.close++; context.api.setSession(null); },
    createPanel(space) { return { space, element: { isConnected: false }, dispose() {}, refreshShell() {}, setPlaybackNotice(message) { this.playbackNotice = message; } }; },
    openSpaceSession(value) { calls.opened.push(value.space.id); },
  });
  vm.runInContext('let spaceSession; let dismissedSpacePath="";let nativeOwnedSpaceId="";let nativeOwnedSpacePath="";let nativeOwnedWasActive=false;let nativeLeavePending=false;\n' + navigation + '\nglobalThis.api={reconcileSpace,requestSpaceClose,setSession(v){spaceSession=v},getSession(){return spaceSession}};', context);
  context.api.setSession(session);
  return { context, calls, panel, sheet, session, engine, location, native(value) { native = value; } };
}

test('native unmount on Explore preserves the same engines and reuses its outer capture target', () => {
  const state = setup();
  state.context.api.reconcileSpace();
  assert.equal(state.context.api.getSession(), state.session);
  assert.equal(state.context.api.getSession().cache, state.engine.cache);
  assert.equal(state.context.api.getSession().hls, state.engine.hls);
  assert.equal(state.calls.dockOptions.root, state.sheet);
  assert.equal(state.panel.pendingClose, undefined);
  assert.equal(state.calls.close, 0);
  assert.deepEqual(state.calls.resumed, [true]);
});

test('background navigation leaves a still-mounted native popup untouched', () => {
  const state = setup({ connected: true });
  state.context.api.reconcileSpace();
  assert.equal(state.calls.release, 0);
  assert.equal(state.calls.dock, 0);
  assert.equal(state.calls.close, 0);
});

test('returning to the same Space mounts the same player without fetching metadata again', () => {
  const state = setup({ docked: true, connected: true, route: '/i/spaces/spaceOne/peek' });
  const fresh = { isConnected: true };
  state.native(fresh);
  state.context.api.reconcileSpace();
  state.context.api.reconcileSpace();
  assert.equal(state.calls.native, 1);
  assert.equal(state.context.api.getSession(), state.session);
  assert.equal(state.panel.nativeSheet, fresh);
  assert.deepEqual(state.calls.opened, []);
});

test('another Space waits for the old save before opening a new session', () => {
  const state = setup({ connected: true, route: '/i/spaces/spaceTwo/peek' });
  state.native({ isConnected: true });
  state.context.api.reconcileSpace();
  assert.equal(state.calls.dock, 0);
  assert.equal(state.panel.element.style.display, 'none');
  assert.equal(state.calls.pause, 1);
  assert.equal(state.calls.close, 0);
  assert.deepEqual(state.calls.opened, []);
  state.panel.pendingClose();
  assert.equal(state.calls.close, 1);
  assert.deepEqual(state.calls.opened, ['spaceTwo']);
});

test('user-paused playback stays paused during migration', () => {
  const state = setup({ paused: true });
  state.context.api.reconcileSpace();
  assert.deepEqual(state.calls.resumed, [false]);
});

test('a removed owned dock is reattached rather than rebuilding the session', () => {
  const state = setup({ docked: true });
  const dock = state.panel.dock;
  state.context.api.reconcileSpace();
  assert.equal(state.panel.dock, dock);
  assert.equal(state.panel.element.isConnected, true);
  assert.equal(state.calls.dock, 0);
  assert.equal(state.calls.release, 0);
});

test('Escape unmount requests a safe save without constructing a second window', () => {
  const state = setup();
  state.panel.nativeDismissal = true;
  state.context.api.reconcileSpace();
  assert.equal(state.calls.dock, 0);
  assert.equal(state.calls.pause, 1);
  assert.equal(typeof state.panel.pendingClose, 'function');
  assert.equal(state.calls.close, 0);
  state.panel.pendingClose();
  assert.equal(state.calls.close, 1);
});

test('native-controls handoff route never starts a second extension session', () => {
  const state = setup({ route: '/i/spaces/spaceOne/peek' });
  state.context.api.setSession(null);
  state.location.search = '?spacecast=native';
  state.native({ isConnected: true });
  state.context.api.reconcileSpace();
  assert.deepEqual(state.calls.opened, []);
  assert.equal(state.calls.native, 0);
});

test('entering the native full route pauses immediately and never creates a background dock', () => {
  const state = setup({ connected: false, route: '/i/spaces/spaceOne' });
  state.context.api.reconcileSpace();
  assert.equal(state.session.closing, true);
  assert.equal(state.panel.audio.muted, true);
  assert.equal(state.calls.pause, 1);
  assert.equal(state.calls.dock, 0);
  state.context.api.reconcileSpace();
  assert.equal(state.calls.pause, 1);
  state.panel.pendingClose();
  state.context.api.reconcileSpace();
  assert.equal(state.calls.close, 1);
  assert.deepEqual(state.calls.opened, []);
});

test('native join stays terminal across a background route and Manage Space reopening', () => {
  const state = setup({ connected: true, route: '/i/spaces/spaceOne/peek' });
  state.context.api.requestSpaceClose(state.session, { native: true, hide: true });
  state.location.pathname = '/someone/status/article';
  state.context.api.reconcileSpace();
  assert.equal(state.calls.dock, 0);
  assert.equal(state.calls.pause, 1);
  state.panel.pendingClose();
  state.location.pathname = '/i/spaces/spaceOne/peek';
  state.native({ isConnected: true });
  state.context.api.reconcileSpace();
  assert.deepEqual(state.calls.opened, []);
});

test('native Close suppresses late mutations on the unchanged preview route', () => {
  const state = setup({ connected: true, route: '/i/spaces/spaceOne/peek' });
  state.context.api.requestSpaceClose(state.session);
  state.context.api.reconcileSpace();
  state.panel.pendingClose();
  state.native({ isConnected: true });
  state.context.api.reconcileSpace();
  assert.equal(state.calls.close, 1);
  assert.deepEqual(state.calls.opened, []);
});

test('fresh full native routes never start extension audio', () => {
  const state = setup({ route: '/i/spaces/spaceOne' });
  state.context.api.setSession(null);
  state.native({ isConnected: true });
  state.context.api.reconcileSpace();
  assert.deepEqual(state.calls.opened, []);
  assert.equal(state.calls.dock, 0);
});

test('native listening indicator hands off even while the page stays on a background route', () => {
  const state = setup({ connected: true });
  state.context.nativeListeningActive = () => true;
  state.context.api.reconcileSpace();
  assert.equal(state.session.closing, true);
  assert.equal(state.calls.pause, 1);
  assert.equal(state.calls.dock, 0);
});

test('dock native-control navigation waits for recording finalization', () => {
  const state = setup({ docked: true, connected: true });
  let navigated = false;
  state.context.api.requestSpaceClose(state.session, { native: true, onClosed() { navigated = true; } });
  assert.equal(navigated, false);
  assert.equal(state.calls.pause, 1);
  state.context.api.reconcileSpace();
  state.panel.pendingClose();
  assert.equal(navigated, true);
  assert.equal(state.calls.close, 1);
});

test('native automatic end allows a later same-Space preview without autoplay in the current one', () => {
  const state = setup({ connected: true, route: '/i/spaces/spaceOne/peek' });
  state.native({ isConnected: true });
  state.context.api.requestSpaceClose(state.session, { native: true, hide: true });
  state.panel.pendingClose();
  state.context.nativeListeningActive = () => true;
  state.context.api.reconcileSpace();
  state.context.nativeListeningActive = () => false;
  state.context.api.reconcileSpace();
  assert.deepEqual(state.calls.opened, []);
  state.location.pathname = '/home';
  state.context.api.reconcileSpace();
  state.location.pathname = '/i/spaces/spaceOne/peek';
  state.context.api.reconcileSpace();
  assert.deepEqual(state.calls.opened, ['spaceOne']);
});

test('failed native Join releases ownership when navigating away and reopening the same Space', () => {
  const state = setup({ connected: true, route: '/i/spaces/spaceOne/peek' });
  state.context.api.requestSpaceClose(state.session, { native: true, hide: true });
  state.panel.pendingClose();
  state.context.api.reconcileSpace();
  assert.deepEqual(state.calls.opened, []);
  state.location.pathname = '/home';
  state.context.api.reconcileSpace();
  state.location.pathname = '/i/spaces/spaceOne/peek';
  state.native({ isConnected: true });
  state.context.api.reconcileSpace();
  assert.deepEqual(state.calls.opened, ['spaceOne']);
});

test('active native listening stays exclusive while navigating and reopening Manage Space', () => {
  const state = setup({ connected: true, route: '/i/spaces/spaceOne/peek' });
  state.context.api.requestSpaceClose(state.session, { native: true, hide: true });
  state.panel.pendingClose();
  state.context.nativeListeningActive = () => true;
  for (const route of ['/home', '/explore', '/i/spaces/spaceOne/peek']) {
    state.location.pathname = route;
    state.native({ isConnected: true });
    state.context.api.reconcileSpace();
  }
  assert.deepEqual(state.calls.opened, []);
  assert.equal(state.calls.dock, 0);
});

test('existing native listening allows a new preview with autoplay disabled', () => {
  const state = setup({ route: '/i/spaces/spaceTwo/peek', nativeActive: true });
  state.context.api.setSession(null);
  state.native({ isConnected: true });
  state.context.api.reconcileSpace();
  const session = state.context.api.getSession();
  assert.equal(session.space.id, 'spaceTwo');
  assert.equal(session.autoplay, false);
  assert.equal(session.openedDuringNative, true);
  assert.deepEqual(state.calls.opened, ['spaceTwo']);
  state.context.api.reconcileSpace();
  assert.equal(state.context.api.getSession(), session);
  assert.equal(state.calls.close, 0);
});

test('native handoff for one Space does not blacklist a different preview', () => {
  const state = setup({ connected: true, route: '/i/spaces/spaceOne/peek' });
  state.context.api.requestSpaceClose(state.session, { native: true, hide: true });
  state.panel.pendingClose();
  state.context.nativeListeningActive = () => true;
  state.location.pathname = '/i/spaces/spaceTwo/peek';
  state.native({ isConnected: true });
  state.context.api.reconcileSpace();
  const preview = state.context.api.getSession();
  assert.equal(preview.space.id, 'spaceTwo');
  assert.equal(preview.autoplay, false);
  assert.equal(preview.openedDuringNative, true);
  state.context.api.reconcileSpace();
  assert.equal(state.context.api.getSession(), preview);
  assert.equal(state.calls.close, 1);
});

test('temporary removal of the native listening indicator preserves an already-paused preview', () => {
  const state = setup({ connected: true, paused: true, nativeActive: true, openedDuringNative: true, route: '/i/spaces/spaceOne/peek' });
  state.native(state.sheet);
  for (const active of [true, false, true]) {
    state.context.nativeListeningActive = () => active;
    state.context.api.reconcileSpace();
    assert.equal(state.context.api.getSession(), state.session);
    assert.equal(state.session.openedDuringNative, true);
  }
  assert.equal(state.calls.close, 0);
  assert.equal(state.calls.pause, 0);
  assert.deepEqual(state.calls.opened, []);
});

const sheetSelectorSource = source.slice(source.indexOf('function nativeSpaceSheet()'), source.indexOf('function nativeListeningActive()'));
test('unrelated sheets are ignored while a delayed-participant Space preview is recognized', () => {
  const generic = { classList: { contains: () => false }, querySelector: () => null };
  const preview = { classList: { contains: () => false }, querySelector: selector => selector.includes('tweetText') || selector.includes('Start listening') ? {} : null };
  const sheets = [generic, preview];
  const context = vm.createContext({ document: { querySelectorAll: () => sheets } });
  vm.runInContext(sheetSelectorSource + '\nglobalThis.pick = nativeSpaceSheet;', context);
  assert.equal(context.pick(), preview);
  sheets.pop();
  assert.equal(context.pick(), null);
});

const dockContext = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/SpaceDock.js'), 'utf8') + '\nglobalThis.SpaceDock=SpaceDock;', dockContext);
test('owned profile links only accept HTTPS X profiles, never executable or foreign URLs', () => {
  const parse = value => dockContext.SpaceDock.profileUrl(value);
  assert.equal(parse('/someone_1'), 'https://x.com/someone_1');
  assert.equal(parse('https://twitter.com/someone'), 'https://x.com/someone');
  for (const invalid of ['javascript:alert(1)', 'https://outside.example/someone', '//outside.example/a', '/i/spaces/x', 'data:text/html,test']) assert.equal(parse(invalid), '');
});

const retargetSource = source.slice(source.indexOf('  function refreshCaptureTarget()'), source.indexOf('  // One timer,', source.indexOf('  function refreshCaptureTarget()')));
function captureSetup({ framing = 'element (copied)', fail = false, same = false } = {}) {
  const old = { style: { isolation: 'isolate' } };
  const target = same ? old : { style: { isolation: '' } };
  const calls = [];
  const track = {
    async restrictTo(token) { calls.push(['restrict', token]); if (fail) throw new Error('frame unavailable'); },
    async cropTo(token) { calls.push(['crop', token]); if (fail) throw new Error('frame unavailable'); },
  };
  const video = { stream: { getVideoTracks: () => [track] }, state: 'recording', framing,
    restrictedTarget: old, isolated: { element: old, previous: '' }, stopped: 0,
    stop() { this.stopped++; this.state = 'saving'; } };
  const context = vm.createContext({
    video, old, panel: { closest: () => target },
    RestrictionTarget: { fromElement: async element => ({ element }) },
    CropTarget: { fromElement: async element => ({ element }) }, render() {},
  });
  vm.runInContext('let disposed=false, captureMove=null, videoCaptureTarget=old, captureMoveError="";\n' + retargetSource + '\nglobalThis.api={refreshCaptureTarget,error(){return captureMoveError},async settle(){await captureMove;}};', context);
  return { context, video, old, target, calls };
}

test('active element capture moves to the new Space target without stopping or broadening', async () => {
  const state = captureSetup();
  state.context.api.refreshCaptureTarget();
  await state.context.api.settle();
  assert.equal(state.video.restrictedTarget, state.target);
  assert.equal(state.video.stopped, 0);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0][1].element, state.target);
  assert.equal(state.old.style.isolation, '');
});

test('active capture reusing the detached native outer needs no reframe', async () => {
  const state = captureSetup({ same: true });
  state.context.api.refreshCaptureTarget();
  await state.context.api.settle();
  assert.equal(state.calls.length, 0);
  assert.equal(state.video.stopped, 0);
});

test('failed capture migration saves video explicitly and never removes its old restriction', async () => {
  const state = captureSetup({ fail: true });
  state.context.api.refreshCaptureTarget();
  await state.context.api.settle();
  assert.equal(state.video.stopped, 1);
  assert.equal(state.video.restrictedTarget, state.old);
  assert.equal(state.calls.some(([, token]) => token === null), false);
  assert.match(state.context.api.error(), /Video framing unavailable.*Audio continues/);
});

test('whole-tab framing is never accepted as a fallback for moved Space capture', async () => {
  const state = captureSetup({ framing: 'whole tab' });
  state.context.api.refreshCaptureTarget();
  await state.context.api.settle();
  assert.equal(state.video.stopped, 1);
  assert.equal(state.calls.length, 0);
  assert.match(state.context.api.error(), /video capture stopped/);
});
