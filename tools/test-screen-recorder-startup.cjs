const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(failure) {
  const streams = [];
  const copied = [];
  const events = [];
  const target = { style: { isolation: 'auto' }, isConnected: true };
  let failAt = failure;
  let writes = 0;
  let recorderStops = 0;
  const track = kind => ({ kind, stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ width: 520, height: 600 }), addEventListener() {} });
  const context = vm.createContext({
    console: { log() {}, warn() {} },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { mediaDevices: { async getDisplayMedia() {
      const tracks = [track('video')];
      if (failAt !== 'audio') tracks.push(track('audio'));
      const stream = { getTracks: () => tracks, getVideoTracks: () => tracks.filter(item => item.kind === 'video'), getAudioTracks: () => tracks.filter(item => item.kind === 'audio'), addTrack: value => tracks.push(value) };
      streams.push(stream);
      return stream;
    } } },
    MediaRecorder: class {
      static isTypeSupported() { return true; }
      constructor() { if (failAt === 'constructor') throw new Error('encoder construction failed'); this.state = 'inactive'; }
      start() { this.state = 'recording'; if (failAt === 'start') throw new Error('encoder start failed'); }
      stop() { recorderStops++; this.state = 'inactive'; this.onstop?.(); }
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ScreenRecorder.js'), 'utf8') + '\nglobalThis.Recorder = ScreenRecorder;', context);
  const recorder = new context.Recorder({ targetOf: () => target, audioTrackOf: () => { throw new Error('audio graph unavailable'); }, nameOf: () => 'test.mp4', onchange: () => events.push(recorder.state) });
  recorder.restrict = async () => {
    recorder.isolated = { element: target, previous: target.style.isolation };
    target.style.isolation = 'isolate';
    recorder.restrictedTarget = target;
    recorder.framing = 'element';
    const copy = { cancelled: false, track: track('video'), stop() { this.cancelled = true; } };
    copied.push(copy); recorder.normaliser = copy;
  };
  recorder.write = () => writes++;
  return { recorder, streams, copied, target, events, clearFailure: () => { failAt = null; }, writes: () => writes, recorderStops: () => recorderStops };
}

for (const stage of ['constructor', 'start', 'audio']) {
  test(`video ${stage} failure closes capture resources and returns to idle without a download`, async () => {
    const state = setup(stage);
    await assert.doesNotReject(state.recorder.start());
    assert.equal(state.recorder.state, 'idle');
    assert.match(state.recorder.message, /^capture failed:/);
    assert.equal(state.recorder.stream, null);
    assert.equal(state.recorder.recorder, null);
    assert.equal(state.recorder.normaliser, null);
    assert.equal(state.target.style.isolation, 'auto');
    assert.ok(state.streams[0].getTracks().every(track => track.stopped));
    assert.ok(state.copied[0].cancelled && state.copied[0].track.stopped);
    assert.deepEqual(state.events, ['starting', 'idle']);
    assert.equal(state.writes(), 0);
    if (stage === 'start') assert.equal(state.recorderStops(), 1);
  });
}

test('video startup can be retried after an encoder failure', async () => {
  const state = setup('constructor');
  await state.recorder.start();
  state.clearFailure();
  await state.recorder.start();
  assert.equal(state.recorder.state, 'recording');
  assert.equal(state.recorder.message, '');
  assert.equal(state.streams.length, 2);
  assert.ok(state.streams[0].getTracks().every(track => track.stopped));
  assert.ok(state.streams[1].getTracks().every(track => !track.stopped));
  assert.deepEqual(state.events, ['starting', 'idle', 'starting', 'recording']);
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function navigationSetup(options = {}) {
  const makeTarget = name => ({ name, isConnected: true, style: { isolation: 'auto' } });
  let target = makeTarget('native');
  const first = target;
  const targets = [target];
  const started = [];
  const restricted = [];
  const events = [];
  let scope = null;
  let tokenCalls = 0;
  const tokenEntered = deferred();
  const tokenGate = deferred();
  const codecEntered = deferred();
  const codecGate = deferred();
  const navigate = name => { target.isConnected = false; target = makeTarget(name); targets.push(target); return target; };
  const track = {
    stopped: false,
    stop() { this.stopped = true; },
    getSettings: () => ({ width: 520, height: 600 }),
    addEventListener() {},
    async restrictTo(token) { scope = token?.target || null; restricted.push(scope); },
  };
  const audio = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track, audio], getVideoTracks: () => [track], getAudioTracks: () => [audio] };
  const context = vm.createContext({
    console: { log() {}, warn() {} },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { mediaDevices: { getDisplayMedia: async () => stream } },
    RestrictionTarget: {
      async fromElement(element) {
        tokenCalls++;
        if (options.alwaysMove) navigate('replacement-' + tokenCalls);
        if (options.failRestriction) throw new Error('restriction unavailable');
        if (options.delayToken && tokenCalls === 1) { tokenEntered.resolve(); return tokenGate.promise; }
        return { target: element };
      },
    },
    VideoEncoder: { async isConfigSupported() {
      if (options.delayCodec) { codecEntered.resolve(); return codecGate.promise; }
      return { supported: true };
    } },
    MediaRecorder: class {
      static isTypeSupported() { return true; }
      constructor() { this.state = 'inactive'; }
      start() { this.state = 'recording'; started.push({ target: scope, current: target, connected: scope?.isConnected }); }
      stop() { this.state = 'inactive'; }
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ScreenRecorder.js'), 'utf8') + '\nframesArrive = async () => true; globalThis.Recorder = ScreenRecorder;', context);
  const recorder = new context.Recorder({ targetOf: () => target, nameOf: () => 'test.mp4', onchange: () => events.push(recorder.state) });
  return { recorder, first, targets, started, restricted, events, track, audio, tokenEntered, tokenGate, codecEntered, codecGate, navigate, tokenCalls: () => tokenCalls };
}

test('navigation while the restriction token is pending reframes the current Space before recording', async () => {
  const state = navigationSetup({ delayToken: true });
  const opening = state.recorder.start();
  await state.tokenEntered.promise;
  const current = state.navigate('persistent');
  state.tokenGate.resolve({ target: state.first });
  await opening;
  assert.equal(state.recorder.state, 'recording');
  assert.equal(state.recorder.restrictedTarget, current);
  assert.deepEqual(state.started, [{ target: current, current, connected: true }]);
  assert.ok(state.restricted.every(target => target === current));
  assert.equal(state.first.style.isolation, 'auto');
});

test('navigation while codec support is pending is checked again immediately before recording', async () => {
  const state = navigationSetup({ delayCodec: true });
  const opening = state.recorder.start();
  await state.codecEntered.promise;
  const current = state.navigate('returned-native');
  state.codecGate.resolve({ supported: true });
  await opening;
  assert.equal(state.recorder.state, 'recording');
  assert.equal(state.recorder.restrictedTarget, current);
  assert.deepEqual(state.started, [{ target: current, current, connected: true }]);
  assert.equal(state.first.style.isolation, 'auto');
});

test('continuous target changes stop after bounded retries and release capture without recording', async () => {
  const state = navigationSetup({ alwaysMove: true });
  await state.recorder.start();
  assert.equal(state.tokenCalls(), 3);
  assert.equal(state.recorder.state, 'idle');
  assert.match(state.recorder.message, /kept moving.*Try recording again/);
  assert.equal(state.started.length, 0);
  assert.equal(state.recorder.restrictedTarget, null);
  assert.ok(state.track.stopped && state.audio.stopped);
  assert.ok(state.targets.every(target => target.style.isolation === 'auto'));
});

test('failed Space restriction never starts a whole-tab recording', async () => {
  const state = navigationSetup({ failRestriction: true });
  await state.recorder.start();
  assert.equal(state.recorder.state, 'idle');
  assert.match(state.recorder.message, /could not frame this Space/);
  assert.equal(state.started.length, 0);
  assert.equal(state.recorder.restrictedTarget, null);
  assert.ok(state.track.stopped && state.audio.stopped);
  assert.equal(state.first.style.isolation, 'auto');
});
