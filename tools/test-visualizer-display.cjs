const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const frames = new Map();
  let sequence = 0;
  let reads = 0;
  const context = vm.createContext({
    document: { hidden: false }, window: { devicePixelRatio: 1 },
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/Visualizer.js'), 'utf8') + '\nglobalThis.Visualizer = AudioVisualizer;', context);
  const visualizer = Object.create(context.Visualizer.prototype);
  const graph = { close() { throw new Error('Graphics settings must not close the audio graph'); } };
  Object.assign(visualizer, {
    context: graph, frame: 0, renderEnabled: true, reducedMotion: false,
    canvas: { isConnected: true, clientWidth: 100, width: 100, height: 80, getContext() { return { setTransform() {}, clearRect() {} }; } },
    analyser: { getByteFrequencyData() { reads++; }, getByteTimeDomainData() {} },
    paintSpectrum() {}, paintWave() {},
  });
  return { visualizer, frames, graph, reads: () => reads };
}

test('Hiding spectrum cancels painting while leaving audio connected; showing restarts it', () => {
  const { visualizer, frames, graph, reads } = setup();
  visualizer.draw();
  assert.equal(frames.size, 1);
  visualizer.setDisplayOptions({ spectrum: false });
  assert.equal(frames.size, 0);
  assert.equal(reads(), 1);
  assert.equal(visualizer.context, graph);
  visualizer.setDisplayOptions({ spectrum: true });
  assert.equal(frames.size, 1);
  assert.equal(reads(), 2);
});

test('Reduced motion paints one still frame and resumes normally when disabled', () => {
  const { visualizer, frames, reads } = setup();
  visualizer.setDisplayOptions({ reducedMotion: true });
  assert.equal(reads(), 1);
  assert.equal(frames.size, 0);
  visualizer.setDisplayOptions({ reducedMotion: false });
  assert.equal(frames.size, 1);
  assert.equal(reads(), 2);
});

test('A minimized zero-width spectrum skips analysis and canvas work', () => {
  const { visualizer, reads } = setup();
  visualizer.canvas.clientWidth = 0;
  visualizer.draw();
  assert.equal(reads(), 0);
});

test('Temporary DOM detachment pauses painting without closing playback', () => {
  const { visualizer, frames, graph, reads } = setup();
  visualizer.canvas.isConnected = false;
  visualizer.draw();
  assert.equal(reads(), 0);
  assert.equal(visualizer.context, graph);
  assert.equal(frames.size, 1);
  const resumeDrawing = frames.values().next().value;
  frames.clear();
  visualizer.canvas.isConnected = true;
  resumeDrawing();
  assert.equal(reads(), 1);
  assert.equal(visualizer.context, graph);
});

function audioSetup({ connectionFails = false } = {}) {
  const connections = [];
  let sources = 0, closes = 0, resumes = 0, resume;
  const destination = {};
  const graph = {
    state: 'suspended', destination,
    resume() {
      resumes++;
      return new Promise(resolve => { resume = () => { this.state = 'running'; resolve(); }; });
    },
    close() { closes++; this.state = 'closed'; return Promise.resolve(); },
    createAnalyser() {
      return { frequencyBinCount: 1024, connect() { if (connectionFails) throw new Error('Processing connection failed'); } };
    },
    createMediaElementSource() {
      sources++;
      if (sources > 1) throw new Error('The audio element already has a media source');
      return { connect(target) { connections.push(target); }, disconnect() { connections.length = 0; } };
    },
  };
  const context = vm.createContext({
    AudioContext: function () { return graph; },
    document: { createElement() { return { style: {}, setAttribute() {} }; } },
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    console: { warn() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/Visualizer.js'), 'utf8') + '\nglobalThis.Visualizer = AudioVisualizer;', context);
  const visualizer = new context.Visualizer({});
  visualizer.draw = () => {};
  return { visualizer, graph, connections, resume: () => resume(), sources: () => sources, closes: () => closes, resumes: () => resumes };
}

test('Concurrent playback events create a single media source after user activation', async () => {
  const fixture = audioSetup();
  const pending = [fixture.visualizer.attach(), fixture.visualizer.attach(), fixture.visualizer.attach()];
  fixture.resume();
  await Promise.all(pending);
  assert.equal(fixture.resumes(), 1);
  assert.equal(fixture.sources(), 1);
  assert.equal(fixture.visualizer.failed, false);
  assert.ok(fixture.visualizer.analyser);
});

test('Closing while audio activation is pending cannot attach a retired player', async () => {
  const fixture = audioSetup();
  const pending = fixture.visualizer.attach();
  fixture.visualizer.dispose();
  fixture.resume();
  await pending;
  await fixture.visualizer.attach();
  fixture.visualizer.dispose();
  assert.equal(fixture.sources(), 0);
  assert.equal(fixture.closes(), 1);
  assert.equal(fixture.visualizer.context, null);
});

test('Processing failures retain a direct playback route', async () => {
  const fixture = audioSetup({ connectionFails: true });
  const pending = fixture.visualizer.attach();
  fixture.resume();
  await pending;
  assert.equal(fixture.sources(), 1);
  assert.equal(fixture.closes(), 0);
  assert.deepEqual(fixture.connections, [fixture.graph.destination]);
});
