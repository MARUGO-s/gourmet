// 依存ライブラリなしの軽量HTMLツリー。一休の旧ASP画面（入れ子のレイアウト表・閉じタグ省略あり）を
// 表・ラベル単位で読むためだけの最小実装。スクリプトは実行せず、文字列だけを扱う。
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
// 開始タグが来たときに暗黙に閉じる要素（HTML仕様の簡略版）
const AUTO_CLOSE = {
  tr: ["tr"], td: ["td", "th"], th: ["td", "th"], li: ["li"], option: ["option"],
  dt: ["dt", "dd"], dd: ["dt", "dd"], p: ["p"], thead: ["tbody", "thead", "tfoot"], tbody: ["tbody", "thead", "tfoot"], tfoot: ["tbody", "thead", "tfoot"],
};
// これらの要素より外へは暗黙の閉じを波及させない
const SCOPE = new Set(["table", "ul", "ol", "dl", "select", "body", "html", "div", "form"]);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", yen: "¥", copy: "©", times: "×", minus: "−", hellip: "…", laquo: "«", raquo: "»" };
export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (all, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

function parseAttrs(source) {
  const attrs = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  let m;
  while ((m = re.exec(source))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return attrs;
}

class Node {
  constructor(tag, attrs = {}, parent = null) { this.tag = tag; this.attrs = attrs; this.parent = parent; this.children = []; }
  get text() { return this.children.map((c) => (typeof c === "string" ? c : c.tag === "br" ? "\n" : c.text)).join(""); }
  // 表示上の文字列（連続空白は1つ・前後は削除）
  get clean() { return this.text.replace(/[ \t\r\f\v\u00a0\u3000]+/g, " ").replace(/\s*\n\s*/g, "\n").trim(); }
  get inline() { return this.clean.replace(/\s+/g, " "); }
  *walk() { for (const c of this.children) if (typeof c !== "string") { yield c; yield* c.walk(); } }
  all(test) { const out = []; for (const n of this.walk()) if (test(n)) out.push(n); return out; }
  find(test) { for (const n of this.walk()) if (test(n)) return n; return null; }
  byTag(tag) { return this.all((n) => n.tag === tag); }
  closest(test) { let n = this.parent; while (n) { if (test(n)) return n; n = n.parent; } return null; }
  // 入れ子の表を除いた、この表自身の行
  rows() {
    if (this.tag !== "table") return [];
    const out = [];
    const visit = (node) => { for (const c of node.children) if (typeof c !== "string") { if (c.tag === "tr") out.push(c); else if (c.tag !== "table") visit(c); } };
    visit(this);
    return out;
  }
  cells() { return this.children.filter((c) => typeof c !== "string" && (c.tag === "td" || c.tag === "th")); }
}

export function parseHtml(html) {
  const root = new Node("#root");
  let current = root;
  const src = String(html);
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/?([a-zA-Z][\w:-]*)((?:\s+[^\s=/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*\/?>/g;
  let last = 0, m;
  const text = (s) => { if (s) current.children.push(decodeEntities(s)); };
  const close = (tag) => {
    let n = current;
    while (n && n !== root && n.tag !== tag) n = n.parent;
    if (n && n !== root) current = n.parent;
  };
  while ((m = re.exec(src))) {
    text(src.slice(last, m.index));
    last = re.lastIndex;
    if (!m[1]) continue; // コメント・DOCTYPE
    const tag = m[1].toLowerCase();
    if (m[0][1] === "/") { if (!VOID.has(tag)) close(tag); continue; }
    const autos = AUTO_CLOSE[tag];
    if (autos) {
      // 最も近い同種の要素を閉じる（途中の閉じ忘れ要素ごと）。表・行の境界より外は閉じない。
      for (let n = current; n && n !== root; n = n.parent) {
        if (autos.includes(n.tag)) { current = n.parent; break; }
        if (SCOPE.has(n.tag) || ((tag === "td" || tag === "th") && n.tag === "tr")) break;
      }
    }
    const node = new Node(tag, parseAttrs(m[2] ?? ""), current);
    current.children.push(node);
    if (VOID.has(tag) || m[0].endsWith("/>")) continue;
    if (RAW.has(tag)) {
      const end = src.toLowerCase().indexOf(`</${tag}`, last);
      const stop = end < 0 ? src.length : end;
      if (tag !== "script" && tag !== "style") node.children.push(decodeEntities(src.slice(last, stop)));
      const gt = end < 0 ? src.length : src.indexOf(">", end);
      last = re.lastIndex = gt < 0 ? src.length : gt + 1;
      continue;
    }
    current = node;
  }
  text(src.slice(last));
  return root;
}

// colspan/rowspan を格子に展開した見出し（readConversionTable と同じ考え方）
export function headerGrid(rows) {
  const grid = [];
  rows.forEach((tr, r) => {
    grid[r] = grid[r] ?? [];
    let c = 0;
    for (const cell of tr.cells()) {
      while (grid[r][c] !== undefined) c++;
      const span = (name) => Math.max(1, Math.min(50, Number.parseInt(cell.attrs[name] ?? "1", 10) || 1));
      const label = cell.inline.replace(/\s+/g, "");
      for (let dr = 0; dr < span("rowspan"); dr++) {
        grid[r + dr] = grid[r + dr] ?? [];
        for (let dc = 0; dc < span("colspan"); dc++) grid[r + dr][c + dc] = label;
      }
      c += span("colspan");
    }
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  return Array.from({ length: width }, (_, c) => [...new Set(grid.map((row) => row[c]).filter(Boolean))]);
}

// 旧ASPの画面は Shift_JIS のことがある。HTTPヘッダー → UTF-8として正しいか → meta → Shift_JIS の順に判定する。
// ブラウザで保存したHTML（page.content() 等）は本文がUTF-8でも meta が Shift_JIS のまま残るため、
// meta より先にUTF-8の妥当性を見る（日本語のShift_JISバイト列がUTF-8として妥当になることはほぼない）。
const CHARSET_ALIASES = new Map([
  ["shift_jis", "shift_jis"], ["shift-jis", "shift_jis"], ["sjis", "shift_jis"], ["x-sjis", "shift_jis"], ["windows-31j", "shift_jis"],
  ["cp932", "shift_jis"], ["ms932", "shift_jis"], ["ms_kanji", "shift_jis"], ["csshiftjis", "shift_jis"],
  ["euc-jp", "euc-jp"], ["x-euc-jp", "euc-jp"], ["utf-8", "utf-8"], ["utf8", "utf-8"], ["iso-2022-jp", "iso-2022-jp"],
]);
const normalizeCharset = (name) => CHARSET_ALIASES.get(String(name ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase()) ?? null;

export function detectCharset(bytes, contentType = "") {
  const header = normalizeCharset(String(contentType).match(/charset\s*=\s*([^;\s]+)/i)?.[1]);
  if (header) return header;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return "utf-8"; } catch { /* UTF-8ではない */ }
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const fromMeta = normalizeCharset(head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i)?.[1]);
  return fromMeta && fromMeta !== "utf-8" ? fromMeta : "shift_jis";
}

export function decodeHtml(bytes, contentType = "") {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const charset = detectCharset(data, contentType);
  return { charset, html: new TextDecoder(charset).decode(data) };
}
