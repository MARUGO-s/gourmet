// 一休.comレストラン 店舗管理画面（旧ASP）の純粋パーサー。アプリの実行環境には含めない（取り込み側のツール）。
// 外部エージェントが保存したHTMLを、agent-api の取り込み形式（schemaVersion 1）へ変換する。
// 実画面のHTMLは未検証のため、見出し語・ラベル語で列と項目を特定し、合計値で検証する。
// 想定と異なる構造は推測で埋めず、例外で知らせる（取得済みの他項目は保存側で保持）。
import { parseHtml, headerGrid } from "./html-lite.js";

export const IKYU_ORIGIN = "https://restaurant.ikyu.com";
export const ikyuReviewListUrl = (storeId) => {
  if (!/^\d{6}$/.test(String(storeId))) throw new Error("一休の店舗IDが不正です");
  return `${IKYU_ORIGIN}/rsOwner/v2/${storeId}/legacy?path=/scriptO/rsOwnImpressions.asp`;
};

const AUTH_ERROR = "一休にログインできませんでした。店舗ID・オペレータID・パスワードをご確認ください";
export function assertIkyuPage(root) {
  const hasPassword = root.find((n) => n.tag === "input" && String(n.attrs.type).toLowerCase() === "password");
  if (hasPassword) throw new Error(AUTH_ERROR);
  const text = root.inline;
  if (/ワンタイム|認証コード|画像認証|reCAPTCHA/i.test(text) && text.length < 3000) {
    throw new Error("追加認証が必要です。一休の管理画面で認証を完了してから再実行してください");
  }
}

const pad = (n) => String(n).padStart(2, "0");
const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
export { daysInMonth };

export function parseJapaneseDate(text) {
  const m = String(text ?? "").normalize("NFKC").match(/(\d{4})\s*[/.\-年]\s*(\d{1,2})\s*[/.\-月]\s*(\d{1,2})/);
  if (!m) return null;
  const iso = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso ? iso : null;
}
const parseTime = (text) => {
  const m = String(text ?? "").normalize("NFKC").match(/(\d{1,2}):(\d{2})/);
  return m && Number(m[1]) < 30 && Number(m[2]) < 60 ? `${pad(m[1])}:${m[2]}` : null;
};

// 表の数値。空欄・「-」は未掲載(null)。数字以外が混ざる場合は構造違いとして停止する。
export function parseCount(text) {
  const s = String(text ?? "").normalize("NFKC").replace(/[\s,¥円件組人名PVpv]/g, "");
  if (/^[-‐－ー―—]*$/.test(s)) return null;
  if (/^\d+$/.test(s)) return Number(s);
  throw new Error(`一休の表の数値を読み取れません（${String(text).trim().slice(0, 20)}）`);
}

function rowDate(text, month) {
  const s = String(text ?? "").normalize("NFKC").replace(/\s+/g, "");
  const [year, mon] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  let y = year, mo = mon, d = null;
  let m = s.match(/^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})/);
  if (m) { y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); }
  else if ((m = s.match(/^(\d{1,2})[/月](\d{1,2})日?(?:[(（].[)）])?$/))) { mo = Number(m[1]); d = Number(m[2]); }
  else if ((m = s.match(/^(\d{1,2})日?(?:[(（].[)）])?$/))) d = Number(m[1]);
  if (d == null) return null;
  if (y !== year || mo !== mon || d < 1 || d > daysInMonth(month)) throw new Error("一休の日別PVの日付が選択した月と一致しません");
  return `${month}-${pad(d)}`;
}

const GROUPS = [["guide", /店舗ガイド|店舗トップ|店舗情報/], ["plan", /プラン/], ["other", /その他/]];
const deviceOf = (label) => /スマ|ｽﾏ|^SP$|携帯|モバイル/i.test(label) ? "Sp" : /^PC$|パソコン|^PC/i.test(label) ? "Pc" : /合計|^計$|小計|総計/.test(label) ? "" : null;
export const PV_KEYS = ["guideSp", "guidePc", "guide", "planSp", "planPc", "plan", "otherSp", "otherPc", "other", "sp", "pc", "pv", "reservations", "amount"];

function columnMap(headers) {
  const cols = {};
  headers.forEach((labels, c) => {
    if (c === 0) return;
    const joined = labels.join("/");
    if (/予約/.test(joined)) {
      const key = /金額|売上|額|円/.test(joined) ? "amount" : "reservations";
      if (cols[key] == null) cols[key] = c;
      return;
    }
    const group = GROUPS.find(([, re]) => labels.some((l) => re.test(l)))?.[0] ?? null;
    const devLabel = [...labels].reverse().find((l) => deviceOf(l) != null);
    const device = devLabel == null ? (group ? "" : null) : deviceOf(devLabel);
    if (device == null) return;
    const key = group ? `${group}${device}` : ({ Sp: "sp", Pc: "pc", "": "pv" })[device];
    if (cols[key] == null) cols[key] = c;
  });
  const needed = ["guideSp", "guidePc", "planSp", "planPc"];
  if (needed.some((k) => cols[k] == null)) throw new Error("一休のPV表の列（店舗ガイド・プラン詳細のスマホ/PC）を確認できません");
  return cols;
}

const sum = (values) => (values.every((v) => v != null) ? values.reduce((a, b) => a + b, 0) : null);
function completeRow(values, where) {
  const row = { ...values };
  for (const g of ["guide", "plan", "other"]) {
    const [sp, pc, total] = [row[`${g}Sp`], row[`${g}Pc`], row[g]];
    if (total == null && sp != null && pc != null && row[g] === undefined) row[g] = sp + pc;
    if (sp != null && pc != null && row[g] != null && sp + pc !== row[g]) throw new Error(`一休のPV（${where}）のスマホ・PCの合計が一致しません`);
  }
  // 「その他」列がない画面では0ではなく未掲載のまま
  const has = (k) => row[k] !== undefined;
  const groups = ["guide", "plan", ...(has("otherSp") || has("other") ? ["other"] : [])];
  for (const [dev, key] of [["Sp", "sp"], ["Pc", "pc"], ["", "pv"]]) {
    const computed = sum(groups.map((g) => row[`${g}${dev}`] ?? null));
    if (row[key] != null && computed != null && row[key] !== computed) throw new Error(`一休のPV（${where}）の総合計と内訳が一致しません`);
    if (row[key] == null) row[key] = computed;
  }
  for (const k of PV_KEYS) if (row[k] === undefined) row[k] = null;
  return row;
}

export function parseIkyuPageview(html, month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("一休のPVの対象月が不正です");
  const root = parseHtml(html);
  assertIkyuPage(root);
  const candidates = root.byTag("table").filter((t) => {
    const text = t.rows().map((r) => r.inline).join(" ");
    return /店舗ガイド/.test(text) && /プラン/.test(text);
  });
  let best = null;
  for (const table of candidates) {
    const rows = table.rows();
    const first = rows.findIndex((tr) => { try { return rowDate(tr.cells()[0]?.inline, month) != null; } catch { return true; } });
    if (first > 0 && (!best || rows.length > best.rows.length)) best = { table, rows, first };
  }
  if (!best) {
    // PVが0件の月でも表が出る想定。表自体が見つからない場合は構造違い。
    throw new Error("一休の日別PV表が見つかりません");
  }
  const headers = headerGrid(best.rows.slice(0, best.first));
  const cols = columnMap(headers);
  const days = [];
  let totals = null;
  for (const tr of best.rows.slice(best.first)) {
    const cells = tr.cells();
    const label = cells[0]?.inline ?? "";
    const date = rowDate(label, month);
    const isTotal = !date && /合計|^計$|月計|総計/.test(label.replace(/\s+/g, ""));
    if (!date && !isTotal) continue;
    const values = {};
    for (const [key, c] of Object.entries(cols)) values[key] = cells[c] ? parseCount(cells[c].inline) : null;
    const row = completeRow(values, date ?? "月合計");
    if (date) {
      if (days.some((d) => d.date === date)) throw new Error("一休の日別PVに同じ日付が重複しています");
      days.push({ date, ...row });
    } else totals = row;
  }
  if (!days.length) throw new Error("一休の日別PVの行を読み取れません");
  if (totals) {
    for (const key of PV_KEYS) {
      const total = sum(days.map((d) => d[key]));
      if (totals[key] != null && total != null && totals[key] !== total) throw new Error(`一休の月合計と日別PVの合計が一致しません（${key}）`);
    }
  }
  const months = [...new Set(root.byTag("option").map((o) => {
    const m = `${o.attrs.value ?? ""} ${o.inline}`.normalize("NFKC").match(/(\d{4})\s*[/\-年]\s*(\d{1,2})/);
    return m ? `${m[1]}-${pad(m[2])}` : null;
  }).filter(Boolean))].sort();
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { month, days, totals, months, storeName: readIkyuStoreName(root) };
}

export function readIkyuStoreName(root) {
  const byAttr = root.find((n) => /shop.?name|store.?name|rst.?name|restaurant.?name|tenpo.?name/i.test(`${n.attrs.class ?? ""} ${n.attrs.id ?? ""}`) && n.inline && n.inline.length <= 80);
  if (byAttr) return byAttr.inline.replace(/^店舗名[：:\s]*/, "").replace(/\s*様$/, "").trim() || null;
  const m = root.inline.match(/店舗名\s*[：:]\s*([^\s|｜/]{1,30}(?: [^\s|｜/：:]{1,30}){0,3})/);
  return m ? m[1].replace(/\s*様$/, "").trim() : null;
}

// ---------- クチコミ確認・返信 ----------
const FIELD_PATTERNS = [
  ["reservationNo", /^予約(?:番号|No\.?|ＮＯ)/i],
  ["visitAt", /来店日|ご来店|利用日/],
  ["postedAt", /投稿日/],
  ["publishedAt", /公開日|掲載日/],
  ["handleName", /ハンドル|ニックネーム/],
  ["reviewer", /投稿者|予約者|お名前|氏名/],
  ["publication", /公開状況|公開状態|掲載状況|公開設定|公開・非公開/],
  ["processing", /処理状況|対応状況|返信状況|ステータス|^処理$/],
  ["replyDate", /返信日/],
  ["reply", /返信/],
  ["overall", /^総合/],
  ["title", /タイトル|件名/],
  ["text", /コメント|感想|本文|クチコミ内容|口コミ内容|^内容$|^クチコミ$|^口コミ$/],
];
const CATEGORY = /料理|味|サービス|接客|雰囲気|空間|コスパ|コストパフォーマンス|ドリンク|酒|満足|清潔|評価$/;
const labelKey = (label) => FIELD_PATTERNS.find(([, re]) => re.test(label))?.[0] ?? (CATEGORY.test(label) ? "category" : null);
const cleanLabel = (text) => String(text ?? "").normalize("NFKC").replace(/[\s：:■●◆・*※【】\[\]]+$/g, "").replace(/^[\s■●◆【\[]+/, "").replace(/[】\]]/g, "").trim();

// 値セルの表示テキスト。ボタン・選択肢・スクリプトは除外し、入力欄は入力値を使う。
function valueText(node) {
  const textarea = node.byTag("textarea")[0];
  if (textarea) return textarea.text.replace(/\r\n?/g, "\n").trim();
  const walk = (n) => n.children.map((c) => {
    if (typeof c === "string") return c.replace(/[ \t\n\r\f]+/g, " "); // HTMLの改行は空白扱い（全角空白は保持）
    if (["button", "select", "option", "script", "style"].includes(c.tag)) return "";
    if (c.tag === "br") return "\n";
    if (c.tag === "input") return ["text", "hidden"].includes(String(c.attrs.type ?? "text").toLowerCase()) && c.attrs.readonly != null ? (c.attrs.value ?? "") : "";
    if (c.tag === "img") return c.attrs.alt ?? "";
    return walk(c) + (["p", "div", "li", "tr"].includes(c.tag) ? "\n" : "");
  }).join("");
  return walk(node).replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseRating(text) {
  const s = String(text ?? "").normalize("NFKC").trim();
  const stars = (s.match(/★/g) ?? []).length;
  if (stars && /^[★☆\s]+/.test(s)) return stars <= 5 ? stars : null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 5 ? Math.round(n * 100) / 100 : null;
}

function pairs(block) {
  const out = [];
  const add = (label, node) => { const l = cleanLabel(label); if (l && l.length <= 24) out.push({ label: l, node }); };
  const trs = block.tag === "tr" ? [block] : block.byTag("tr");
  const own = new Set(trs);
  for (let i = 0; i < trs.length; i++) {
    const cells = trs[i].cells().filter((c) => !c.byTag("table").length);
    const next = trs[i + 1] && own.has(trs[i + 1]) && trs[i + 1].parent === trs[i].parent ? trs[i + 1].cells() : null;
    const labelRow = cells.length >= 2 && cells.every((c) => c.tag === "th" || (labelKey(cleanLabel(c.inline)) && c.inline.length <= 16));
    if (labelRow && next && next.length === cells.length && next.every((c) => c.tag === "td")) {
      cells.forEach((c, j) => add(c.inline, next[j]));
      i++;
      continue;
    }
    for (let j = 0; j < cells.length - 1; j++) {
      const c = cells[j];
      const l = cleanLabel(c.inline);
      if ((c.tag === "th" || (labelKey(l) && l.length <= 16)) && cells[j + 1].tag === "td") { add(c.inline, cells[j + 1]); j++; }
    }
  }
  for (const dt of block.byTag("dt")) {
    const siblings = dt.parent.children.filter((c) => typeof c !== "string");
    const dd = siblings[siblings.indexOf(dt) + 1];
    if (dd?.tag === "dd") add(dt.inline, dd);
  }
  return out;
}

// 「予約番号」を1つだけ含む最大の祖先を1件の口コミとして扱う（検索フォームや隣の口コミを含めない）
function reviewBlocks(root) {
  const count = (node) => (node.text.match(/予約(?:番号|No)/gi) ?? []).length;
  const labels = root.all((n) => ["td", "th", "dt", "span", "div", "label", "b", "strong", "p", "li", "font"].includes(n.tag)
    && /^\s*[【\[■●]?\s*予約(?:番号|No)/i.test(n.inline) && n.inline.length <= 40);
  const blocks = new Set();
  for (const label of labels) {
    let block = label;
    while (block.parent && block.parent.tag !== "#root" && count(block.parent) <= 1) block = block.parent;
    blocks.add(block);
  }
  return [...blocks];
}

export function parseIkyuReviews(html, storeId) {
  const listUrl = ikyuReviewListUrl(storeId);
  const root = parseHtml(html);
  assertIkyuPage(root);
  const items = [];
  for (const block of reviewBlocks(root)) {
    const fields = {}, scores = [];
    for (const { label, node } of pairs(block)) {
      const key = labelKey(label);
      if (!key) continue;
      if (key === "category" || key === "overall") {
        const value = parseRating(valueText(node));
        if (key === "overall" && fields.overall === undefined) fields.overall = value;
        if (!scores.some((s) => s.label === label)) scores.push({ label, value, breakdown: null });
        continue;
      }
      if (fields[key] === undefined) fields[key] = valueText(node);
    }
    // 同じセルに「予約番号：123」と書かれている場合
    if (fields.reservationNo === undefined) fields.reservationNo = block.clean.match(/予約(?:番号|No\.?)\s*[：:]?\s*([0-9A-Za-z-]{4,40})/i)?.[1];
    const reservationNo = String(fields.reservationNo ?? "").normalize("NFKC").match(/[0-9A-Za-z][0-9A-Za-z-]{2,39}/)?.[0];
    if (!reservationNo) {
      // 検索フォームの「予約番号」欄は値がないので口コミとして扱わない
      if (fields.overall === undefined && !fields.text) continue;
      throw new Error("一休の口コミの予約番号を確認できません");
    }
    if (fields.overall === undefined && fields.text === undefined && fields.postedAt === undefined) continue;
    const reply = fields.reply && !/^(未返信|未入力|なし|-+)$/.test(fields.reply) ? fields.reply : null;
    const processing = fields.processing?.replace(/\s+/g, " ").trim() || null;
    const visitDate = parseJapaneseDate(fields.visitAt);
    const replied = !!reply || /返信済|対応済|処理済|完了/.test(processing ?? "");
    items.push({
      externalId: `ikyu:${storeId}:${reservationNo}`,
      reservationNo,
      visitDate, visitTime: parseTime(fields.visitAt),
      postedAt: parseJapaneseDate(fields.postedAt), publishedAt: parseJapaneseDate(fields.publishedAt),
      handleName: fields.handleName?.replace(/\s+/g, " ").trim() || null,
      publication: fields.publication?.replace(/\s+/g, " ").trim() || null,
      rating: fields.overall ?? null,
      scores,
      title: fields.title?.trim() ?? "",
      text: fields.text ?? "",
      reply: reply ? { text: reply, date: parseJapaneseDate(fields.replyDate) } : null,
      processing,
      needsReply: !replied,
      listUrl,
    });
  }
  const ids = new Set();
  for (const item of items) { if (ids.has(item.externalId)) throw new Error("一休の口コミが重複しています"); ids.add(item.externalId); }
  const text = root.inline.normalize("NFKC");
  const totalMatch = text.match(/全\s*([\d,]+)\s*件/) ?? text.match(/([\d,]+)\s*件中/) ?? text.match(/検索結果\s*[：:]?\s*([\d,]+)\s*件/) ?? text.match(/([\d,]+)\s*件\s*(?:該当|見つかりました)/);
  const empty = /該当する(?:データ|クチコミ|口コミ)は?(?:ありません|見つかりません)|0\s*件/.test(text) && !items.length;
  const isNext = (label) => { const t = label.normalize("NFKC").replace(/\s+/g, ""); return /^次(?:へ|の\d+件|ページ)?[>›»]*$/.test(t) || /^[>›]$/.test(t); };
  const next = root.all((n) => n.tag === "a" && isNext(n.inline))[0] ?? null;
  return {
    items,
    total: totalMatch ? Number(totalMatch[1].replaceAll(",", "")) : empty ? 0 : null,
    next: next ? { text: next.inline, href: next.attrs.href ?? null } : null,
    storeName: readIkyuStoreName(root),
  };
}

// ---------- 取り込み形式（README「一休.comレストラン（外部取り込み）」）への変換 ----------
const REVIEW_KEYS = ["reservationNo", "visitDate", "visitTime", "postedAt", "publishedAt", "handleName", "publication", "rating", "scores", "title", "text", "reply", "processing", "needsReply"];

// pvPages: [{ month: 'YYYY-MM', html }]、reviewPages: [html, ...]（検索結果の全ページ）
export function buildIkyuStore(storeId, { name = null, pvPages = [], reviewPages = [] } = {}) {
  const months = pvPages.map(({ month, html }) => {
    const parsed = parseIkyuPageview(html, month);
    name = name ?? parsed.storeName;
    return { month, totals: parsed.totals, days: parsed.days };
  });
  let reviews;
  if (reviewPages.length) {
    const items = new Map();
    let total = null;
    for (const html of reviewPages) {
      const part = parseIkyuReviews(html, storeId);
      if (part.total != null) {
        if (total != null && total !== part.total) throw new Error("一休の口コミ件数がページ間で一致しません");
        total = part.total;
      }
      name = name ?? part.storeName;
      for (const item of part.items) items.set(item.externalId, Object.fromEntries(REVIEW_KEYS.map((k) => [k, item[k]])));
    }
    if (total != null && items.size !== total) throw new Error(`一休の口コミが全件そろっていません（${items.size}/${total}件）。全ページのHTMLを指定してください`);
    reviews = { total: total ?? items.size, items: [...items.values()] };
  }
  return { storeId, ...(name ? { name } : {}), ...(months.length ? { pageviews: { months } } : {}), ...(reviews ? { reviews } : {}) };
}

export function buildIkyuPayload({ runId, agent = "grok-bot", capturedAt = new Date().toISOString(), warning, stores }) {
  return { schemaVersion: 1, source: "ikyu", runId, agent, capturedAt, ...(warning ? { warning } : {}), stores };
}
