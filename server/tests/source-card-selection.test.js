import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as stores from "../../supabase/functions/_shared/stores.js";

function compile(path, imports = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(name) {
      if (name === "react/jsx-runtime") return jsx;
      assert.ok(name in imports, `Unexpected import ${name}`);
      return imports[name];
    },
  });
  return module.exports;
}
const agent = compile("../../src/lib/agent-requests.ts");
const IngestPanel = compile("../../src/components/IngestPanel.tsx", {
  "../../supabase/functions/_shared/stores.js": stores,
  "../lib/agent-requests": agent,
}).default;
function nodes(node, ancestors = []) {
  if (!node || typeof node !== "object") return [];
  return [{ node, ancestors }, ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, [...ancestors, node]))];
}
const sources = [
  ["tabelog", "食べログ"], ["hotpepper", "ホットペッパーグルメ"], ["google", "Google マップ"],
  ["toreta", "トレタ"], ["ikyu", "一休.comレストラン"], ["retty", "Retty"],
].map(([id, name]) => ({ id, name, color: "#333", hasCredential: id === "tabelog", lastUpdatedAt: null }));
function harness(overrides = {}) {
  const selected = [], requested = [];
  const props = {
    filter: "all", signedIn: true, sources, stores: [], requests: [], busyKey: null,
    credentials: [{ id: "test-account", source: "tabelog", storeKey: "test-store", label: "test" }],
    onFilter: (source) => { selected.push(source); props.filter = source; },
    onRequest: (...args) => requested.push(args), onRequests() {}, onAccounts() {},
    ...overrides,
  };
  const render = () => nodes(IngestPanel(props));
  const cards = () => render().map(({ node }) => node).filter((n) => n.type === "button" && n.props["aria-pressed"] !== undefined);
  return { props, selected, requested, render, cards };
}
test("All six source cards use the dashboard filter, including unregistered sources", () => {
  const h = harness();
  for (const source of sources) {
    h.props.filter = "all";
    assert.equal(h.cards().length, 6);
    const card = h.cards().find((n) => n.props["aria-label"] === `${source.name}のダッシュボードを表示`);
    assert.ok(card);
    assert.equal(card.props.type, "button"); // Native Enter/Space/Tab support, not a clickable div.
    assert.equal(card.props["aria-pressed"], false);
    assert.equal(card.props.disabled, undefined);
    card.props.onClick();
    assert.equal(h.props.filter, source.id);
    assert.equal(h.cards().length, 1);
    assert.equal(h.cards()[0].props["aria-pressed"], true);
  }
  assert.deepEqual(h.selected, sources.map((s) => s.id));
  assert.equal(h.requested.length, 0);
  h.props.filter = "all";
  assert.equal(h.cards().length, 6);
});
test("Request button remains independent, without nested buttons or filter changes", () => {
  const h = harness();
  const rendered = h.render();
  for (const { node, ancestors } of rendered.filter(({ node }) => node.type === "button")) {
    assert.equal(ancestors.some((n) => n.type === "button"), false);
    if (node.props.children !== "今すぐ取得を依頼") continue;
    assert.match(node.props.className, /pointer-events-auto/);
    node.props.onClick();
  }
  assert.deepEqual(h.requested, [["tabelog", "test-store"]]);
  assert.deepEqual(h.selected, []);
  assert.equal(h.props.filter, "all");
});
test("Busy requests and demo mode do not disable source selection", () => {
  const busy = harness({ busyKey: "tabelog/test-store" });
  const request = busy.render().find(({ node }) => node.props?.children === "送信中…").node;
  assert.equal(request.props.disabled, true);
  assert.equal(busy.cards().length, 6);
  busy.cards()[0].props.onClick();
  assert.equal(busy.props.filter, "tabelog");
  const demo = harness({ signedIn: false, credentials: [] });
  demo.cards()[1].props.onClick();
  assert.equal(demo.props.filter, "hotpepper");
  assert.equal(demo.requested.length, 0);
});
test("Source cards and top buttons are connected to the same App filter", () => {
  const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /<IngestPanel\s+filter=\{filter\}[\s\S]*?onFilter=\{setFilter\}/);
  assert.match(app, /onClick=\{\(\) => setFilter\(s\.id\)\}\s+aria-pressed=\{filter === s\.id\}/);
  assert.match(app, /getDashboard\(filter,/);
});
