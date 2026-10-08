const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ URL, crypto: globalThis.crypto, fetch, AbortController, setTimeout, clearTimeout, performance, console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/LiveCache.js'), 'utf8') + '\nglobalThis.api = { parseDvrPlaylist, SpaceLiveCache, SpaceCacheStore };', context);
const { parseDvrPlaylist, SpaceLiveCache, SpaceCacheStore } = context.api;
const base = 'https://audio.example/path/live.m3u8';
const playlist = (sequence, urls, suffix = '') => '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:' + sequence + '\n' + urls.map(url => '#EXTINF:3,\n' + url).join('\n') + '\n' + suffix;
function makeCache(options = {}) {
  const bytes = new Map();
  return new SpaceLiveCache(base, { store: { ready: Promise.resolve(), get: async key => bytes.get(key), put: async (key, data) => bytes.set(key, data), close: async () => bytes.clear() }, ...options });
}

test('parser retains sequence, discontinuity, encryption, init maps and explicit byte ranges', () => {
  const result = parseDvrPlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:20\n#EXT-X-DISCONTINUITY-SEQUENCE:4\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="10@5"\n#EXTINF:3,\n#EXT-X-BYTERANGE:100@10\nmedia.m4s\n#EXT-X-DISCONTINUITY\n#EXTINF:3,\n#EXT-X-BYTERANGE:100\nmedia.m4s\n#EXT-X-ENDLIST', base);
  assert.equal(result.segments[0].sequence, 20);
  assert.equal(result.segments[1].cc, 5);
  assert.equal(result.segments[1].start, 110);
  assert.equal(result.segments[1].end, 210);
  assert.match(result.segments[0].key, /https:\/\/audio.example\/path\/key/);
  assert.equal(result.ended, true);
});

test('master playlist selects a separate audio rendition when present', () => {
  const result = parseDvrPlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"\nvideo.m3u8', base);
  assert.equal(result.variant, 'https://audio.example/path/audio.m3u8');
});

test('event playlist retains history across sliding windows and marks genuine network gaps', () => {
  const cache = makeCache(); cache.drain = () => {};
  cache.ingest(parseDvrPlaylist(playlist(10, ['a.aac','b.aac']), base));
  cache.ingest(parseDvrPlaylist(playlist(11, ['b.aac','c.aac']), base));
  cache.ingest(parseDvrPlaylist(playlist(15, ['f.aac'], '#EXT-X-ENDLIST'), base));
  const output = cache.playlist();
  assert.match(output, /#EXT-X-MEDIA-SEQUENCE:10/);
  assert.match(output, /path\/a.aac/);
  assert.equal((output.match(/#EXT-X-GAP/g) || []).length, 2);
  assert.equal(cache.missing, 2);
  assert.match(output, /#EXT-X-ENDLIST/);
  cache.destroy();
});

test('seek abort affects only the loader; shared capture completes and is reused without network', async () => {
  let release, calls = 0;
  const cache = makeCache({ fetch: async () => { calls++; await new Promise(resolve => { release = resolve; }); return new Response(new Uint8Array([1,2,3])); } });
  class Base { constructor() { this.stats = { aborted: false, loading: {} }; } }
  const Loader = cache.loaderClass(Base);
  const loader = new Loader();
  let callback = false;
  loader.load({ url: base + '/segment', responseType: 'arraybuffer' }, {}, { onSuccess() { callback = true; }, onError() { callback = true; } });
  loader.abort();
  release();
  const resource = cache.resource(base + '/segment');
  await cache.pending.get(resource.id);
  assert.equal(resource.saved, true);
  assert.equal(callback, false);
  assert.equal((await cache.capture(resource)).byteLength, 3);
  assert.equal(calls, 1);
  cache.destroy();
});

test('failed downloads remain retryable and quota failure is visible', async () => {
  let calls = 0;
  const cache = makeCache({ fetch: async () => ++calls === 1 ? new Response('', { status: 503 }) : new Response(new Uint8Array([1,2])) });
  const resource = cache.resource(base + '/segment');
  await assert.rejects(cache.capture(resource));
  assert.equal(resource.saved, false);
  await cache.capture(resource);
  assert.equal(resource.saved, true);
  cache.store.put = async () => { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; };
  assert.equal((await cache.capture(cache.resource(base + '/other'))).byteLength, 2);
  assert.match(cache.status(), /QuotaExceededError/);
  cache.destroy();
});

function fakeDatabase({ failWrites = false, hangWrites = false } = {}) {
  const values = new Map();
  const state = { closed: 0, deleted: [], request: null };
  const db = {
    close() { state.closed++; },
    transaction() {
      const tx = { abort() { tx.onabort?.(); }, objectStore() { return {
        get(key) { const request = { result: values.get(key) }; queueMicrotask(() => tx.oncomplete?.()); return request; },
        put(data, key) {
          const request = {};
          if (hangWrites) return request;
          if (failWrites) { tx.error = Object.assign(new Error('full'), { name: 'QuotaExceededError' }); queueMicrotask(() => tx.onabort?.()); }
          else { values.set(key, data); queueMicrotask(() => tx.oncomplete?.()); }
          return request;
        },
      }; } };
      return tx;
    },
  };
  const indexedDB = {
    open() { state.request = { result: db }; queueMicrotask(() => state.request.onsuccess?.()); return state.request; },
    deleteDatabase(name) { state.deleted.push(name); },
  };
  return { state, db, indexedDB };
}

test('unavailable IndexedDB cannot block playback and temporary rewind is explicit', async () => {
  const indexedDB = { open() { throw new Error('Internal error.'); }, deleteDatabase() {} };
  const store = new SpaceCacheStore({ indexedDB });
  const cache = makeCache({ store, fetch: async url => new Response(url === base ? playlist(1, ['a.aac'], '#EXT-X-ENDLIST') : new Uint8Array([1,2])) });
  cache.drain = () => {};
  await cache.start();
  assert.equal(store.mode, 'memory');
  assert.equal((await cache.capture(cache.segments.get(1).resource)).byteLength, 2);
  assert.match(cache.status(), /temporary rewind.*browser storage unavailable.*limited/);
  assert.doesNotMatch(cache.playlist(), /PLAYLIST-TYPE:EVENT/);
  cache.destroy();
});

test('database open errors and blocked opens resolve into the RAM fallback', async () => {
  for (const event of ['onerror', 'onblocked']) {
    let request;
    const store = new SpaceCacheStore({ indexedDB: { open() { return request = {}; }, deleteDatabase() {} } });
    request.error = new Error('Internal error.');
    request[event]();
    await store.ready;
    assert.equal(store.mode, 'memory');
    await store.close();
  }
});

test('hung open is bounded and a late database success is closed without reviving disk mode', async () => {
  let request, closed = 0;
  const deleted = [];
  const store = new SpaceCacheStore({ timeout: 15, indexedDB: {
    open() { return request = {}; }, deleteDatabase(name) { deleted.push(name); },
  } });
  await store.ready;
  assert.equal(store.mode, 'memory');
  request.result = { close() { closed++; } };
  request.onsuccess();
  assert.equal(closed, 1);
  assert.equal(store.mode, 'memory');
  await store.close();
  assert.deepEqual(deleted, [store.name]);
});

test('closing while an open is hung resolves startup and closes late connections', async () => {
  let request, closed = 0;
  const store = new SpaceCacheStore({ indexedDB: { open() { return request = {}; }, deleteDatabase() {} } });
  await store.close();
  await store.ready;
  request.result = { close() { closed++; } };
  request.onsuccess();
  assert.equal(closed, 1);
  await assert.rejects(store.put('a', new Uint8Array([1]).buffer), /Cache closed/);
});

test('write errors and hung transactions retain the just-downloaded audio in bounded memory', async () => {
  for (const option of [{ failWrites: true }, { hangWrites: true }]) {
    const fake = fakeDatabase(option);
    const store = new SpaceCacheStore({ indexedDB: fake.indexedDB, timeout: 15 });
    const cache = makeCache({ store, fetch: async () => new Response(new Uint8Array([1,2])) });
    cache.drain = () => {};
    cache.ingest(parseDvrPlaylist(playlist(1, ['a.aac']), base));
    const resource = cache.segments.get(1).resource;
    assert.equal((await cache.capture(resource)).byteLength, 2);
    assert.equal(store.mode, 'memory');
    assert.equal(resource.saved, true);
    assert.equal((await store.get(resource.id)).byteLength, 2);
    assert.equal(fake.state.closed, 1);
    cache.destroy();
    assert.deepEqual(fake.state.deleted, [store.name]);
  }
});

test('RAM eviction drops old rewind and does not requeue evicted audio or reingest expired history', async () => {
  let calls = 0;
  const store = new SpaceCacheStore({ maxBytes: 4, indexedDB: { open() { throw new Error('offline'); }, deleteDatabase() {} } });
  const cache = makeCache({ store, fetch: async () => { calls++; return new Response(new Uint8Array([1,2])); } });
  cache.drain = () => {};
  const source = parseDvrPlaylist(playlist(1, ['a.aac', 'b.aac', 'c.aac']), base);
  cache.ingest(source);
  const oldest = cache.segments.get(1).resource;
  for (const segment of [...cache.segments.values()]) await cache.capture(segment.resource);
  assert.equal(store.bytes, 4);
  assert.equal(cache.bytes, 4);
  assert.equal(cache.seconds, 6);
  assert.equal(oldest.saved, false);
  assert.equal(oldest.retired, true);
  assert.match(cache.playlist(), /MEDIA-SEQUENCE:2/);
  assert.doesNotMatch(cache.playlist(), /path\/a.aac/);
  cache.ingest(parseDvrPlaylist(playlist(1, ['a.aac', 'b.aac', 'c.aac']), base));
  assert.equal(cache.segments.size, 2);
  SpaceLiveCache.prototype.drain.call(cache);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 3);
  cache.destroy();
});

test('RAM history metadata is bounded even for a large initial playlist', () => {
  const store = new SpaceCacheStore({ indexedDB: { open() { throw new Error('offline'); }, deleteDatabase() {} } });
  const cache = makeCache({ store });
  cache.drain = () => {};
  cache.ingest(parseDvrPlaylist(playlist(1, Array.from({ length: 1000 }, (_, i) => i + '.aac')), base));
  assert.equal(cache.segments.size, 300);
  assert.equal(cache.resources.size, 300);
  assert.equal(cache.seconds, 900);
  assert.match(cache.playlist(), /MEDIA-SEQUENCE:701/);
  cache.destroy();
});

test('hls receives media progress before success and successful destroy does not mark bytes aborted', async () => {
  const cache = makeCache({ fetch: async () => new Response(new Uint8Array([1,2,3])) });
  class Base { constructor() { this.stats = { aborted: false, loading: {} }; } }
  const loader = new (cache.loaderClass(Base))();
  const events = [];
  await new Promise((resolve, reject) => loader.load({ url: base + '/segment', rangeStart: 0, rangeEnd: 0 }, {}, {
    onProgress(stats, context, bytes) { events.push('progress'); assert.equal(bytes.byteLength, 3); },
    onSuccess(response, stats) { events.push('success'); loader.destroy(); assert.equal(stats.aborted, false); resolve(); },
    onError: reject,
  }));
  assert.deepEqual(events, ['progress', 'success']);
  assert.equal(cache.resources.size, 1);
  cache.destroy();
});
