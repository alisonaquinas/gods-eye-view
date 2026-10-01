import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelChrome } from './panelChrome.js';

function fixture(theme = 'cyber') {
  const nodes = new Map();
  const node = (id, collapsed = true) => {
    const classes = new Set(collapsed ? ['collapsed'] : []);
    const value = { id, hidden: false, children: [],
      matches: () => true,
      contains(target) { return this === target || this.children.some((child) => child.contains(target)); },
      classList: {
        contains: (name) => classes.has(name),
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      },
    };
    nodes.set(id, value);
    return value;
  };
  const rail = node('rail');
  const display = node('pp-toggles'), context = node('global-context-panel'), cctv = node('cctv-panel'), radio = node('radio-panel');
  rail.children = [display, context, cctv];
  for (const panel of rail.children) panel.parentElement = rail;
  context.children = [radio];
  radio.parentElement = context;
  const saved = [], claimed = [];
  const owner = {
    _rightPanelStack: rail,
    _panelLayout: {},
    _lifetime: { frame() {} },
    _syncPanelCollapseButton() {}, _scheduleRightPanelLayout() {},
    _scheduleLeftPanelLayout() {}, _layoutRightPanels() {}, _syncCctvPanelViewport() {},
    _savePanelCollapsedState: (...args) => saved.push(args),
    shareLinkManager: { claimRestoreLane: (...args) => claimed.push(args), onPanelStateChange() {} },
  };
  owner.setPanelCollapsed = PanelChrome.prototype.setPanelCollapsed.bind(owner);
  return { display, context, cctv, radio, owner, saved, claimed,
    doc: { documentElement: { dataset: { uiTheme: theme } }, getElementById: (id) => nodes.get(id) },
  };
}

test('explicit CCTV selection scrolls its header into a narrow rail, including an already-open panel', () => {
  const f = fixture('tactical');
  const priorDocument = globalThis.document;
  const priorWindow = globalThis.window;
  const frames = [], scrolled = [];
  globalThis.document = f.doc;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  f.owner._lifetime.frame = callback => frames.push(callback);
  f.owner._updateCommandDockTrayStack = () => {};
  f.cctv.querySelector = () => ({ scrollIntoView: options => scrolled.push(options) });
  try {
    f.owner.setPanelCollapsed('cctv-panel', false, { explicit: true });
    frames.splice(0).forEach(callback => callback());
    assert.equal(scrolled.length, 0, 'wait for queued rail layout before measuring the header');
    frames.splice(0).forEach(callback => callback());
    f.owner.setPanelCollapsed('cctv-panel', false, { explicit: true });
    frames.splice(0).forEach(callback => callback());
    frames.splice(0).forEach(callback => callback());
    assert.equal(scrolled.length, 2);
    assert.deepEqual(scrolled[0], { block: 'nearest', inline: 'nearest' });
    f.owner.setPanelCollapsed('cctv-panel', false);
    frames.splice(0).forEach(callback => callback());
    assert.equal(scrolled.length, 2, 'automatic updates do not move the rail');
  } finally {
    globalThis.document = priorDocument;
    globalThis.window = priorWindow;
  }
});

test('explicit Cyber opening collapses peers and claims their restoration lanes', () => {
  const f = fixture(), prior = globalThis.document;
  globalThis.document = f.doc;
  try {
    f.owner.setPanelCollapsed('global-context-panel', false, { explicit: true });
    f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
    assert.equal(f.display.classList.contains('collapsed'), false);
    assert.equal(f.context.classList.contains('collapsed'), true);
    assert.ok(f.saved.some(([id, collapsed]) => id === 'global-context-panel' && collapsed));
    assert.ok(f.claimed.some(([, id]) => id === 'global-context-panel'));
    f.cctv.classList.add('cyber-accordion-collapsed');
    f.owner.setPanelCollapsed('cctv-panel', true, { explicit: true });
    assert.equal(f.cctv.classList.contains('cyber-accordion-collapsed'), false);
  } finally { globalThis.document = prior; }
});

test('opening already-expanded Radio reveals Context and closes Display', () => {
  const f = fixture(), prior = globalThis.document;
  globalThis.document = f.doc;
  try {
    f.owner.setPanelCollapsed('radio-panel', false, { explicit: true });
    f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
    assert.equal(f.radio.classList.contains('collapsed'), false);
    assert.equal(f.context.classList.contains('collapsed'), true);
    f.owner.setPanelCollapsed('radio-panel', false, { explicit: true });
    assert.equal(f.context.classList.contains('collapsed'), false);
    assert.equal(f.display.classList.contains('collapsed'), true);
  } finally { globalThis.document = prior; }
});

test('non-Cyber explicit panels and restored preferences retain their existing policy', () => {
  for (const theme of ['tactical', 'operator', 'minimal', 'cyber']) {
    const f = fixture(theme), prior = globalThis.document;
    globalThis.document = f.doc;
    try {
      const options = theme === 'cyber' ? { restore: true, persist: false } : { explicit: true };
      f.owner.setPanelCollapsed('pp-toggles', false, options);
      f.owner.setPanelCollapsed('cctv-panel', false, options);
      assert.equal(f.display.classList.contains('collapsed'), false);
      assert.equal(f.cctv.classList.contains('collapsed'), false);
      if (theme === 'cyber') assert.deepEqual(f.saved, []);
    } finally { globalThis.document = prior; }
  }
});
