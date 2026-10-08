const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/SpaceCast.js'), 'utf8');
const lifecycle = source.slice(source.indexOf('// One owner per route.'), source.indexOf('function reconcileSpace()'));

function setup(options = {}) {
  const timers = new Map();
  const errors = [];
  const retries = [];
  let nextTimer = 0;
  let played = 0;
  let cacheStarted = false;
  let cacheDestroyed = false;
  let hls;
  class FakeHls {
    static isSupported() { return true; }
    static DefaultConfig = { loader() {} };
    static Events = { ERROR: 'error', FRAG_BUFFERED: 'buffered', MANIFEST_PARSED: 'parsed' };
    static ErrorTypes = { MEDIA_ERROR: 'media' };
    constructor() { this.events = {}; hls = this; }
    on(event, callback) { this.events[event] = callback; }
    emit(event, data = {}) { this.events[event]?.(event, data); }
    attachMedia() {}
    loadSource() {}
    startLoad() {}
    recoverMediaError() {}
    destroy() { this.destroyed = true; }
  }
  const context = vm.createContext({
    URL, AbortController, Promise,
    console: { warn() {} },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    readSpace: () => ({ title: 'Test Space' }),
    reconcileSpace() {},
    SpaceCastApi: class {
      async AudioSpaceById() {
        if (options.metadataError) throw new Error(options.metadataError);
        return { data: { audioSpace: { metadata: { media_key: 'test-media' } } } };
      }
      async live_video_stream() { return { source: { location: 'https://audio.example/live.m3u8' } }; }
    },
    Hls: FakeHls,
    SpaceLiveCache: class {
      async start() { cacheStarted = true; if (options.hangCache) await new Promise(() => {}); }
      destroy() { cacheDestroyed = true; }
      loaderClass(loader) { return loader; }
      status() { return 'cached'; }
    },
  });
  vm.runInContext(lifecycle + '\nglobalThis.api = { openSpaceSession, closeSpaceSession, setSession(value) { spaceSession = value; } };', context);
  const session = {
    space: { id: 'test-space' }, controller: new AbortController(),
    panel: {
      audio: { currentTime: 10, play() { played++; return Promise.resolve(); } },
      setError(value) { errors.push(value); }, setRetry(value) { retries.push(value); },
      setPlaylistUrl() {}, setCacheStatus() {}, dispose() {},
    },
  };
  context.api.setSession(session);
  return { api: context.api, session, timers, errors, retries,
    get hls() { return hls; }, get played() { return played; },
    get cacheStarted() { return cacheStarted; }, get cacheDestroyed() { return cacheDestroyed; } };
}

test('hung cache startup times out, destroys cache, and offers Retry', async () => {
  const state = setup({ hangCache: true });
  const opening = state.api.openSpaceSession(state.session);
  for (let tick = 0; tick < 20 && !state.cacheStarted; tick++) await Promise.resolve();
  assert.equal(state.cacheStarted, true);
  assert.equal(state.timers.size, 1, 'startup deadline must still cover cache initialization');
  [...state.timers.values()][0]();
  await opening;
  assert.match(state.errors.at(-1), /Audio cache timed out/);
  assert.equal(state.cacheDestroyed, true);
  assert.equal(typeof state.retries.at(-1), 'function');
  assert.equal(state.timers.size, 0);
});

test('an API Internal error identifies the failed startup stage', async () => {
  const state = setup({ metadataError: 'Internal error.' });
  await state.api.openSpaceSession(state.session);
  assert.equal(state.errors.at(-1), 'Space details: Internal error.');
  assert.equal(state.timers.size, 0);
});

test('buffer recovery clears the Retry control and pending recovery timer', async () => {
  const state = setup();
  await state.api.openSpaceSession(state.session);
  for (let count = 0; count < 4; count++) state.hls.emit('error', { fatal: true, details: 'buffer', type: 'media' });
  assert.equal(typeof state.retries.at(-1), 'function');
  assert.equal(state.timers.size, 0);
  state.hls.emit('buffered');
  assert.equal(state.retries.at(-1), null);
  assert.equal(state.errors.at(-1), '');
  state.hls.emit('error', { fatal: true, details: 'buffer', type: 'media' });
  assert.equal(state.timers.size, 1);
  state.hls.emit('buffered');
  assert.equal(state.timers.size, 0);
});

test('closed sessions ignore late HLS callbacks and stale Retry clicks', async () => {
  const state = setup();
  await state.api.openSpaceSession(state.session);
  for (let count = 0; count < 4; count++) state.hls.emit('error', { fatal: true, details: 'buffer', type: 'media' });
  const retry = state.retries.at(-1);
  const errors = state.errors.length;
  const retries = state.retries.length;
  state.api.closeSpaceSession();
  state.hls.emit('parsed');
  state.hls.emit('buffered');
  state.hls.emit('error', { fatal: true, details: 'late', type: 'media' });
  retry();
  assert.equal(state.played, 0);
  assert.equal(state.errors.length, errors);
  assert.equal(state.retries.length, retries);
  assert.equal(state.timers.size, 0);
});

test('route close cancels a hung cache without updating the disposed panel', async () => {
  const state = setup({ hangCache: true });
  const opening = state.api.openSpaceSession(state.session);
  for (let tick = 0; tick < 20 && !state.cacheStarted; tick++) await Promise.resolve();
  state.api.closeSpaceSession();
  await opening;
  assert.equal(state.cacheDestroyed, true);
  assert.equal(state.errors.length, 0);
  assert.equal(state.retries.length, 0);
  assert.equal(state.timers.size, 0);
});


test('a closing session ignores manifest playback, retry and recovery callbacks while recordings save', async () => {
  const state = setup();
  await state.api.openSpaceSession(state.session);
  for (let count = 0; count < 4; count++) state.hls.emit('error', { fatal: true, details: 'buffer', type: 'media' });
  const retry = state.retries.at(-1);
  state.session.closing = true;
  const errors = state.errors.length;
  const retries = state.retries.length;
  state.hls.emit('parsed');
  state.hls.emit('buffered');
  state.hls.emit('error', { fatal: true, details: 'late', type: 'media' });
  retry();
  assert.equal(state.played, 0);
  assert.equal(state.errors.length, errors);
  assert.equal(state.retries.length, retries);
  assert.equal(state.timers.size, 0);
});
