// 小さな安全なMarkdown→HTML変換（AI分析の回答・レポートの表示用。ブラウザ/Node共通）。
// 先にすべての文字をHTMLエスケープし、許可した記法（見出し・段落・箇条書き・番号付き・表・引用・コード・太字・斜体・リンク）だけをタグにする。
// リンクは http(s) のみ。生のHTMLは表示しない（AIの出力・口コミ本文をそのまま埋め込まない）。
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>").replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}
const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
// 表の列の配置: 数値の列（件数・PV・評価・%・増減）は右寄せ、文字の列は左寄せ（見出しも同じ配置）。
// 区切り行の ---: は数値の列にだけ効かせる（旧レポートは全列が ---: のため、本文の列が右寄せになっていた）。
// :---: は中央、:--- は左のまま。短い列（日付・サイト名・数値）は折り返さず、長い文章の列だけ折り返す。
const EMPTY_CELL = /^(|—|–|-|―|N\/A|n\/a)$/;
const NUMERIC_CELL = /^[+\-−±]?[¥￥$]?\d[\d,]*(\.\d+)?\s*(%|％|pt|件|円|倍|回|人|日|点|店舗|ポイント)?$|^[★☆]\s*\d(\.\d+)?$/;
const plain = (c) => c.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").trim();
const SHORT_CELL = 24;
function tableColumn(mark, cells) {
  const values = cells.map(plain).filter((c) => !EMPTY_CELL.test(c));
  const numeric = values.length > 0 && values.every((c) => NUMERIC_CELL.test(c));
  const m = mark.trim();
  const align = m.startsWith(":") && m.endsWith(":") ? "center" : m.startsWith(":") ? "left" : numeric ? "right" : "left";
  const short = cells.every((c) => [...plain(c)].length <= SHORT_CELL);
  const kind = numeric ? "md-num" : "md-text";
  // 短い列は見出しも本文も折り返さず内容の幅に縮め（md-nowrap）、長い文章の列（md-wrap）が残りの幅で折り返す
  const cls = `${kind} ${short ? "md-nowrap" : "md-wrap"}`;
  return { align, th: cls, td: cls };
}

export function markdownToHtml(md) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const head = splitRow(line);
      const marks = splitRow(lines[i + 1]);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(splitRow(lines[i]));
      const cols = head.map((_, j) => tableColumn(marks[j] ?? "", rows.map((r) => r[j] ?? "")));
      const td = (tag, c, j) => `<${tag} class="${cols[j][tag]}" style="text-align:${cols[j].align}">${inline(c)}</${tag}>`;
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c, j) => td("th", c, j)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, j) => td("td", r[j] ?? "", j)).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdownToHtml(body.join("\n"))}</blockquote>`);
      continue;
    }
    if (listItem.test(line)) {
      // 2階層まで（字下げ2文字以上を入れ子として扱う）
      const baseIndent = listItem.exec(line)[1].length;
      const ordered = /\d/.test(listItem.exec(line)[2]);
      const items = [];
      for (; i < lines.length; i++) {
        const m = listItem.exec(lines[i]);
        if (m && m[1].length <= baseIndent + 1) items.push({ text: m[3], children: [] });
        else if (m && items.length) items.at(-1).children.push(lines[i].slice(baseIndent + 2));
        else if (lines[i].trim() && items.length && /^\s{2,}/.test(lines[i])) items.at(-1).text += `\n${lines[i].trim()}`;
        else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it.text).replace(/\n/g, "<br>")}${it.children.length ? markdownToHtml(it.children.join("\n")) : ""}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6})\s|^\s*```|^\s*>/.test(lines[i]) && !listItem.test(lines[i])
      && !(lines[i].includes("|") && i + 1 < lines.length && isDivider(lines[i + 1])); i++) para.push(lines[i].trim());
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}

// ダウンロードHTML用（画面・印刷は src/index.css の .md に同じ規則がある）
export const REPORT_CSS = `body{font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP",system-ui,sans-serif;color:#101828;max-width:960px;margin:32px auto;padding:0 24px;line-height:1.7;font-size:13px}
h1{font-size:22px;border-bottom:2px solid #2563eb;padding-bottom:6px}h2{font-size:16px;margin-top:28px;border-left:4px solid #2563eb;padding-left:8px}h3{font-size:14px;margin-top:18px}
.md-table{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:8px 0;font-size:12px}th,td{border:1px solid #e4e7ec;padding:4px 8px;text-align:left;vertical-align:top;line-height:1.6;overflow-wrap:break-word;word-break:normal}th{background:#f7f8fa;vertical-align:bottom}
.md-nowrap{white-space:nowrap;width:1%}.md-wrap{white-space:normal;min-width:16em}.md-num{font-variant-numeric:tabular-nums}code{background:#f7f8fa;padding:0 4px;border-radius:3px}
blockquote{border-left:3px solid #e4e7ec;margin:8px 0;padding-left:12px;color:#475467}hr{border:none;border-top:1px solid #e4e7ec;margin:20px 0}
@media print{body{margin:0;max-width:none}h2{break-after:avoid}.md-table{overflow:visible}thead{display:table-header-group}tr{break-inside:avoid}}`;
// ダウンロード用の単独HTML
export function reportHtmlDocument(title, md) {
  return `<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${REPORT_CSS}</style></head><body>\n${markdownToHtml(md)}\n</body></html>\n`;
}
