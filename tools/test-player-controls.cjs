const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element extends EventTarget {
  constructor() {
    super(); this.children = []; this.attributes = {}; this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.textContent = ''; this.disabled = false;
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = children; }
  remove() { this.removed = true; }
}
const context = vm.createContext({ document: { createElement: () => new Element(), createElementNS: () => new Element() } });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/PlayerControls.js'), 'utf8') + '\nglobalThis.Controls = SpacePlayerControls;', context);
const ranges = entries => ({ length: entries.length, start: i => entries[i][0], end: i => entries[i][1] });
function setup(entries = [], extras = {}) {
  const audio = new Element();
  Object.assign(audio, { volume: 1, muted: false, paused: true, ended: false, readyState: entries.length ? 2 : 0, currentTime: 0, duration: Infinity, seekable: ranges(entries), buffered: ranges(entries), play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }, pause() { this.paused = true; this.dispatchEvent(new Event('pause')); } }, extras);
  return { audio, controls: new context.Controls(audio) };
}
const fire = (element, event) => element.dispatchEvent(new Event(event));

test('empty or nonfinite live streams do not expose invalid seek values', () => {
  const { audio, controls } = setup();
  assert.equal(controls.play.disabled, true);
  assert.equal(controls.seek.disabled, true);
  assert.equal(controls.seek.max, '1');
  audio.readyState = 1; audio.duration = 3600;
  fire(audio, 'loadedmetadata');
  assert.equal(controls.seek.disabled, true, 'duration alone must not invent a live DVR window');
  assert.equal(controls.duration.textContent, 'Waiting for audio');
  controls.dispose();
});

test('seek input clamps to moving DVR window and avoids discontinuity gaps', () => {
  const { audio, controls } = setup([[120, 150], [160, 180]], { currentTime: 135 });
  controls.seekTo(155);
  assert.equal(audio.currentTime, 160);
  audio.seekable = ranges([[170, 190]]);
  controls.seek.value = '125';
  fire(controls.seek, 'input');
  assert.equal(audio.currentTime, 170);
  assert.equal(controls.currentTime.textContent, '0:00');
  assert.equal(controls.seek.min, '170');
  controls.seekTo(Infinity);
  assert.equal(audio.currentTime, 170);
  controls.dispose();
});

test('skip and live controls operate on the media element and update playback state', async () => {
  const { audio, controls } = setup([[100, 200]], { currentTime: 125 });
  fire(controls.back, 'click'); assert.equal(audio.currentTime, 115);
  fire(controls.forward, 'click'); assert.equal(audio.currentTime, 125);
  fire(controls.liveButton, 'click');
  await new Promise(setImmediate);
  assert.equal(audio.currentTime, 197);
  assert.equal(audio.paused, false);
  assert.equal(controls.play.attributes['aria-label'], 'Pause');
  assert.equal(controls.element.dataset.atLive, 'true');
  fire(controls.play, 'click'); assert.equal(audio.paused, true);
  controls.dispose();
});

test('recordings have a finite duration fallback and no live action', () => {
  const { controls } = setup([], { readyState: 1, duration: 125, currentTime: 65 });
  controls.setState({ state: 'Ended' });
  assert.equal(controls.liveButton.hidden, true);
  assert.equal(controls.seek.disabled, false);
  assert.equal(controls.currentTime.textContent, '1:05');
  assert.equal(controls.duration.textContent, '2:05');
  controls.dispose();
});

test('volume and mute restore the last audible level', () => {
  const { audio, controls } = setup([[0, 100]], { volume: 0.65 });
  controls.volume.value = '0'; fire(controls.volume, 'input');
  assert.equal(audio.volume, 0);
  fire(controls.mute, 'click');
  assert.equal(audio.volume, 0.65);
  assert.equal(audio.muted, false);
  fire(controls.mute, 'click');
  assert.equal(audio.muted, true);
  assert.equal(controls.volume.attributes['aria-valuetext'], '0 percent');
  controls.dispose();
});

test('rejected playback is retryable and disposal detaches every control listener', async () => {
  const { audio, controls } = setup([[0, 100]], { play() { return Promise.reject(new Error('blocked')); } });
  await controls.togglePlayback();
  assert.match(controls.status.textContent, /Press play/);
  assert.equal(controls.play.disabled, false);
  controls.dispose();
  assert.equal(controls.listeners.length, 0);
  assert.equal(controls.element.removed, true);
  const time = audio.currentTime;
  fire(controls.forward, 'click');
  assert.equal(audio.currentTime, time);
  audio.currentTime = 10; fire(audio, 'timeupdate');
  assert.equal(controls.currentTime.textContent, '0:00');
});
