/**
 * client-dock-registration.test.mjs — the dock can no longer disappear from the header.
 *
 * WHAT THIS GUARDS (measured 2026-09-17)
 *   The room dock vanished from the session header while the org dock — same slot, `order` 460 vs
 *   our 450 — stayed, and nothing on disk had changed (no host restart, no plugin file written).
 *   The slot engine REFUSES a second entry with the same (id, priority) on a list slot:
 *       `list slot "…" already has an entry with id "agent-room-dock-top" …`
 *   `slots.inject`'s callback can run again while the first registration is still live, and the
 *   throw that follows takes the entry out for good — silently, until a page reload.
 *
 * The test drives the REAL built bundle (lib/client.js) through a fake slots engine that implements
 * the engine's rule, and asserts the three things the fix promises:
 *   1. one registration, and it is the error-bounded dock (not the bare component);
 *   2. running the inject callback AGAIN does not throw and leaves exactly ONE live registration;
 *   3. a refused registration is logged and retried, not swallowed.
 *
 * Run directly: node test/client-dock-registration.test.mjs   (never `node --test`: the runner's
 * piped spawn is denied in a confined sandbox)
 */

import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "lib", "client.js");
const SOURCE = readFileSync(BUNDLE, "utf8");

/** Minimal React the bundle can build elements with (no DOM, no hooks needed at import time). */
function reactStub() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } };
    },
    Fragment: "Fragment",
    Component: class Component {
      constructor(props) { this.props = props || {}; this.state = {}; }
    },
    useState: (v) => [typeof v === "function" ? v() : v, () => {}],
    useEffect: () => {}, useLayoutEffect: () => {}, useCallback: (f) => f,
    useMemo: (f) => f(), useRef: (v) => ({ current: v }), useContext: () => ({}),
  };
  return React;
}

/** Load the bundle the way DSH does: it hands the loader a factory, we keep it. */
function loadBundle() {
  let spec = null;
  const win = { __ModuleLoader__: { load: (s) => { spec = s; } } };
  const documentFake = { createElement: () => ({ style: {}, appendChild() {} }), head: { appendChild() {} }, querySelector: () => null, addEventListener() {} };
  const fn = new Function("window", "document", "EventSource", "fetch", SOURCE);
  fn(win, documentFake, class EventSource { constructor() {} close() {} }, () => Promise.reject(new Error("no network in this test")));
  assert.ok(spec && typeof spec.factory === "function", "the bundle must register a factory with __ModuleLoader__");
  const React = reactStub();
  const requireShim = (name) => {
    if (name === "react") return React;
    throw new Error(`unexpected external require: ${name}`);
  };
  return { mod: spec.factory(requireShim), React };
}

/** A slots engine with the real rule: a list slot refuses a duplicate (id, priority). */
function makeSlots() {
  const entries = [];
  const engine = {
    entries,
    registerCalls: 0,
    refusals: 0,
    failNext: 0,
    injectCb: null,
    inject(target, cb) {
      assert.strictEqual(target, "conversation.session.header.utilities", "the dock belongs in the session header utilities slot");
      this.injectCb = cb;
      // The real engine calls the callback as part of injecting the declaration (and keeps the
      // callback for later re-runs). A fake that only STORES it registers nothing, which is how the
      // first version of this test failed 0 !== 1 — the harness, not the plugin.
      const dispose = cb();
      return () => { this.injectCb = null; if (typeof dispose === "function") dispose(); };
    },
    register(def, component) {
      this.registerCalls += 1;
      if (this.failNext > 0) { this.failNext -= 1; this.refusals += 1; throw new Error("simulated transient engine refusal"); }
      const dupe = entries.find((e) => e.options.id === def.id && (e.options.priority ?? 0) === (def.priority ?? 0));
      if (dupe) throw new Error(`list slot "${def.name}" already has an entry with id "${def.id}" (registered by ${dupe.options.registrant ?? "unknown"})`);
      const entry = { options: def, component, dispose: () => { const i = entries.indexOf(entry); if (i >= 0) entries.splice(i, 1); } };
      entries.push(entry);
      return entry.dispose;
    },
  };
  return engine;
}

function makeCtx(slots) {
  const disposers = [];
  return {
    ctx: {
      slots,
      locale: { register: () => () => {} },
      effect(fn) { const d = fn(); disposers.push(d); return d; },
    },
    disposers,
  };
}

test("one registration, and it is the error-bounded dock", () => {
  const { mod, React } = loadBundle();
  const slots = makeSlots();
  const { ctx } = makeCtx(slots);
  mod.apply(ctx);

  assert.strictEqual(slots.entries.length, 1, "exactly one dock entry must be registered");
  const entry = slots.entries[0];
  assert.strictEqual(entry.options.id, "agent-room-dock-top");
  assert.strictEqual(entry.options.order, 450, "order 450 keeps the dock LEFT of agent-org's 460");

  // The slot holds the BOUNDARY, not the bare dock: a render error must show itself, not vanish.
  const el = entry.component();
  assert.strictEqual(typeof el.type, "function", "the entry renders a component");
  assert.strictEqual(typeof el.type.getDerivedStateFromError, "function", "that component is an error boundary");
  assert.strictEqual(typeof el.props.children.type, "function", "the boundary wraps the dock component");
  assert.strictEqual(React.Fragment, "Fragment");
});

test("the boundary renders a visible notice instead of nothing", () => {
  const { mod } = loadBundle();
  const slots = makeSlots();
  const { ctx } = makeCtx(slots);
  mod.apply(ctx);

  const Boundary = slots.entries[0].component().type;
  const instance = new Boundary({ children: null });
  // getDerivedStateFromError is what React calls; assert its shape AND the rendered notice.
  assert.deepStrictEqual(Boundary.getDerivedStateFromError(new Error("boom")), { failed: "boom" });
  instance.state = { failed: "boom" };
  const out = instance.render();
  assert.strictEqual(out.type, "button", "a failed dock renders a button, not null");
  assert.ok(String(out.props.children).includes("房间面板出错"), `the notice must name the failure (got ${JSON.stringify(out.props.children)})`);
});

test("running the inject callback AGAIN does not throw and leaves exactly one entry", () => {
  const { mod } = loadBundle();
  const slots = makeSlots();
  const { ctx } = makeCtx(slots);
  mod.apply(ctx);

  assert.strictEqual(slots.entries.length, 1);
  const first = slots.entries[0];
  // This is the regression: the SAME call, a second time, with the first registration still live.
  assert.doesNotThrow(() => { slots.injectCb(); }, "a re-run of the inject callback must dispose the previous registration, not collide with it");
  assert.strictEqual(slots.entries.length, 1, "still exactly one live entry (no duplicate, no leak)");
  assert.notStrictEqual(slots.entries[0], first, "the entry was replaced, not left as the stale one");
});

test("a refused registration is logged and retried, never swallowed", async () => {
  const { mod } = loadBundle();
  const slots = makeSlots();
  const { ctx } = makeCtx(slots);
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(" ")); };
  try {
    mod.apply(ctx);
    assert.strictEqual(slots.entries.length, 1);
    // Make the engine refuse the NEXT registration attempt, then re-run the inject callback.
    slots.failNext = 1;
    slots.injectCb();
    assert.strictEqual(slots.entries.length, 0, "the refused attempt left no entry behind");
    assert.ok(logged.some((l) => l.includes("dock registration failed")), `the refusal must be logged (got ${JSON.stringify(logged)})`);
    await new Promise((r) => setTimeout(r, 1800));   // the bounded retry is 1.5 s
    assert.strictEqual(slots.entries.length, 1, "the retry must put the dock back without a page reload");
  } finally {
    console.error = realError;
  }
});
