// AI分析レポート（Markdown）→ PDF（A4縦、日本語）。ブラウザ/Node/Deno（Edge）共通の純粋モジュール。
// pdf-lib と fontkit（v2）は呼び出し側から渡す（Edge は npm: 指定子、Node はパッケージ）。
// @pdf-lib/fontkit 1.1.1 はこのフォントの subset で多くの字形を落とす（空白になる）ため使わない。fontkit v2 の
// subset は encode() だけを持つので、pdf-lib が呼ぶ encodeStream() を pdfLibFontkit() で補う。
// フォントは Noto Sans JP の CP932 サブセット（fonts/noto-sans-jp.js、gzip+base64）を埋め込み（subset）。
// 収録されていない文字（絵文字・一部の外字）は「〓」に置き換えて、欠け・文字化けではなく欠字と分かるようにする。
// Markdown は markdown.js と同じ記法（見出し・段落・箇条書き・番号付き・表・引用・区切り線・太字）だけを扱い、HTMLは解釈しない。

const PAGE = { width: 595.28, height: 841.89, top: 52, bottom: 58, left: 46, right: 46 };
const COLORS = {
  ink: [0.063, 0.094, 0.157], subtle: [0.278, 0.329, 0.404], faint: [0.596, 0.635, 0.702],
  line: [0.894, 0.906, 0.925], surface: [0.969, 0.973, 0.98], brand: [0.145, 0.388, 0.922], brandSoft: [0.937, 0.957, 1],
};
const MISSING = "〓";
const LINE_START_BAN = new Set([..."、。，．・：；？！゛゜ー…‥）」』】〕〉》］｝〙〗’”ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ%％)]},.:;!?"]);
const WORD = /[A-Za-z0-9@#$%&+\-_.,:;/'"!?()[\]{}~=<>*^|\\¥￥€£°±×÷]/;
const EMPTY_CELL = /^(|—|–|-|―|N\/A|n\/a)$/;
const NUMERIC_CELL = /^[+\-−±]?[¥￥$]?\d[\d,]*(\.\d+)?\s*(%|％|pt|件|円|倍|回|人|日|点|店舗|ポイント)?$|^[★☆]\s*\d(\.\d+)?$/;

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export async function gunzipBase64(b64) {
  const stream = new Blob([base64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** fonts/noto-sans-jp.js のモジュールから Regular/Bold の TTF バイト列を得る。 */
export async function loadReportFonts(fontModule) {
  const [regular, bold] = await Promise.all([gunzipBase64(fontModule.NOTO_SANS_JP_REGULAR_GZ), gunzipBase64(fontModule.NOTO_SANS_JP_BOLD_GZ)]);
  return { regular, bold };
}

/** fontkit v2 を pdf-lib 1.17 の registerFontkit に渡せる形にする（subset.encodeStream を encode で補う）。 */
export function pdfLibFontkit(fontkit) {
  return {
    create(buf, postscriptName) {
      const font = fontkit.create(buf, postscriptName);
      const createSubset = font.createSubset.bind(font);
      font.createSubset = () => {
        const sub = createSubset();
        if (typeof sub.encodeStream !== "function") {
          sub.encodeStream = () => {
            const handlers = {};
            let started = false;
            const stream = {
              on(event, cb) {
                handlers[event] = cb;
                if (!started && handlers.data && handlers.end) {
                  started = true;
                  queueMicrotask(() => { try { handlers.data(sub.encode()); handlers.end(); } catch (e) { handlers.error?.(e); } });
                }
                return stream;
              },
            };
            return stream;
          };
        }
        return sub;
      };
      return font;
    },
  };
}

// ---------- Markdown → ブロック ----------
const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const joinLines = (a, b) => (!a ? b : /[\u3000-\u9fff\uff00-\uffef]$/.test(a) && /^[\u3000-\u9fff\uff00-\uffef]/.test(b) ? a + b : `${a} ${b}`);

export function parseReportMarkdown(md) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = null;
  const flush = () => { if (para) { blocks.push(para); para = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    if (/^```/.test(line.trim())) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i].trim()); i++) code.push(lines[i]);
      blocks.push({ type: "code", lines: code });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); blocks.push({ type: "heading", level: h[1].length, text: h[2].trim() }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ type: "hr" }); continue; }
    if (line.trim().startsWith("|") && i + 1 < lines.length && isDivider(lines[i + 1])) {
      flush();
      const head = splitRow(line), marks = splitRow(lines[i + 1]), rows = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(splitRow(lines[i]));
      i--;
      blocks.push({ type: "table", head, marks, rows });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      flush();
      blocks.push({ type: "item", depth: Math.min(3, Math.floor(li[1].replace(/\t/g, "  ").length / 2)), marker: /\d/.test(li[2]) ? li[2].replace(")", ".") : "・", text: li[3] });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) { flush(); blocks.push({ type: "quote", text: q[1] }); continue; }
    const last = blocks[blocks.length - 1];
    if (!para && last?.type === "item" && /^\s{2,}\S/.test(line)) { last.text = joinLines(last.text, line.trim()); continue; }
    const text = line.trim();
    const italicOnly = /^_(.+)_$/.test(text) || /^\*(?!\*)(.+)\*$/.test(text);
    if (!para) para = { type: "paragraph", text: "", note: italicOnly };
    para.text = joinLines(para.text, italicOnly ? text.slice(1, -1) : text);
  }
  flush();
  return blocks;
}

/** インライン記法: **太字** / __太字__ → bold。リンクはラベル、`コード` と _斜体_ は記号だけ外す。 */
export function inlineRuns(text) {
  const s = String(text ?? "").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1").replace(/`([^`]+)`/g, "$1");
  const runs = [];
  const re = /\*\*([^*]+)\*\*|__([^_]+)__/g;
  let at = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > at) runs.push({ text: s.slice(at, m.index), bold: false });
    runs.push({ text: m[1] ?? m[2], bold: true });
    at = m.index + m[0].length;
  }
  if (at < s.length) runs.push({ text: s.slice(at), bold: false });
  return runs.map((r) => ({ ...r, text: r.text.replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, "$1$2").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2") }));
}
const plainText = (text) => inlineRuns(text).map((r) => r.text).join("");

// ---------- 描画 ----------
/**
 * @param {{ PDFLib: any, fontkit: any, fonts: { regular: Uint8Array, bold: Uint8Array }, report: any, meta?: string[], footer?: string, subset?: boolean }} options
 * @returns {Promise<Uint8Array>}
 */
export async function renderReportPdf({ PDFLib, fontkit, fonts, report, meta = [], footer = "Review Command Center · AI分析レポート", subset = true }) {
  const { PDFDocument, rgb } = PDFLib;
  const color = (c) => rgb(c[0], c[1], c[2]);
  const doc = await PDFDocument.create();
  doc.registerFontkit(pdfLibFontkit(fontkit));
  const regular = await doc.embedFont(fonts.regular, { subset });
  const bold = await doc.embedFont(fonts.bold, { subset });
  const charset = new Set(regular.getCharacterSet());
  const title = String(report.title ?? "AI分析レポート");
  doc.setTitle(title, { showInWindowTitleBar: true });
  doc.setAuthor("Review Command Center");
  doc.setSubject(`${report.storeName ?? ""} ${report.from ?? ""}〜${report.to ?? ""}`.trim());
  doc.setCreator("Review Command Center (gourmet) ai-analyst");
  doc.setProducer("pdf-lib");
  doc.setLanguage("ja-JP");
  if (report.createdAt && Number.isFinite(Date.parse(report.createdAt))) doc.setCreationDate(new Date(report.createdAt));

  const clean = (t) => [...String(t ?? "").normalize("NFC").replace(/[\u200b-\u200d\u2060\ufe0e\ufe0f]/g, "").replace(/\t/g, " ").replace(/[\u0000-\u001f\u007f]/g, "")]
    .map((ch) => (charset.has(ch.codePointAt(0)) ? ch : MISSING)).join("");
  const fontOf = (b) => (b ? bold : regular);
  const widthOf = (t, size, b) => fontOf(b).widthOfTextAtSize(t, size);
  const contentWidth = PAGE.width - PAGE.left - PAGE.right;

  let page, y;
  const newPage = () => { page = doc.addPage([PAGE.width, PAGE.height]); y = PAGE.height - PAGE.top; };
  const ensure = (h) => { if (y - h < PAGE.bottom) newPage(); };
  newPage();

  // 行分割（日本語は1文字ずつ、英数字の連続は単語として扱い、行頭禁則の文字は前の行にぶら下げる）
  const tokens = (runs) => {
    const out = [];
    for (const r of runs) {
      const t = clean(r.text);
      let buf = "";
      for (const ch of t) {
        if (WORD.test(ch)) { buf += ch; continue; }
        if (buf) { out.push({ text: buf, bold: r.bold }); buf = ""; }
        out.push({ text: ch, bold: r.bold });
      }
      if (buf) out.push({ text: buf, bold: r.bold });
    }
    return out;
  };
  const wrap = (runs, width, size) => {
    const lines = [];
    let line = [], w = 0;
    const push = () => { while (line.length && line[line.length - 1].text === " ") { w -= line.pop().w; } lines.push({ segs: line, width: w }); line = []; w = 0; };
    const add = (tok, tw) => {
      const last = line[line.length - 1];
      if (last && last.bold === tok.bold) { last.text += tok.text; last.w += tw; } else line.push({ text: tok.text, bold: tok.bold, w: tw });
      w += tw;
    };
    for (const tok of tokens(runs)) {
      if (tok.text === " " && !line.length) continue;
      let tw = widthOf(tok.text, size, tok.bold);
      if (w + tw <= width || (LINE_START_BAN.has(tok.text) && line.length)) { add(tok, tw); continue; }
      if (tw > width) { // 長い英数字は文字単位で折る
        for (const ch of tok.text) {
          const cw = widthOf(ch, size, tok.bold);
          if (w + cw > width && line.length) push();
          add({ text: ch, bold: tok.bold }, cw);
        }
        continue;
      }
      push();
      if (tok.text !== " ") add(tok, tw);
    }
    if (line.length || !lines.length) push();
    return lines;
  };
  const drawLine = (ln, x, yy, size, c, align = "left", width = 0) => {
    let cx = align === "right" ? x + width - ln.width : align === "center" ? x + (width - ln.width) / 2 : x;
    for (const seg of ln.segs) {
      if (seg.text) page.drawText(seg.text, { x: cx, y: yy, size, font: fontOf(seg.bold), color: color(c) });
      cx += seg.w;
    }
  };
  const paragraph = (runs, { size = 9.5, indent = 0, c = COLORS.ink, gap = 5, lead = 1.62, marker = null, markerWidth = 0 } = {}) => {
    const lh = size * lead;
    const lines = wrap(runs, contentWidth - indent - markerWidth, size);
    lines.forEach((ln, idx) => {
      ensure(lh);
      const base = y - size;
      if (idx === 0 && marker) page.drawText(clean(marker), { x: PAGE.left + indent, y: base, size, font: regular, color: color(COLORS.subtle) });
      drawLine(ln, PAGE.left + indent + markerWidth, base, size, c);
      y -= lh;
    });
    y -= gap;
  };

  const blocks = parseReportMarkdown(report.markdown);
  let firstHeading = true;
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.type === "heading") {
      const level = firstHeading && b.level === 1 ? 0 : b.level;
      const size = level === 0 ? 17 : level <= 2 ? 13 : 11;
      const lines = wrap([{ text: plainText(b.text), bold: true }], contentWidth - (level === 2 || level === 1 ? 10 : 0), size);
      const lh = size * 1.45;
      ensure(lines.length * lh + (level === 0 ? 10 : 8) + 9.5 * 1.62 * 2); // 見出しだけがページ末に残らないように
      y -= level === 0 ? 0 : level <= 2 ? 10 : 6;
      const top = y;
      for (const ln of lines) {
        drawLine(ln, PAGE.left + (level === 1 || level === 2 ? 10 : 0), y - size, size, level >= 3 ? COLORS.subtle : COLORS.ink);
        y -= lh;
      }
      if (level === 0) {
        page.drawRectangle({ x: PAGE.left, y: y - 2, width: contentWidth, height: 2, color: color(COLORS.brand) });
        y -= 10;
        for (const m of meta) paragraph([{ text: m, bold: false }], { size: 8.5, c: COLORS.subtle, gap: 0, lead: 1.5 });
        if (meta.length) y -= 6;
      } else if (level <= 2) {
        page.drawRectangle({ x: PAGE.left, y: y + 3, width: 3.5, height: top - y - 3, color: color(COLORS.brand) });
        y -= 4;
      } else y -= 2;
      firstHeading = false;
      continue;
    }
    if (b.type === "paragraph") { paragraph(inlineRuns(b.text), b.note ? { size: 8, c: COLORS.faint } : {}); continue; }
    if (b.type === "quote") { paragraph(inlineRuns(b.text), { indent: 10, c: COLORS.subtle }); continue; }
    if (b.type === "code") { for (const l of b.lines) paragraph([{ text: l || " ", bold: false }], { size: 8.5, c: COLORS.subtle, gap: 0, indent: 8 }); y -= 5; continue; }
    if (b.type === "hr") { ensure(14); y -= 6; page.drawLine({ start: { x: PAGE.left, y }, end: { x: PAGE.width - PAGE.right, y }, thickness: 0.7, color: color(COLORS.line) }); y -= 8; continue; }
    if (b.type === "item") {
      const marker = b.marker === "・" ? "・" : b.marker;
      const markerWidth = Math.max(11, widthOf(clean(marker), 9.5, false) + 4);
      const nextIsItem = blocks[bi + 1]?.type === "item";
      paragraph(inlineRuns(b.text), { indent: 4 + b.depth * 14, marker, markerWidth, gap: nextIsItem ? 1.5 : 6 });
      continue;
    }
    if (b.type === "table") { drawTable(b); continue; }
  }

  function drawTable(t) {
    const n = Math.max(t.head.length, ...t.rows.map((r) => r.length));
    const size = n <= 4 ? 8.8 : n <= 7 ? 8 : 7.2;
    const pad = 4, lh = size * 1.5;
    const cellText = (r, i) => clean(plainText(r[i] ?? ""));
    const head = Array.from({ length: n }, (_, i) => cellText(t.head, i));
    const rows = t.rows.map((r) => Array.from({ length: n }, (_, i) => cellText(r, i)));
    const numeric = Array.from({ length: n }, (_, i) => {
      const vals = rows.map((r) => r[i]).filter((c) => !EMPTY_CELL.test(c));
      return vals.length > 0 && vals.every((c) => NUMERIC_CELL.test(c));
    });
    const natural = Array.from({ length: n }, (_, i) => Math.max(widthOf(head[i], size, true), ...rows.map((r) => widthOf(r[i], size, false))) + pad * 2 + 1);
    const minW = Array.from({ length: n }, (_, i) => Math.min(natural[i], Math.max(widthOf(head[i].slice(0, 4), size, true), size * 3) + pad * 2));
    let widths = natural.slice();
    const total = (ws) => ws.reduce((a, v) => a + v, 0);
    if (total(widths) > contentWidth) {
      // 短い列（数値・日付・サイト名）は縮めず、長い文章の列で吸収する
      const shortCols = widths.map((w) => w <= contentWidth * 0.18);
      const fixed = total(widths.filter((_, i) => shortCols[i]));
      const flex = widths.map((w, i) => (shortCols[i] ? 0 : w));
      const room = contentWidth - fixed;
      if (room > 40 * flex.filter(Boolean).length) widths = widths.map((w, i) => (shortCols[i] ? w : Math.max(minW[i], (w / total(flex)) * room)));
      if (total(widths) > contentWidth) { const k = contentWidth / total(widths); widths = widths.map((w) => w * k); }
    } else if (!numeric.every(Boolean)) {
      // 余白は文字の列に配る（表の幅を本文に揃える）
      const extra = contentWidth - total(widths);
      const textCols = numeric.map((v) => !v);
      const base = total(widths.filter((_, i) => textCols[i])) || 1;
      if (extra > 0 && n >= 3) widths = widths.map((w, i) => (textCols[i] ? w + (w / base) * extra : w));
    }
    const layoutRow = (cells, isHead) => {
      const wrapped = cells.map((c, i) => wrap([{ text: c, bold: isHead }], Math.max(4, widths[i] - pad * 2), size));
      return { wrapped, height: Math.max(...wrapped.map((w) => w.length)) * lh + pad * 1.6 };
    };
    const headRow = layoutRow(head, true);
    const drawRow = (row, isHead) => {
      let x = PAGE.left;
      const top = y;
      if (isHead) page.drawRectangle({ x, y: top - row.height, width: total(widths), height: row.height, color: color(COLORS.surface) });
      row.wrapped.forEach((lines, i) => {
        let yy = top - pad * 0.8 - size;
        for (const ln of lines) { drawLine(ln, x + pad, yy, size, isHead ? COLORS.ink : COLORS.ink, numeric[i] ? "right" : "left", widths[i] - pad * 2); yy -= lh; }
        page.drawRectangle({ x, y: top - row.height, width: widths[i], height: row.height, borderColor: color(COLORS.line), borderWidth: 0.6 });
        x += widths[i];
      });
      y -= row.height;
    };
    ensure(headRow.height + lh * 2 + pad * 2);
    y -= 2;
    drawRow(headRow, true);
    for (const cells of rows) {
      const row = layoutRow(cells, false);
      if (y - row.height < PAGE.bottom) { newPage(); drawRow(headRow, true); } // ページをまたいだら見出し行を繰り返す
      drawRow(row, false);
    }
    y -= 10;
  }

  // フッター（全ページ）: 左にアプリ名、右にページ番号
  const pages = doc.getPages();
  const shortTitle = (() => { let s = clean(title); while (s.length > 1 && widthOf(s, 7.5, false) > contentWidth * 0.55) s = s.slice(0, -2) + "…"; return s; })();
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`;
    p.drawLine({ start: { x: PAGE.left, y: PAGE.bottom - 18 }, end: { x: PAGE.width - PAGE.right, y: PAGE.bottom - 18 }, thickness: 0.5, color: color(COLORS.line) });
    p.drawText(clean(`${footer} · ${shortTitle}`), { x: PAGE.left, y: PAGE.bottom - 30, size: 7.5, font: regular, color: color(COLORS.faint) });
    p.drawText(label, { x: PAGE.width - PAGE.right - widthOf(label, 7.5, false), y: PAGE.bottom - 30, size: 7.5, font: regular, color: color(COLORS.faint) });
  });
  return doc.save({ useObjectStreams: true });
}
