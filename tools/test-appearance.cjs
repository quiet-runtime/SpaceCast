const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/AppearanceSettings.js'), 'utf8');
const key = 'spacecast.appearance';
const plain = value => JSON.parse(JSON.stringify(value));

function setup(saved) {
  const data = saved === undefined ? {} : { [key]: saved };
  const listeners = new Set();
  const errors = { get: false, set: false };
  const chrome = {
    runtime: {},
    storage: {
      local: {
        get(name, callback) { queueMicrotask(() => {
          if (errors.get) chrome.runtime.lastError = { message: 'storage read failed' };
          callback({ [name]: data[name] }); delete chrome.runtime.lastError;
        }); },
        set(values, callback) { queueMicrotask(() => {
          if (errors.set) chrome.runtime.lastError = { message: 'storage write failed' };
          else {
            const oldValue = data[key]; Object.assign(data, plain(values));
            for (const listener of listeners) listener({ [key]: { oldValue, newValue: data[key] } }, 'local');
          }
          callback(); delete chrome.runtime.lastError;
        }); },
      },
      onChanged: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
    },
  };
  const context = vm.createContext({ chrome });
  vm.runInContext(source, context);
  return { api: context.SpaceCastAppearance, data, listeners, errors, emit: (changes, area) => { for (const listener of listeners) listener(changes, area); } };
}

test('missing appearance uses complete defaults without modifying storage', async () => {
  const { api, data } = setup();
  assert.deepEqual(plain(await api.load()), {
    style: 'liquid', opacity: 45, blur: 16, refraction: 18,
    participants: 'comfortable', spectrum: true, reducedMotion: false,
  });
  assert.equal(Object.isFrozen(api.defaults), true);
  assert.equal(Object.hasOwn(data, key), false);
});

test('normalization validates enums, strict booleans and finite bounded numbers', () => {
  const { api } = setup();
  const settings = plain(api.normalize({ style: 'script', opacity: 999, blur: -2, refraction: 18.6, participants: 'tiny', spectrum: 'false', reducedMotion: 1, extra: 'ignored' }));
  assert.deepEqual(settings, { style: 'liquid', opacity: 90, blur: 0, refraction: 19, participants: 'comfortable', spectrum: true, reducedMotion: false });
  assert.deepEqual(plain(api.normalize({ opacity: NaN, blur: Infinity, refraction: '40' })), plain(api.defaults));
  for (const invalid of [null, [], 'invalid', false]) assert.deepEqual(plain(api.normalize(invalid)), plain(api.defaults));
});

test('each supported style and participant size is preserved', () => {
  const { api } = setup();
  for (const style of ['liquid', 'dracula', 'oled', 'solid']) assert.equal(api.normalize({ style }).style, style);
  for (const participants of ['compact', 'comfortable', 'large']) assert.equal(api.normalize({ participants }).participants, participants);
  assert.equal(api.normalize({ spectrum: false }).spectrum, false);
  assert.equal(api.normalize({ reducedMotion: true }).reducedMotion, true);
});

test('rapid partial writes merge in order instead of losing other controls', async () => {
  const { api, data } = setup();
  await Promise.all([api.save({ style: 'dracula' }), api.save({ opacity: 63 }), api.save({ participants: 'large' }), api.save({ spectrum: false })]);
  assert.deepEqual(data[key], { style: 'dracula', opacity: 63, blur: 16, refraction: 18, participants: 'large', spectrum: false, reducedMotion: false });
  await api.save(api.defaults);
  assert.deepEqual(data[key], plain(api.defaults));
});

test('subscriptions apply only local appearance changes, sanitize them and unsubscribe', () => {
  const { api, emit, listeners } = setup();
  const received = [];
  const unsubscribe = api.subscribe(value => received.push(plain(value)));
  emit({ unrelated: { newValue: true } }, 'local');
  emit({ [key]: { newValue: { opacity: 20 } } }, 'sync');
  assert.equal(received.length, 0);
  emit({ [key]: { newValue: { style: 'oled', opacity: 900 } } }, 'local');
  assert.equal(received[0].style, 'oled'); assert.equal(received[0].opacity, 90);
  emit({ [key]: { oldValue: {} } }, 'local');
  assert.deepEqual(received[1], plain(api.defaults));
  unsubscribe(); assert.equal(listeners.size, 0);
});

test('storage failures reject clearly and do not strand later saves', async () => {
  const { api, data, errors } = setup();
  errors.get = true;
  await assert.rejects(api.load(), /storage read failed/);
  await assert.rejects(api.save({ opacity: 70 }), /storage read failed/);
  errors.get = false; errors.set = true;
  await assert.rejects(api.save({ opacity: 70 }), /storage write failed/);
  assert.equal(Object.hasOwn(data, key), false);
  errors.set = false;
  await api.save({ opacity: 70 }); assert.equal(data[key].opacity, 70);
});

test('unavailable extension storage fails with a useful error and safe unsubscribe', async () => {
  const context = vm.createContext({}); vm.runInContext(source, context);
  await assert.rejects(context.SpaceCastAppearance.load(), /storage is unavailable/);
  await assert.rejects(context.SpaceCastAppearance.save({ blur: 0 }), /storage is unavailable/);
  assert.doesNotThrow(context.SpaceCastAppearance.subscribe(() => {}));
});

test('browser promise storage is supported without Chrome callbacks', async () => {
  const data = {};
  const context = vm.createContext({ browser: { storage: { local: { get: async () => data, set: async value => Object.assign(data, value) } } } });
  vm.runInContext(source, context);
  const settings = await context.SpaceCastAppearance.save({ style: 'solid' });
  assert.equal(settings.style, 'solid'); assert.equal(data[key].style, 'solid');
});
