const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element extends EventTarget {
  constructor(tag = 'div') {
    super(); this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {};
    this.style = { setProperty(name, value) { this[name] = String(value); }, getPropertyValue(name) { return this[name] || ''; }, removeProperty(name) { delete this[name]; } };
    this.dataset = {}; this.width = 0; this.height = 0; this.className = '';
    this.classList = {
      add: name => { if (!this.className.split(' ').includes(name)) this.className += ' ' + name; },
      remove: name => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); },
      contains: name => this.className.split(' ').includes(name),
    };
  }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentElement = this; } }
  appendChild(node) { this.append(node); return node; }
  insertBefore(node, before) {
    const index = this.children.indexOf(before);
    if (index < 0) this.append(node);
    else { this.children.splice(index, 0, node); node.parentElement = this; }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector(selector) {
    return this.children.find(child => child.classList.contains(selector.slice(1))) || this.children.map(child => child.querySelector(selector)).find(Boolean) || null;
  }
  closest() {
    return ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(this.tagName) || this.getAttribute('role') === 'button' || this.getAttribute('contenteditable') === 'true'
      ? this : this.parentElement?.closest() || null;
  }
  getBoundingClientRect() { return { width: parseFloat(this.style['--ss-window-width']) || this.width, height: this.dataset.minimized === 'true' ? 48 : parseFloat(this.style['--ss-window-height']) || this.height, x: parseFloat(this.style.left) || 0, y: parseFloat(this.style.top) || 0 }; }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  releasePointerCapture() { this.capture = null; }
  remove() { this.removed = true; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
}
function setup({ saved, savedSize, storageBlocked = false } = {}) {
  const panel = new Element(); panel.width = 520; panel.height = 320;
  const header = new Element(); header.className = 'ss-brand-row';
  const brand = new Element(); brand.className = 'ss-brand';
  const badge = new Element(); badge.className = 'ss-state-badge';
  header.append(brand, badge);
  const content = new Element(); content.className = 'ss-window-content';
  panel.append(header, content);
  const window = new EventTarget(); window.innerWidth = 1200; window.innerHeight = 800;
  const storage = new Map(saved === undefined ? [] : [['spacecast.glass-window-position', saved]]);
  if (savedSize !== undefined) storage.set('spacecast.glass-window-size', savedSize);
  const frames = new Map(); let nextFrame = 0; let observer;
  const localStorage = {
    getItem(key) { if (storageBlocked) throw Error('blocked'); return storage.get(key) ?? null; },
    setItem(key, value) { if (storageBlocked) throw Error('blocked'); storage.set(key, value); },
  };
  const context = vm.createContext({
    document: { createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag) },
    window, localStorage, URL,
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { constructor(callback) { this.callback = callback; observer = this; } observe() {} disconnect() { this.disconnected = true; } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/GlassWindow.js'), 'utf8') + '\nglobalThis.GlassWindow = SpaceGlassWindow;', context);
  let closeCount = 0;
  const minimized = [];
  const shell = new context.GlassWindow(panel, { onClose: () => closeCount++, onMinimize: value => minimized.push(value) });
  const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
  return { shell, panel, header, content, storage, frames, window, observer, flush, minimized, context, closeCount: () => closeCount };
}
const input = (properties = {}) => ({ target: null, button: 0, pointerId: 1, clientX: 100, clientY: 100, preventDefault() { this.prevented = true; }, ...properties });

test('new window is non-modal, starts at the right, and accepts only X Space detail links', () => {
  const { shell, panel } = setup();
  assert.equal(panel.getAttribute('aria-modal'), 'false');
  assert.equal(panel.style.left, '656px'); assert.equal(panel.style.top, '96px');
  shell.setSpace({ title: 'بحث زنده', url: 'https://x.com/i/spaces/1AbC/peek?ignored=1' });
  assert.equal(shell.title.textContent, 'بحث زنده');
  assert.equal(shell.details.href, 'https://x.com/i/spaces/1AbC/peek?spacecast=native');
  assert.equal(shell.details.target, '_blank');
  shell.setSpace({ url: 'javascript:alert(1)' });
  assert.equal(shell.details.hidden, true);
  shell.dispose();
});

test('dragging is captured locally, clamps to the viewport and persists on release', () => {
  const { shell, panel, header, storage } = setup();
  shell.startDrag(input({ target: shell.title }));
  assert.equal(header.capture, 1); assert.equal(panel.style.userSelect, 'none');
  shell.moveDrag(input({ clientX: -900, clientY: 900 }));
  assert.equal(panel.style.left, '8px'); assert.equal(panel.style.top, '472px');
  shell.endDrag(input());
  assert.equal(header.capture, null); assert.equal(panel.dataset.dragging, undefined);
  assert.deepEqual(JSON.parse(storage.get('spacecast.glass-window-position')), { x: 8, y: 472 });
  shell.dispose();
});

test('header controls and unrelated pointers do not trigger or hijack a drag', () => {
  const { shell } = setup();
  const control = input({ target: shell.closeButton }); shell.startDrag(control);
  assert.equal(shell.drag, null); assert.equal(control.prevented, undefined);
  shell.startDrag(input({ target: shell.title, button: 2 })); assert.equal(shell.drag, null);
  shell.startDrag(input({ target: shell.title }));
  shell.moveDrag(input({ pointerId: 2, clientX: 10 }));
  assert.equal(shell.position.x, 656);
  shell.endDrag(input({ pointerId: 2 })); assert.ok(shell.drag);
  shell.endDrag(input()); shell.dispose();
});

test('keyboard movement, reset and minimize stay scoped to the focusable handle', () => {
  const { shell, content, minimized } = setup();
  shell.keyMove(input({ key: 'ArrowLeft' })); assert.equal(shell.position.x, 646);
  shell.keyMove(input({ key: 'ArrowDown', shiftKey: true })); assert.equal(shell.position.y, 146);
  shell.keyMove(input({ key: 'Home' })); assert.equal(shell.position.x, 656); assert.equal(shell.position.y, 96);
  shell.keyMove(input({ key: 'Enter' })); assert.equal(content.hidden, true);
  assert.equal(shell.minimizeButton.getAttribute('aria-label'), 'Restore SpaceCast');
  shell.keyMove(input({ key: ' ' })); assert.equal(content.hidden, false);
  assert.deepEqual(minimized, [true, false]);
  const unrelated = input({ key: 'Escape' }); shell.keyMove(unrelated); assert.equal(unrelated.prevented, undefined);
  shell.dispose();
});

test('restored positions and changing window content remain reachable; blocked storage is harmless', () => {
  const { shell, panel, window, observer, flush } = setup({ saved: '{"x":99999,"y":99999}' });
  assert.equal(panel.style.left, '672px'); assert.equal(panel.style.top, '472px');
  panel.height = 600; observer.callback(); flush(); assert.equal(panel.style.top, '192px');
  window.innerWidth = 800; window.dispatchEvent(new Event('resize')); flush();
  assert.equal(panel.style.left, '272px'); shell.dispose();
  const blocked = setup({ storageBlocked: true });
  blocked.shell.keyMove(input({ key: 'ArrowLeft' })); blocked.shell.dispose();
  const malformed = setup({ saved: '{"x":"200","y":40}' });
  assert.equal(malformed.panel.style.left, '656px'); malformed.shell.dispose();
});

test('close delegates ownership; disposal releases capture, observers, frames and listeners', () => {
  const { shell, panel, header, observer, frames, closeCount } = setup();
  shell.closeButton.dispatchEvent(new Event('click')); assert.equal(closeCount(), 1); assert.equal(panel.removed, undefined);
  shell.startDrag(input({ target: shell.title })); shell.dispose(); shell.dispose();
  assert.equal(header.capture, null); assert.equal(observer.disconnected, true);
  assert.equal(frames.size, 0); assert.equal(shell.listeners.length, 0);
  assert.equal(panel.getAttribute('aria-modal'), null); assert.equal(shell.title.removed, true);
  shell.closeButton.dispatchEvent(new Event('click')); assert.equal(closeCount(), 1);
});

test('size stays automatic by default and saved size is bounded to changing viewports', () => {
  const automatic = setup();
  assert.equal(automatic.panel.dataset.resized, undefined);
  automatic.panel.height = 450; automatic.observer.callback(); automatic.flush();
  assert.equal(automatic.panel.getBoundingClientRect().height, 450);
  automatic.shell.dispose();
  const saved = setup({ savedSize: '{"width":1000,"height":900}' });
  assert.equal(saved.panel.getBoundingClientRect().width, 1000);
  assert.equal(saved.panel.getBoundingClientRect().height, 776);
  saved.window.innerWidth = 340; saved.window.innerHeight = 250;
  saved.window.dispatchEvent(new Event('resize')); saved.flush();
  assert.equal(saved.panel.getBoundingClientRect().width, 316);
  assert.equal(saved.panel.getBoundingClientRect().height, 226);
  assert.equal(saved.panel.style.left, '12px'); assert.equal(saved.panel.style.top, '12px');
  saved.window.innerWidth = 1200; saved.window.innerHeight = 800;
  saved.window.dispatchEvent(new Event('resize')); saved.flush();
  assert.equal(saved.panel.getBoundingClientRect().width, 1000);
  saved.shell.dispose();
});

test('corner resizing preserves content, enforces minimum dimensions, and remembers size', () => {
  const { shell, panel, content, storage } = setup();
  assert.equal(shell.resizeHandles.length, 8);
  shell.startResize(input(), 'se', shell.resizeGrip);
  assert.equal(shell.resizeGrip.capture, 1);
  shell.moveResize(input({ clientX: -1000, clientY: -1000 }));
  assert.equal(panel.getBoundingClientRect().width, 360);
  assert.equal(panel.getBoundingClientRect().height, 260);
  assert.equal(panel.children.includes(content), true);
  shell.endResize(input());
  assert.equal(shell.resizeGrip.capture, null);
  assert.equal(panel.dataset.resizing, undefined);
  assert.deepEqual(JSON.parse(storage.get('spacecast.glass-window-size')), { width: 360, height: 260 });
  shell.dispose();
});

test('west resize anchors the opposite edge and ignores unrelated pointer events', () => {
  const { shell, panel } = setup();
  const handle = shell.resizeHandles.find(node => node.dataset.direction === 'w');
  const right = shell.position.x + panel.getBoundingClientRect().width;
  shell.startResize(input(), 'w', handle);
  shell.moveResize(input({ pointerId: 2, clientX: 0 }));
  assert.equal(panel.getBoundingClientRect().width, 520);
  shell.moveResize(input({ clientX: -50 }));
  assert.equal(panel.getBoundingClientRect().width, 670);
  assert.equal(shell.position.x + panel.getBoundingClientRect().width, right);
  shell.endResize(input({ pointerId: 2 })); assert.ok(shell.resize);
  shell.endResize(input()); shell.dispose();
});

test('resize keyboard controls and double click return to automatic content fit', () => {
  const { shell, panel, storage } = setup();
  shell.keyResize(input({ key: 'ArrowRight', shiftKey: true }));
  shell.keyResize(input({ key: 'ArrowDown' }));
  assert.equal(panel.getBoundingClientRect().width, 570);
  assert.equal(panel.getBoundingClientRect().height, 330);
  shell.keyResize(input({ key: 'Home' }));
  assert.equal(panel.dataset.resized, undefined);
  assert.equal(panel.getBoundingClientRect().width, 520);
  assert.equal(storage.get('spacecast.glass-window-size'), 'null');
  shell.keyResize(input({ key: 'ArrowDown', shiftKey: true }));
  shell.resizeGrip.dispatchEvent(new Event('dblclick'));
  assert.equal(panel.dataset.resized, undefined);
  shell.keyResize(input({ key: 'ArrowDown' }));
  shell.keyResize(input({ key: 'Enter' }));
  assert.equal(panel.getBoundingClientRect().height, 320);
  shell.dispose();
});

test('minimizing preserves expanded size and blocks resize until restored', () => {
  const { shell, panel } = setup({ savedSize: '{"width":620,"height":570}' });
  shell.setMinimized(true);
  assert.equal(panel.getBoundingClientRect().height, 48);
  shell.startResize(input(), 'se', shell.resizeGrip);
  assert.equal(shell.resize, null);
  shell.keyResize(input({ key: 'ArrowDown' }));
  shell.setMinimized(false);
  assert.equal(panel.getBoundingClientRect().width, 620);
  assert.equal(panel.getBoundingClientRect().height, 570);
  shell.dispose();
});

test('resize disposal saves in-memory fallback and removes all handles when storage is blocked', () => {
  const { shell, panel, context } = setup({ storageBlocked: true });
  shell.startResize(input(), 'se', shell.resizeGrip);
  shell.moveResize(input({ clientX: 0, clientY: 160 }));
  const before = panel.getBoundingClientRect();
  shell.dispose();
  assert.equal(shell.resizeGrip.capture, null);
  assert.ok(shell.resizeHandles.every(handle => handle.removed));
  assert.equal(panel.dataset.resized, undefined);
  const remounted = new context.GlassWindow(panel);
  assert.equal(panel.getBoundingClientRect().width, before.width);
  assert.equal(panel.getBoundingClientRect().height, before.height);
  remounted.dispose();
});
