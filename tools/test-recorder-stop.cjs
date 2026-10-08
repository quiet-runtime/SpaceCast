const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/SpaceCast.js'), 'utf8');
const recording = source.slice(0, source.indexOf('// Ask the browser to confirm navigation'));
const never = () => new Promise(() => {});
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nfirst.aac\n#EXTINF:3,\nsecond.aac\n#EXT-X-ENDLIST';

function setup(fetch) {
  let sequence = 0;
  const timers = new Map();
  const calls = [];
  const context = vm.createContext({
    URL, AbortController, DOMException, Uint8Array,
    console: { warn() {}, error() {} },
    fetch(url, options) { const call = { url, options }; calls.push(call); return fetch(url, options); },
    setTimeout(callback, ms) { const id = ++sequence; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    OpusTranscoder: { isSupportedForAac: async () => false },
  });
  vm.runInContext(recording + '\nglobalThis.api = { SpaceRecorder, PreRoll, fetchStreamResource, fetchSegment, activeRecorders };', context);
  const recorder = new context.api.SpaceRecorder('https://audio.test/live.m3u8', { id: 'test' });
  const saved = [];
  recorder.writeFile = async (_transcoder, chunks) => {
    const bytes = Array.from(chunks).flatMap(chunk => Array.from(chunk));
    saved.push(bytes);
    return { name: 'recording.opus', size: bytes.length };
  };
  function fire(ms) {
    const found = [...timers].find(([, timer]) => timer.ms === ms);
    assert.ok(found, `Expected a pending ${ms} ms timer`);
    timers.delete(found[0]);
    found[1].callback();
  }
  return { ...context.api, recorder, saved, timers, calls, fire };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(predicate(), 'Expected the asynchronous operation to reach its pending stage');
}

function preroll() {
  return { seen: new Set(['https://audio.test/saved.aac']), seconds: 3,
    segments: [{ url: 'https://audio.test/saved.aac', duration: 3, bytes: new Uint8Array([1, 2, 3]) }] };
}

for (const stage of ['headers', 'body']) {
  test(`Stop saves adopted pre-roll while playlist ${stage} never settles`, async () => {
    let reached = false;
    const state = setup(() => {
      if (stage === 'headers') { reached = true; return never(); }
      return { ok: true, text() { reached = true; return never(); } };
    });
    const stopped = state.recorder.start(preroll());
    await until(() => reached);
    state.recorder.requestStop();
    await stopped;
    assert.equal(state.recorder.state, 'done');
    assert.deepEqual(state.saved, [[1, 2, 3]]);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].options.signal.aborted, true);
    assert.equal(state.activeRecorders.size, 0);
    assert.equal(state.timers.size, 0);
  });
}

for (const stage of ['headers', 'body']) {
  test(`Stop preserves completed parallel segments when another segment ${stage} stalls`, async () => {
    let pending;
    const state = setup((url, options) => {
      if (url.endsWith('.m3u8')) return { ok: true, text: async () => playlist };
      if (url.endsWith('first.aac')) return { ok: true, arrayBuffer: async () => new Uint8Array([4, 5, 6]).buffer };
      pending = options.signal;
      return stage === 'headers' ? never() : { ok: true, arrayBuffer: never };
    });
    const savedPreroll = stage === 'headers';
    const stopped = state.recorder.start(savedPreroll ? preroll() : undefined);
    await until(() => pending && state.recorder.bytes === (savedPreroll ? 6 : 3));
    state.recorder.requestStop();
    await stopped;
    assert.equal(pending.aborted, true);
    assert.equal(state.recorder.state, 'done');
    assert.deepEqual(state.saved, [savedPreroll ? [1, 2, 3, 4, 5, 6] : [4, 5, 6]]);
    assert.notEqual(state.recorder.message, 'complete', 'Cancelled replay must not claim a complete download');
    assert.equal(state.timers.size, 0);
  });
}

test('Stop flushes successful parallel downloads in playlist order', async () => {
  let finishFirst, third;
  const state = setup((url, options) => {
    if (url.endsWith('.m3u8')) return { ok: true, text: async () => playlist.replace('#EXT-X-ENDLIST', '#EXTINF:3,\nthird.aac\n#EXT-X-ENDLIST') };
    if (url.endsWith('first.aac')) return { ok: true, arrayBuffer: () => new Promise(resolve => { finishFirst = () => resolve(new Uint8Array([10]).buffer); }) };
    if (url.endsWith('second.aac')) return { ok: true, arrayBuffer: async () => new Uint8Array([20]).buffer };
    third = options.signal;
    return never();
  });
  const stopped = state.recorder.start();
  await until(() => finishFirst && third && state.recorder.bytes === 1);
  finishFirst();
  await until(() => state.recorder.bytes === 2);
  state.recorder.requestStop();
  await stopped;
  assert.deepEqual(state.saved, [[10, 20]]);
  assert.equal(third.aborted, true);
  assert.equal(state.timers.size, 0);
});

for (const stage of ['headers', 'body']) {
  test(`Playlist ${stage} timeout aborts transport and reports a bounded failure`, async () => {
    let reached = false;
    const state = setup(() => {
      if (stage === 'headers') { reached = true; return never(); }
      return { ok: true, text() { reached = true; return never(); } };
    });
    const failed = assert.rejects(state.recorder.fetchText('https://audio.test/live.m3u8'), { name: 'TimeoutError', message: 'Playlist request timed out' });
    await until(() => reached);
    state.fire(15000);
    await failed;
    assert.equal(state.calls[0].options.signal.aborted, true);
    assert.equal(state.timers.size, 0);
  });
}

test('Segment body timeouts use three bounded attempts and release each transport', async () => {
  let bodies = 0;
  const state = setup(() => ({ ok: true, arrayBuffer() { bodies++; return never(); } }));
  const result = state.fetchSegment('https://audio.test/stalled.aac', new AbortController().signal);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await until(() => bodies === attempt);
    state.fire(15000);
    if (attempt < 3) {
      await until(() => [...state.timers.values()].some(timer => timer.ms === 400 * attempt));
      state.fire(400 * attempt);
    }
  }
  assert.equal(await result, null);
  assert.equal(state.calls.length, 3);
  assert.ok(state.calls.every(call => call.options.signal.aborted));
  assert.equal(state.timers.size, 0);
});

test('A rejected body releases its deadline and Stop cancels segment retry delay', async () => {
  const state = setup(() => ({ ok: true, arrayBuffer: async () => { throw new Error('Body disconnected'); } }));
  const result = state.fetchSegment('https://audio.test/retry.aac', state.recorder.requestController.signal);
  await until(() => [...state.timers.values()].some(timer => timer.ms === 400));
  assert.equal([...state.timers.values()].some(timer => timer.ms === 15000), false);
  state.recorder.requestStop();
  assert.equal(await result, null);
  assert.equal(state.calls.length, 1);
  assert.equal(state.timers.size, 0);
});

test('Pre-roll cancellation releases its own stalled request without aborting the recorder', async () => {
  const state = setup(never);
  const buffer = new state.PreRoll('https://audio.test/live.m3u8', () => true);
  buffer.start();
  await until(() => state.calls.length === 1);
  buffer.stop();
  await until(() => state.timers.size === 0);
  assert.equal(state.calls[0].options.signal.aborted, true);
  assert.equal(state.recorder.requestController.signal.aborted, false);
});

test('Stop wakes a playlist poll delay without waiting for another request', async () => {
  const state = setup(() => ({ ok: true, text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:6' }));
  const stopped = state.recorder.start(preroll());
  await until(() => [...state.timers.values()].some(timer => timer.ms === 6000));
  const before = state.calls.length;
  state.recorder.requestStop();
  await stopped;
  assert.deepEqual(state.saved, [[1, 2, 3]]);
  assert.equal(state.calls.length, before);
  assert.equal(state.timers.size, 0);
});
