const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/SpacePresentation.js'), 'utf8');
const attribute = 'data-ss-presentation';

class Element {
  constructor(tag = 'div', attributes = {}, text = '') {
    this.tagName = tag; this.attributes = { ...attributes }; this.text = text;
    this.children = []; this.parentElement = null;
    const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
    this.classList = { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) };
  }
  get isConnected() { return this.root === true || !!this.parentElement?.isConnected; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...elements) { for (const element of elements) { element.remove(); this.children.push(element); element.parentElement = this; } return this; }
  remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      if (part.startsWith('.')) return this.classList.contains(part.slice(1));
      if (part.startsWith('#')) return this.getAttribute('id') === part.slice(1);
      if (/^[a-z][a-z0-9]*$/.test(part)) return part === this.tagName;
      const match = /^\[([^=\]^]+)(\^?=)?(?:"([^"]*)")?\]$/.exec(part);
      if (!match || !this.hasAttribute(match[1])) return false;
      return !match[2] || (match[2] === '=' ? this.getAttribute(match[1]) === match[3] : this.getAttribute(match[1]).startsWith(match[3]));
    });
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
}

function setup(pathname = '/i/spaces/test123/peek', search = '') {
  const document = new Element('document'); document.root = true;
  const timers = new Map(), observers = [], events = [], listeners = new Map();
  let now = 0, nextTimer = 0;
  const location = { pathname, search };
  const context = vm.createContext({
    document, location, URLSearchParams, Promise, Event,
    window: { addEventListener(name, callback) { listeners.set(name, callback); }, dispatchEvent(event) { events.push(event.type); listeners.get(event.type)?.(event); } },
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  function tick(duration) {
    const until = now + duration;
    let count = 0;
    while (true) {
      const entry = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      assert(++count < 10000, 'timer work must stay bounded');
      now = entry[1].at; timers.delete(entry[0]); entry[1].callback();
    }
    now = until;
  }
  function sheet({ title = true, avatar = true, join = true, label = 'Space', persistent = false } = {}) {
    const element = new Element('div', { 'data-testid': 'sheetDialog', 'aria-label': label });
    if (persistent) element.setAttribute('data-ss-persistent', 'true');
    if (title) element.append(new Element('h2', { 'data-testid': 'tweetText' }, 'Test conversation'));
    if (avatar) element.append(new Element('div', { 'data-testid': 'UserAvatar-Container-test' }));
    if (join) element.append(new Element('button', {}, 'Start listening'));
    document.append(element);
    return element;
  }
  return { document, location, timers, events, api: context.SpaceCastPresentation, sheet, tick,
    flush() { for (const observer of observers) observer(); } };
}

test('opening is hidden before avatars arrive, then revealed when presentation is ready', () => {
  const state = setup();
  const sheet = state.sheet({ avatar: false, join: false });
  state.flush();
  assert.equal(sheet.getAttribute(attribute), 'opening');
  state.api.ready(sheet);
  assert.equal(sheet.getAttribute(attribute), null);
  state.flush();
  assert.equal(sheet.getAttribute(attribute), null, 'a ready node is not hidden repeatedly');
  assert.equal(state.timers.size, 0);
});

test('a clearly identified preview before pushState remains hidden through the URL-only route update', () => {
  const state = setup('/home');
  const sheet = state.sheet();
  state.flush();
  assert.equal(sheet.getAttribute(attribute), 'opening');
  state.location.pathname = '/i/spaces/test123/peek';
  state.tick(50);
  assert.equal(sheet.getAttribute(attribute), 'opening');
  assert.deepEqual(state.events, ['spacecast:presentationsync']);
  state.api.ready(sheet);
  assert.equal(state.timers.size, 0, 'route polling ends as soon as opening finishes');
});

test('an explicitly labeled Space with a Join action is held before its title and route arrive', () => {
  const state = setup('/home');
  const sheet = state.sheet({ title: false, avatar: false });
  state.flush();
  assert.equal(sheet.getAttribute(attribute), 'opening');
  state.tick(150);
  state.location.pathname = '/i/spaces/test123/peek';
  state.tick(50);
  assert.equal(sheet.getAttribute(attribute), 'opening');
  sheet.append(new Element('h2', { 'data-testid': 'tweetText' }, 'A delayed title'));
  state.flush(); state.api.ready(sheet);
  assert.equal(sheet.getAttribute(attribute), null);
  assert.equal(state.timers.size, 0);
});

test('ordinary article sheets and Share/report dialogs are never held', () => {
  const state = setup('/home');
  const article = state.sheet({ avatar: false, join: false, label: 'Article' });
  const share = state.sheet({ label: 'Share this Space' });
  const report = state.sheet({ label: 'Report Space' });
  const unlabelledShare = state.sheet({ label: '' });
  unlabelledShare.append(new Element('h2', {}, 'Share this Space'));
  state.flush();
  for (const sheet of [article, share, report, unlabelledShare]) assert.equal(sheet.getAttribute(attribute), null);
  state.location.pathname = '/i/spaces/test123/peek';
  article.remove(); state.flush();
  assert.equal(share.getAttribute(attribute), null);
  assert.equal(report.getAttribute(attribute), null);
  assert.equal(unlabelledShare.getAttribute(attribute), null);
  assert.equal(state.timers.size, 0);
});

test('full native routes, native mode, persistent windows and native managers are excluded', () => {
  for (const [pathname, search] of [['/i/spaces/test123', ''], ['/i/spaces/test123/peek', '?spacecast=native']]) {
    const state = setup(pathname, search);
    const sheet = state.sheet(); state.flush();
    assert.equal(sheet.getAttribute(attribute), null);
    assert.equal(state.api.prepare(sheet), false);
  }
  const state = setup();
  const persistent = state.sheet({ persistent: true });
  const manager = state.sheet(); manager.append(new Element('button', {}, 'Leave'));
  state.flush();
  assert.equal(persistent.getAttribute(attribute), null);
  assert.equal(manager.getAttribute(attribute), null);
  assert.equal(state.timers.size, 0);
});

test('a native manager elsewhere does not prevent a different paused preview from appearing', () => {
  const state = setup();
  state.document.append(new Element('button', { 'aria-label': 'Manage Space' }));
  const sheet = state.sheet(); state.flush();
  assert.equal(sheet.getAttribute(attribute), 'opening');
  state.api.ready(sheet);
  assert.equal(sheet.getAttribute(attribute), null);
});

test('opening failure is bounded and mutations cannot indefinitely renew its timeout', () => {
  const state = setup();
  const sheet = state.sheet(); state.flush();
  state.tick(1000); state.flush();
  state.tick(500);
  assert.equal(sheet.getAttribute(attribute), null);
  state.flush(); state.tick(3000);
  assert.equal(sheet.getAttribute(attribute), null);
  assert.equal(state.timers.size, 0);
});

test('failed readiness also reveals native controls and terminates opening work', async () => {
  const state = setup();
  const sheet = state.sheet(); state.flush();
  state.api.ready(sheet, Promise.reject(new Error('appearance unavailable')));
  await Promise.resolve();
  assert.equal(sheet.getAttribute(attribute), null);
  assert.equal(state.timers.size, 0);
});

test('dismissal hides the whole window and only previously owned empty portal decorations', () => {
  const state = setup();
  const sheet = state.sheet(); state.flush(); state.api.ready(sheet);
  const backdrop = new Element('div', { class: 'ss-overlay-backdrop' });
  const focus = new Element('div', { class: 'ss-focus-guard' });
  const otherDialog = new Element('div', { class: 'ss-overlay-backdrop' }, 'Share this Space');
  const ordinaryMask = new Element('div', { 'data-testid': 'mask' });
  state.document.append(backdrop, focus, otherDialog, ordinaryMask);
  state.api.dismiss(sheet);
  for (const element of [sheet, backdrop, focus]) assert.equal(element.getAttribute(attribute), 'closing');
  for (const element of [otherDialog, ordinaryMask]) assert.equal(element.getAttribute(attribute), null);
  backdrop.classList.remove('ss-overlay-backdrop');
  focus.classList.remove('ss-focus-guard');
  state.location.pathname = '/home'; state.flush();
  state.api.release(sheet);
  assert.equal(sheet.getAttribute(attribute), 'closing', 'URL changes and intentional decline cannot reveal the closing template');
  sheet.remove(); state.flush();
  for (const element of [sheet, backdrop, focus]) assert.equal(element.getAttribute(attribute), null);
  assert.equal(state.timers.size, 0);
});

test('delayed appearance completion cannot reveal a dismissed window', async () => {
  const state = setup();
  const sheet = state.sheet(); state.flush();
  let resolve;
  state.api.ready(sheet, new Promise(callback => { resolve = callback; }));
  state.api.dismiss(sheet);
  resolve(); await Promise.resolve();
  assert.equal(sheet.getAttribute(attribute), 'closing');
});

test('an explicit new owner can claim a reused closing sheet without stale readiness revealing it', async () => {
  const state = setup();
  const sheet = state.sheet(); state.flush();
  let resolve;
  state.api.ready(sheet, new Promise(callback => { resolve = callback; }));
  state.api.dismiss(sheet);
  state.location.pathname = '/i/spaces/second456/peek';
  state.api.prepare(sheet);
  assert.equal(sheet.getAttribute(attribute), 'opening');
  resolve(); await Promise.resolve();
  assert.equal(sheet.getAttribute(attribute), 'opening');
  state.api.ready(sheet);
  assert.equal(sheet.getAttribute(attribute), null);
});

test('failed native dismissal eventually releases the sheet and stops all work', () => {
  const state = setup();
  const sheet = state.sheet(); state.flush(); state.api.ready(sheet);
  state.api.dismiss(sheet); state.tick(1999);
  assert.equal(sheet.getAttribute(attribute), 'closing');
  state.tick(1); state.flush();
  assert.equal(sheet.getAttribute(attribute), null);
  assert.equal(state.timers.size, 0);
});

test('a long recording save can renew the dismissal veil immediately before cleanup', () => {
  const state = setup();
  const sheet = state.sheet(); state.flush(); state.api.ready(sheet);
  state.api.dismiss(sheet); state.tick(2000);
  state.api.dismiss(sheet); state.tick(500);
  assert.equal(sheet.getAttribute(attribute), 'closing');
  state.tick(1500);
  assert.equal(sheet.getAttribute(attribute), null);
});

test('repurposing a closing sheet as native controls releases it without waiting', () => {
  const state = setup();
  const sheet = state.sheet(); state.flush(); state.api.ready(sheet);
  state.api.dismiss(sheet);
  sheet.append(new Element('button', { 'aria-label': 'Leave' }));
  state.flush();
  assert.equal(sheet.getAttribute(attribute), null);
  assert.equal(state.timers.size, 0);
});

test('detached sheets are cleaned and can be presented on a later reopen', () => {
  const state = setup();
  const sheet = state.sheet(); state.flush();
  sheet.remove(); state.flush();
  assert.equal(sheet.getAttribute(attribute), null);
  assert.equal(state.timers.size, 0);
  state.document.append(sheet); state.flush();
  assert.equal(sheet.getAttribute(attribute), 'opening');
});

test('presentation CSS hides native paint and hit targets while preserving measurable layout', () => {
  const css = fs.readFileSync(path.join(__dirname, '../css/transitions.css'), 'utf8');
  assert.match(css, /opacity:\s*0\s*!important/);
  assert.match(css, /visibility:\s*hidden\s*!important/);
  assert.match(css, /pointer-events:\s*none\s*!important/);
  assert.match(css, /transition:\s*none\s*!important/);
  assert.doesNotMatch(css, /display:\s*none/);
});
