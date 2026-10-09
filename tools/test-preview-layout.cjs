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

test('anonymous listening keeps the same native action and footer through label changes', () => {
  const state = fixture();
  const handler = state.join.onclick = () => 'native';
  const notice = state.footer.firstElementChild;
  notice.append(el('a', { href: 'https://help.x.com/en/using-x/spaces' }, 'Learn more'));
  const toggle = el('button', { role: 'switch', 'aria-label': 'Listen anonymously', 'aria-checked': 'true' });
  const anonymous = el().append(el('span', {}, 'Listen anonymously'), toggle);
  state.details.append(anonymous);
  for (const label of ['Start listening anonymously', 'Start listening', 'Start listening anonymously']) {
    state.join.text = label;
    state.join.setAttribute('aria-label', label);
    state.layout.refresh();
    assert.equal(has(state.join, 'ss-native-listen'), true);
    assert.equal(has(state.footer, 'ss-native-footer'), true);
    assert.equal(has(notice, 'ss-notice'), true);
    assert.equal(has(state.footer, 'ss-people-wrap'), false);
    assert.equal(has(anonymous, 'ss-anonymous'), true);
    assert.equal(has(toggle, 'ss-native-listen'), false);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal(state.join.onclick, handler);
    mutations = 0;
    state.layout.refresh();
    assert.equal(mutations, 0);
  }
});

test('anonymous role buttons preserve disabled and hidden state without broadening action matching', () => {
  const state = fixture();
  const join = el('div', { role: 'button', disabled: '', 'aria-disabled': 'true', hidden: '' }, 'Start listening anonymously');
  state.details.replaceChildren(join);
  state.layout.refresh();
  assert.equal(has(join, 'ss-native-listen'), true);
  assert.equal(has(join, 'ss-native-footer'), true);
  for (const [name, value] of Object.entries({ disabled: '', 'aria-disabled': 'true', hidden: '' })) {
    assert.equal(join.getAttribute(name), value);
  }
  for (const text of ['Listen anonymously', 'Stop listening anonymously', 'Start listening anonymously later', 'Leave']) {
    assert.equal(context.Layout.isJoinControl(el('button', {}, text)), false);
  }
});

function nativeAnonymous() {
  const toggle = el('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Listen anonymously' });
  toggle.checked = true;
  const track = el(), thumb = el();
  const surface = el('div', { style: 'height:20px;width:40px' }).append(track, thumb, toggle);
  const label = el('div', {}, 'Listen anonymously');
  const row = el().append(label, surface);
  return { toggle, track, thumb, surface, label, row, section: el().append(row) };
}

test('native checkbox uses exactly its own surface and sibling artwork without changing its state or label', () => {
  const state = fixture();
  const anonymous = nativeAnonymous();
  const handler = anonymous.toggle.onchange = () => 'native-toggle';
  state.details.append(anonymous.section);
  state.layout.refresh();
  assert.equal(has(anonymous.surface, 'ss-anonymous-switch'), true);
  assert.equal(has(anonymous.toggle, 'ss-anonymous-input'), true);
  assert.equal(has(anonymous.toggle, 'ss-anonymous-switch'), false);
  assert.equal(has(anonymous.track, 'ss-anonymous-artwork'), true);
  assert.equal(has(anonymous.thumb, 'ss-anonymous-artwork'), true);
  assert.equal(has(anonymous.label, 'ss-anonymous-artwork'), false);
  assert.equal(has(anonymous.row, 'ss-anonymous-row'), true);
  assert.equal(has(anonymous.section, 'ss-anonymous-wrap'), true);
  assert.equal(anonymous.toggle.parentElement, anonymous.surface);
  assert.equal(anonymous.toggle.checked, true);
  assert.equal(anonymous.toggle.getAttribute('aria-checked'), null);
  assert.equal(anonymous.toggle.onchange, handler);
  mutations = 0;
  state.layout.refresh();
  assert.equal(mutations, 0);
  state.layout.dispose();
  assert.equal(has(anonymous.track, 'ss-anonymous-artwork'), false);
  assert.equal(has(anonymous.surface, 'ss-anonymous-switch'), false);
});

test('two native actions preserve order, wrappers, handlers, and disabled or hidden states', () => {
  const state = fixture();
  const anonymous = el('button', { 'aria-label': 'Start listening anonymously' }, 'Start listening anonymously');
  const speaker = el('button', { 'aria-label': 'Start speaking', 'aria-disabled': 'true', disabled: '' }, 'Start speaking');
  const anonymousHandler = anonymous.onclick = () => 'anonymous';
  const speakerHandler = speaker.onclick = () => 'speaker';
  const firstWrap = el().append(anonymous);
  const secondWrap = el('div', { hidden: '', style: 'display: none;' }).append(speaker);
  const actions = el().append(firstWrap, secondWrap);
  const notice = el('p', {}, 'Choose how to join');
  state.footer.replaceChildren(notice, actions);
  state.layout.refresh();
  for (const node of [actions, firstWrap, secondWrap]) assert.equal(has(node, 'ss-native-actions'), true);
  for (const node of [anonymous, speaker]) assert.equal(has(node, 'ss-native-listen'), true);
  assert.equal(has(notice, 'ss-notice'), true);
  assert.equal(anonymous.parentElement, firstWrap);
  assert.equal(speaker.parentElement, secondWrap);
  assert.equal(actions.children[0], firstWrap);
  assert.equal(actions.children[1], secondWrap);
  assert.equal(anonymous.onclick, anonymousHandler);
  assert.equal(speaker.onclick, speakerHandler);
  assert.equal(secondWrap.getAttribute('hidden'), '');
  assert.equal(secondWrap.getAttribute('style'), 'display: none;');
  assert.equal(speaker.getAttribute('disabled'), '');
  assert.equal(speaker.getAttribute('aria-disabled'), 'true');
});

test('a shared toggle and action footer keeps its row and explanatory copy distinct', () => {
  const state = fixture();
  const anonymous = nativeAnonymous();
  const speaker = el('button', {}, 'Start speaking');
  const notice = el('p', {}, 'Your mic will be off');
  state.footer.replaceChildren(anonymous.section, notice, state.join, speaker);
  state.layout.refresh();
  assert.equal(has(anonymous.row, 'ss-anonymous-row'), true);
  assert.equal(has(state.footer, 'ss-anonymous-row'), false);
  assert.equal(has(anonymous.section, 'ss-notice'), false);
  assert.equal(has(notice, 'ss-notice'), true);
  assert.equal(has(state.join, 'ss-native-listen'), true);
  assert.equal(has(speaker, 'ss-native-listen'), true);
  assert.equal(state.join.nextElementSibling, speaker);
});

test('a direct native action never classifies its own label artwork as explanatory copy', () => {
  const state = fixture();
  const label = el('div').append(el('span', {}, 'Start listening anonymously'));
  const join = el('button', { 'aria-label': 'Start listening anonymously' }).append(label);
  state.details.replaceChildren(join);
  state.layout.refresh();
  assert.equal(has(join, 'ss-native-listen'), true);
  assert.equal(has(label, 'ss-notice'), false);
});

test('switch art tagging never hides a sibling label or another native input', () => {
  const state = fixture();
  const label = el('span', {}, 'Listen anonymously');
  const toggle = el('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Listen anonymously' });
  const other = el('input', { type: 'checkbox' });
  const section = el().append(label, toggle, other);
  state.details.append(section);
  state.layout.refresh();
  assert.equal(has(label, 'ss-anonymous-artwork'), false);
  assert.equal(has(other, 'ss-anonymous-artwork'), false);
  assert.equal(has(section, 'ss-anonymous-switch'), false);
  assert.equal(has(toggle, 'ss-anonymous-switch'), true);
});
