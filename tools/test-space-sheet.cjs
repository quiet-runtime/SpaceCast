const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(attributes = {}) {
    this.attributes = { ...attributes }; this.children = []; this.textContent = '';
    this.isConnected = true; this.parentElement = null; this.tabIndex = -1;
    this.bounds = { width: 1200, height: 800 };
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  querySelector() { return null; }
  getBoundingClientRect() { return this.bounds; }
  getClientRects() { return [this.bounds]; }
}

function setup() {
  const sheet = new Element({ role: 'dialog', 'aria-modal': 'true' });
  const main = new Element({ inert: '', 'aria-hidden': 'true' });
  const html = new Element();
  const dialogs = [sheet];
  const context = vm.createContext({
    window: { innerWidth: 1200, innerHeight: 800 },
    getComputedStyle: () => ({ visibility: 'visible' }),
    document: {
      documentElement: html,
      body: new Element(),
      querySelectorAll: selector => selector.includes('main') ? [main] : dialogs,
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/SpaceSheet.js'), 'utf8') + '\nglobalThis.Sheet = SpaceSheet;', context);
  const controller = Object.create(context.Sheet.prototype);
  Object.assign(controller, { sheet, records: [], disposed: false, hadSheetClass: false });
  sheet.classList.add('ss-sheet');
  controller.refresh();
  return { controller, sheet, main, html, dialogs };
}

test('native close does not restore obsolete background inert or aria-hidden locks', () => {
  const { controller, sheet, main, html } = setup();
  assert.equal(main.hasAttribute('inert'), false);
  assert.equal(main.getAttribute('aria-hidden'), null);
  assert.equal(html.classList.contains('ss-page-unlocked'), true);
  sheet.isConnected = false;
  controller.dispose();
  assert.equal(main.hasAttribute('inert'), false);
  assert.equal(main.getAttribute('aria-hidden'), null);
  assert.equal(html.classList.contains('ss-page-unlocked'), false);
  assert.equal(sheet.classList.contains('ss-sheet'), false);
  assert.equal(controller.records.length, 0);
});

test('suspension while the native sheet is alive restores its background locks', () => {
  const { controller, main, html } = setup();
  controller.restoreLocks();
  assert.equal(main.hasAttribute('inert'), true);
  assert.equal(main.getAttribute('aria-hidden'), 'true');
  assert.equal(html.classList.contains('ss-page-unlocked'), false);
});

test('cleanup preserves newer native accessibility state instead of overwriting it', () => {
  const { controller, sheet, main } = setup();
  main.setAttribute('aria-hidden', 'false');
  main.setAttribute('inert', '');
  sheet.isConnected = false;
  controller.dispose();
  assert.equal(main.getAttribute('aria-hidden'), 'false');
  assert.equal(main.hasAttribute('inert'), true);
});

test('empty native masked dialog is exempt, but contentful zero-height Share stays modal', () => {
  const { controller, dialogs } = setup();
  const stub = new Element({ role: 'dialog', 'aria-modal': 'true' });
  const mask = new Element({ 'data-testid': 'mask' });
  stub.parentElement = new Element(); stub.parentElement.children = [stub, mask];
  dialogs.push(stub);
  assert.equal(controller.backdropMask(stub), mask);
  assert.equal(controller.hasOtherModal(), false);
  const share = new Element({ role: 'dialog' });
  share.bounds = { width: 500, height: 0 }; share.children.push(new Element());
  dialogs.push(share);
  assert.equal(controller.hasOtherModal(), true);
});
