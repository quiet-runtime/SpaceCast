const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small DOM model exercises reconciliation and mutation counts without a runtime dependency.
let mutations = 0;
class Element {
  constructor(tag, attributes = {}, text = '') {
    this.tagName = tag.toUpperCase(); this.attributes = { ...attributes }; this.children = [];
    this.parentElement = null; this.isConnected = true; this.text = text;
    const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
    this.classList = {
      contains: name => classes.has(name),
      add(name) { if (!classes.has(name)) { classes.add(name); mutations++; } },
      remove(name) { if (classes.delete(name)) mutations++; },
    };
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get nextElementSibling() {
    return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { if (this.attributes[name] !== value) { this.attributes[name] = value; mutations++; } }
  removeAttribute(name) { if (Object.hasOwn(this.attributes, name)) { delete this.attributes[name]; mutations++; } }
  append(...children) {
    for (const child of children) { child.remove(); this.children.push(child); child.parentElement = this; mutations++; }
    return this;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null; mutations++;
  }
  after(element) {
    const parent = this.parentElement;
    element.remove();
    parent.children.splice(parent.children.indexOf(this) + 1, 0, element);
    element.parentElement = parent; mutations++;
  }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      const tag = /^[A-Za-z][\w-]*/.exec(part)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const attribute = /\[([^\]^=]+)(\^?=)?(?:"([^"]*)")?\]/.exec(part);
      if (attribute) {
        const actual = this.getAttribute(attribute[1]);
        if (actual === null) return false;
        if (attribute[2] === '=' && actual !== attribute[3]) return false;
        if (attribute[2] === '^=' && !actual.startsWith(attribute[3])) return false;
      }
      return true;
    });
  }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) { if (child.matches(selector)) found.push(child); found.push(...child.querySelectorAll(selector)); }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
}
const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/SpacePreviewLayout.js'), 'utf8') + '\nglobalThis.Layout = SpacePreviewLayout;', context);
const el = (tag = 'div', attrs = {}, text = '') => new Element(tag, attrs, text);
const has = (element, name) => element.classList.contains(name);
function participant(name = 'Person') {
  const profile = el('a', { href: '/person' }).append(el('img', { src: 'https://example.com/avatar.png' }));
  return el().append(el().append(profile), el('div', {}, name), el('div', {}, 'Host'));
}
function fixture() {
  const close = el('button', { 'aria-label': 'Close' }, '×');
  const toolbar = el().append(el().append(close), el().append(el('button', { 'aria-label': 'Share' }, 'Share')));
  const title = el('div', { dir: 'rtl', 'data-testid': 'tweetText' }, 'عنوان فارسی');
  const recorded = el('span', {}, '● REC');
  const heading = el().append(recorded, title);
  const join = el('button', { 'aria-label': 'Start listening' }, 'Start listening');
  const footer = el().append(el('p', {}, 'Your mic will be off'), join);
  const people = el().append(participant());
  const details = el().append(el().append(people), el('div', {}, '5 other listeners'), footer);
  const body = el().append(el(), toolbar, heading, details);
  const sheet = el().append(body);
  const panel = el('div', { id: 'spacecast-panel' });
  const layout = new context.Layout(sheet, panel);
  return { sheet, body, toolbar, heading, title, recorded, details, footer, join, close, panel, people, layout };
}

test('refresh preserves the original join handler and RTL title, and causes no repeated DOM mutations', () => {
  const state = fixture();
  const handler = state.join.onclick = () => 'native';
  assert.equal(state.layout.closeButton, state.close);
  assert.equal(state.heading.nextElementSibling, state.panel);
  assert.equal(state.title.getAttribute('dir'), 'auto');
  assert.equal(has(state.recorded, 'ss-sheet-rec'), true);
  assert.equal(has(state.join, 'ss-native-listen'), true);
  assert.equal(has(state.people, 'ss-people'), true);
  assert.equal(has(state.people.firstElementChild, 'ss-person'), true);
  mutations = 0;
  state.layout.refresh(); state.layout.refresh();
  assert.equal(mutations, 0);
  assert.equal(state.join.onclick, handler);
});

test('a delayed replacement details tree retains its own disabled Join and overrides footer profile links', () => {
  const state = fixture();
  const join = el('button', { 'aria-label': 'Start speaking', disabled: '', 'aria-disabled': 'true' }, 'Start speaking');
  const help = el('a', { href: '/SupportAccount' }, 'Ask for help').append(el('svg'));
  const footer = el().append(el('p', {}, 'You are already in a Space.').append(help), join);
  const replacement = el().append(footer);
  state.details.after(replacement); state.details.remove();
  state.layout.refresh();
  assert.equal(state.layout.details, replacement);
  assert.equal(has(state.details, 'ss-native-details'), false);
  assert.equal(has(replacement, 'ss-native-details'), true);
  assert.equal(has(footer, 'ss-native-footer'), true);
  assert.equal(has(footer, 'ss-people-wrap'), false);
  assert.equal(join.getAttribute('disabled'), '');
  assert.equal(join.getAttribute('aria-disabled'), 'true');
  assert.equal(has(join, 'ss-native-listen'), true);
  assert.equal(state.heading.nextElementSibling, state.panel);
});

test('a multi-participant grid is never mistaken for a single participant card', () => {
  const state = fixture();
  const cards = [state.people.firstElementChild, participant('Second'), participant('Third')];
  state.people.append(...cards.slice(1));
  state.layout.refresh();
  assert.equal(has(state.people, 'ss-people'), true);
  assert.equal(has(state.people, 'ss-person'), false);
  for (const card of cards) {
    assert.equal(has(card, 'ss-person'), true);
    assert.equal(has(card.children[0], 'ss-person-avatar'), true);
    assert.equal(has(card.children[1], 'ss-person-name'), true);
  }
});

test('a reused loading node changes roles cleanly when Join arrives as a direct child or role button', () => {
  const state = fixture();
  const loading = el('div', {}, 'Loading');
  state.details.replaceChildren(loading);
  state.layout.refresh();
  assert.equal(has(loading, 'ss-listeners'), true);
  const join = el('div', { role: 'button', 'aria-label': 'Join Space' }, 'Join Space');
  loading.append(join);
  state.layout.refresh();
  assert.equal(has(loading, 'ss-listeners'), false);
  assert.equal(has(loading, 'ss-native-footer'), true);
  state.details.replaceChildren(join);
  state.layout.refresh();
  assert.equal(has(join, 'ss-native-footer'), true);
  assert.equal(has(join, 'ss-native-listen'), true);
});

test('Leave, unrelated controls and ordinary profile text never become Join or participant controls', () => {
  const state = fixture();
  const leave = el('button', { 'aria-label': 'Leave' }, 'Leave');
  const notice = el().append(el('a', { href: '/help' }, 'Help'), el('a', { href: '/person' }, 'About the host'));
  state.details.replaceChildren(leave, notice);
  state.layout.refresh();
  assert.equal(has(leave, 'ss-native-listen'), false);
  assert.equal(has(leave, 'ss-native-footer'), false);
  assert.equal(has(notice, 'ss-people-wrap'), false);
});

test('presentation-only layout is supported and dispose restores only owned attributes and classes', () => {
  const state = fixture();
  state.layout.dispose(); state.panel.remove();
  state.body.classList.add('ss-sheet-body');
  const layout = new context.Layout(state.sheet);
  assert.equal(has(state.join, 'ss-native-listen'), true);
  state.join.setAttribute('disabled', '');
  layout.dispose(); layout.dispose();
  assert.equal(has(state.body, 'ss-sheet-body'), true);
  assert.equal(has(state.join, 'ss-native-listen'), false);
  assert.equal(state.title.getAttribute('dir'), 'rtl');
  assert.equal(state.join.getAttribute('disabled'), '');
});

test('a nested native heading and controls keep their original parents and title direction', () => {
  const state = fixture();
  state.layout.dispose(); state.panel.remove(); state.heading.remove(); state.details.remove();
  const title = el('h2', { dir: 'rtl' }, 'عنوان');
  const section = el().append(title, state.people, state.footer);
  state.body.append(section);
  const layout = new context.Layout(state.sheet, state.panel);
  assert.equal(layout.heading, section);
  assert.equal(layout.details, section);
  assert.equal(has(section, 'ss-native-section'), true);
  assert.equal(has(title, 'ss-sheet-title'), true);
  assert.equal(title.getAttribute('dir'), 'auto');
  assert.equal(title.nextElementSibling, state.panel);
  assert.equal(state.footer.parentElement, section);
  assert.equal(has(state.join, 'ss-native-listen'), true);
  mutations = 0;
  layout.refresh();
  assert.equal(mutations, 0);
});

test('an incomplete native tree clears stale anchors until X mounts its replacement body', () => {
  const state = fixture();
  state.body.remove();
  state.layout.refresh();
  assert.equal(state.layout.body, null);
  assert.equal(state.layout.heading, null);
  assert.equal(state.layout.closeButton, null);
  assert.equal(state.layout.details, null);
});
