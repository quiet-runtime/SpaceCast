const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/SpaceCast.js'), 'utf8');
const recording = source.slice(0, source.indexOf('// Ask the browser to confirm navigation'));
const naming = source.slice(source.indexOf('function readSpace('), source.indexOf('const SPACECAST_AUDIO_ID'));
const opus = fs.readFileSync(path.join(__dirname, '../js/OggOpus.js'), 'utf8');
const when = new Date(2001, 1, 3, 1, 59, 58);
const space = { id: '1abcdefghJKLM', title: 'می\u200cشنویم؛ گفت‌وگو #خبر', host: 'Test host · میزبان', url: 'https://x.com/i/spaces/1abcdefghJKLM' };

function setup() {
  const downloads = [], blobs = new Map();
  class DownloadURL extends URL {
    static createObjectURL(blob) { const url = 'blob:test/' + blobs.size; blobs.set(url, blob); return url; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    URL: DownloadURL, AbortController, TextEncoder, TextDecoder, Blob, Uint8Array,
    console: { warn() {}, error() {} }, setTimeout() {}, clearTimeout() {},
    document: {
      body: { appendChild() {} },
      createElement() { return { click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); }, remove() {} }; },
    },
  });
  vm.runInContext(opus + '\n' + recording + '\n' + naming + '\nglobalThis.api = { SpaceRecorder, readSpace, buildFileName, buildTags, buildOpusTags };', context);
  return { ...context.api, downloads };
}

function decodeTags(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  assert.equal(decoder.decode(bytes.slice(0, 8)), 'OpusTags');
  let offset = 8;
  const readString = () => { const size = view.getUint32(offset, true); offset += 4; const value = decoder.decode(bytes.slice(offset, offset + size)); offset += size; return value; };
  const vendor = readString();
  const count = view.getUint32(offset, true); offset += 4;
  const comments = Array.from({ length: count }, readString);
  assert.equal(offset, bytes.length);
  return { vendor, comments };
}

test('Persian filenames retain joining characters and have second precision', () => {
  const { buildFileName } = setup();
  const first = buildFileName(space, 'opus', when, 0);
  assert.equal(first, 'می‌شنویم-گفت‌وگو-خبر_1abcdefghJKLM_2001-02-03_015958.opus');
  const next = buildFileName(space, 'opus', new Date(+when + 1000), 0);
  assert.notEqual(next, first);
  assert.ok(next.endsWith('_015959.opus'));
});

test('long Unicode filenames stay well-formed and below cross-platform component limits', () => {
  const { buildFileName } = setup();
  for (const title of ['𠮷'.repeat(100), 'آ'.repeat(200), 'a\u0308'.repeat(200), '😀'.repeat(200)]) {
    const name = buildFileName({ title, id: '𠮷'.repeat(100) }, 'opus', when, Number.MAX_SAFE_INTEGER);
    assert.ok(name.isWellFormed());
    assert.ok(Buffer.byteLength(name, 'utf8') <= 255, name);
    assert.ok(name.length <= 255);
    assert.match(name, /_pt9007199254740991\.opus$/);
  }
});

test('filenames exclude Windows separators, controls, bidi overrides, and reserved base names', () => {
  const { buildFileName } = setup();
  for (const title of ['CON', 'NUL', 'COM1', '../A\\B:<C>"D|E?F*\n\u202Etxt', '   ...   ']) {
    const name = buildFileName({ title, id: '../bad/id\\unsafe' }, 'aac', when, 0);
    assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/);
    assert.doesNotMatch(name, /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\./i);
    assert.ok(name.endsWith('_2001-02-03_015958.aac'));
  }
});

test('Opus tags round-trip the full Unicode title and artist with SpaceCast writing metadata', () => {
  const { buildTags, buildOpusTags } = setup();
  const title = space.title + '؛ گزارش بلند '.repeat(20);
  const tags = decodeTags(buildOpusTags('SpaceCast', buildTags({ ...space, title }, when, 2)));
  assert.equal(tags.vendor, 'SpaceCast');
  assert.deepEqual(tags.comments, ['TITLE=' + title.trim(), 'ARTIST=' + space.host, 'DATE=2001-02-03', 'TRACKNUMBER=2', 'DESCRIPTION=' + space.url, 'ENCODER=SpaceCast']);
});

test('metadata has a useful fallback title and never serializes absent fields', () => {
  const { buildTags } = setup();
  assert.deepEqual(Array.from(buildTags({ id: '123' }, when, 0)), ['TITLE=X Space 123', 'DATE=2001-02-03', 'ENCODER=SpaceCast']);
  const tags = Array.from(buildTags({ title: '\u202Eخبر\u202C\nمی\u200cشنویم\u200d', host: '\u0000 نام ' }, when, 0));
  assert.deepEqual(tags, ['TITLE=خبر می‌شنویم\u200d', 'ARTIST=نام', 'DATE=2001-02-03', 'ENCODER=SpaceCast']);
});

test('embedded date and filename use the same local recording day across UTC midnight', () => {
  const { buildTags, buildFileName } = setup();
  const midnight = new Date('2001-02-02T23:59:58.123Z');
  Object.assign(midnight, { getFullYear: () => 2001, getMonth: () => 1, getDate: () => 3, getHours: () => 1, getMinutes: () => 59, getSeconds: () => 58 });
  assert.ok(buildTags(space, midnight, 0).includes('DATE=2001-02-03'));
  assert.ok(buildFileName(space, 'opus', midnight, 0).endsWith('_2001-02-03_015958.opus'));
});

test('all part exports retain their original Space identity and recording start time', async () => {
  const state = setup();
  const original = { ...space };
  const recorder = new state.SpaceRecorder('https://audio.test/live.m3u8', original);
  recorder.startedAt = +when;
  const transcoder = { finish: async comments => new Blob([state.buildOpusTags('SpaceCast', comments)]) };
  await recorder.writeFile(transcoder, [], null, 1, true);
  original.title = 'Another Space'; original.host = 'Another host'; original.id = 'changed'; original.url = 'https://x.com/i/spaces/changed';
  await recorder.writeFile(transcoder, [], null, 2, true);
  assert.equal(state.downloads.length, 2);
  for (const [index, download] of state.downloads.entries()) {
    assert.equal(download.name, `می‌شنویم-گفت‌وگو-خبر_1abcdefghJKLM_2001-02-03_015958_pt${index + 1}.opus`);
    const tags = decodeTags(new Uint8Array(await download.blob.arrayBuffer()));
    assert.ok(tags.comments.includes('TITLE=' + space.title));
    assert.ok(tags.comments.includes('ARTIST=' + space.host));
    assert.ok(tags.comments.includes('TRACKNUMBER=' + (index + 1)));
    assert.ok(tags.comments.includes('DESCRIPTION=' + space.url));
  }
});

for (const [container, extension, mime] of [['aac', 'aac', 'audio/aac'], ['ts', 'ts', 'video/mp2t'], ['mp4', 'm4a', 'audio/mp4']]) {
  test(`raw ${container} fallback uses the same title and correct extension`, async () => {
    const state = setup();
    const recorder = new state.SpaceRecorder('https://audio.test/live.m3u8', space);
    recorder.startedAt = +when; recorder.container = container; recorder.toOpus = async () => null;
    const written = await recorder.writeFile(null, [new Uint8Array([1, 2, 3])], null, 0, false);
    assert.equal(written.name, `می‌شنویم-گفت‌وگو-خبر_1abcdefghJKLM_2001-02-03_015958.${extension}`);
    assert.equal(state.downloads[0].blob.type, mime);
    assert.equal(written.size, 3);
  });
}

test('host tags support the legacy screen-name-only API result', () => {
  const { readSpace } = setup();
  const result = readSpace({ data: { audioSpace: { metadata: { creator_results: { result: { legacy: { screen_name: 'host_handle' } } } } } } }, space.id);
  assert.equal(result.host, 'host_handle');
});
