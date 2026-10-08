const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../js/SpaceCastApi.js'), 'utf8');
const success = { data: { audioSpace: { metadata: { media_key: '28_test', state: 'Running' } } } };
const response = (body = success, status = 200) => ({ ok: status === 200, status, json: async () => body });
const native = (hash = 'native_operation', origin = 'https://x.com') => {
  const url = new URL(`${origin}/i/api/graphql/${hash}/AudioSpaceById`);
  url.searchParams.set('variables', JSON.stringify({ id: 'oldSpace', isMetatagsQuery: false }));
  url.searchParams.set('features', JSON.stringify({ spaces_enabled: true, ignore_nested: { secret: true } }));
  url.searchParams.set('fieldToggles', JSON.stringify({ withArticleRichContentState: false }));
  url.searchParams.set('ignored', 'do-not-replay');
  return { name: url.href };
};
function harness({ entries = [], cookie = 'ct0=signed-in; gt=stale', fetcher = async () => response(), signal } = {}) {
  const requests = [];
  const context = vm.createContext({ URL, URLSearchParams, DOMException, document: { cookie }, location: { origin: 'https://x.com' }, performance: { getEntriesByType: () => entries }, fetch: async (url, options) => { requests.push({ url, options }); return fetcher(url, options); } });
  vm.runInContext(source + '\nglobalThis.Api = SpaceCastApi;', context);
  return { api: new context.Api(signal), requests, entries };
}

test('uses current native operation, sanitized features and requested Space ID', async () => {
  const { api, requests } = harness({ entries: [native('old_operation'), native('rotated_operation')] });
  assert.equal(await api.AudioSpaceById('newSpace'), success);
  const url = new URL(requests[0].url);
  assert.match(url.pathname, /rotated_operation/);
  assert.deepEqual(JSON.parse(url.searchParams.get('variables')), { id: 'newSpace', isMetatagsQuery: false });
  assert.deepEqual(JSON.parse(url.searchParams.get('features')), { spaces_enabled: true });
  assert.deepEqual(JSON.parse(url.searchParams.get('fieldToggles')), { withArticleRichContentState: false });
  assert.equal(url.searchParams.has('ignored'), false);
  assert.equal(requests[0].options.headers['x-csrf-token'], 'signed-in');
  assert.equal(requests[0].options.headers['x-guest-token'], undefined);
});

test('partial GraphQL errors do not discard usable metadata', async () => {
  const body = { ...success, errors: [{ message: 'Internal error.', path: ['optionalField'] }] };
  assert.equal(await harness({ fetcher: async () => response(body) }).api.AudioSpaceById('aSpace'), body);
});

test('404 refreshes native operation once', async () => {
  const entries = [native('old_operation')];
  let count = 0;
  const { api, requests } = harness({ entries, fetcher: async () => { if (++count === 1) { entries.push(native('new_operation')); return response({}, 404); } return response(); } });
  await api.AudioSpaceById('aSpace');
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /new_operation/);
});

test('no repeated requests when fallback itself returns 404', async () => {
  const { api, requests } = harness({ fetcher: async () => response({}, 404) });
  await assert.rejects(api.AudioSpaceById('aSpace'), /Space details: X HTTP 404/);
  assert.equal(requests.length, 1);
});

test('native 404 has a single legacy fallback, never a retry loop', async () => {
  const { api, requests } = harness({ entries: [native()], fetcher: async () => response({}, 404) });
  await assert.rejects(api.AudioSpaceById('aSpace'), /HTTP 404/);
  assert.equal(requests.length, 2);
});

test('malformed cookies are ignored and values retain equals signs', async () => {
  const { api, requests } = harness({ cookie: 'bad=%zz;ct0=%zz; gt=guest%3Dvalue; ct0=%0D%0Aevil' });
  await api.AudioSpaceById('aSpace');
  assert.equal(requests[0].options.headers['x-guest-token'], 'guest=value');
  assert.equal(requests[0].options.headers['x-csrf-token'], undefined);
});

test('ignores cross-origin, malformed and unrelated native URLs', async () => {
  const { api, requests } = harness({ entries: [native('evil_operation', 'https://evil.example'), { name: 'https://x.com/i/api/graphql/bad_operation/DeleteTweet?variables=%7B%7D' }, { name: 'not a URL' }] });
  await api.AudioSpaceById('aSpace');
  assert.match(requests[0].url, /Uv5R_-Chxbn1FEkyUkSW2w/);
});

test('already aborted operation makes no requests', async () => {
  const controller = new AbortController();
  controller.abort();
  const { api, requests } = harness({ signal: controller.signal });
  await assert.rejects(api.AudioSpaceById('aSpace'), { name: 'AbortError' });
  assert.equal(requests.length, 0);
});

test('abort during response never retries', async () => {
  const controller = new AbortController();
  const { api, requests } = harness({ signal: controller.signal, fetcher: async () => { controller.abort(); return response({}, 404); } });
  await assert.rejects(api.AudioSpaceById('aSpace'), { name: 'AbortError' });
  assert.equal(requests.length, 1);
});

test('stream errors identify stream stage and partial stream data is usable', async () => {
  await assert.rejects(harness({ fetcher: async () => response({}, 403) }).api.live_video_stream('28_test'), /Audio stream: X HTTP 403/);
  const body = { source: { location: 'https://video.example/audio.m3u8' }, errors: [{ message: 'optional error' }] };
  assert.equal(await harness({ fetcher: async () => response(body) }).api.live_video_stream('28_test'), body);
});

test('empty metadata does not mask the original GraphQL error', async () => {
  const body = { data: { audioSpace: { metadata: {} } }, errors: [{ message: 'Space unavailable' }] };
  await assert.rejects(harness({ fetcher: async () => response(body) }).api.AudioSpaceById('aSpace'), /Space details: Space unavailable/);
});

test('abort during body decoding is preserved', async () => {
  const controller = new AbortController();
  const { api } = harness({ signal: controller.signal, fetcher: async () => ({ ok: true, json: async () => { controller.abort(); return success; } }) });
  await assert.rejects(api.AudioSpaceById('aSpace'), { name: 'AbortError' });
});
