// AI の回答の決定的な検証（Node/Deno 共通・純粋関数）。
// 回答に書かれた数値・日付・評価・件数を、この質問で呼んだ関数（tools）の結果とサーバーが渡した事実
// （画面の KPI・届いたレポート）だけと照合する。会話履歴の過去の回答は根拠にしない。
// - 合わない値があれば、指摘を付けて1回だけ書き直させる（openai.js answerWithTools）
// - それでも合わなければ、合わない行を取り除き「確認できなかった」と明記する（sanitizeAnswer）
// - 「（推測）」「（予想）」「（予測）」と付いた行は事実の照合から外す（見込み・予想も印を付ければ書ける）。推測の言い回しで印が無い行には自動で「（推測）」を付ける
import { SOURCES } from "./sources.js";

const SITE_PATTERNS = [
  ["tabelog", /食べログ|tabelog/i], ["ikyu", /一休/], ["hotpepper", /ホットペッパー|hot\s*pepper/i],
  ["google", /google|グーグル/i], ["toreta", /トレタ|toreta/i], ["retty", /retty|レッティ/i],
];
const siteIdOf = (v) => {
  const t = String(v ?? "");
  const byId = SOURCES.find((s) => s.id === t || s.name === t);
  if (byId) return byId.id;
  for (const [id, re] of SITE_PATTERNS) if (re.test(t)) return id;
  return null;
};
export const CITATION = /\s*(?:〔|\[)T\d+(?:\s*[,、]\s*T\d+)*(?:〕|\])/g;
export const INFERENCE = /（推測）|\(推測\)|推測です|推測では|推測として|（予想）|\(予想\)|（予測）|\(予測\)/;
const SPECULATION = /おそらく|恐らく|と思われ|と考えられ|可能性があ|可能性が高|かもしれ|推定され|見込まれ|でしょう/;
const LOW_TERMS = /低評価|悪い口コミ|悪い評価|評価の低い|評価が低い|評価\s*3(?:\.0)?\s*(?:以下|未満)|不満/g;
const pad2 = (n) => String(n).padStart(2, "0");
const toNum = (raw) => Number(String(raw).replace(/,/g, ""));

// ---------- 日付の取り出し ----------
// full: YYYY-MM-DD / md: MM-DD / ym: YYYY-MM / y: YYYY / m: MM（「9月」だけ）
function extractDates(text) {
  const out = [];
  let rest = String(text ?? "");
  const take = (re, fn) => { rest = rest.replace(re, (...m) => { const d = fn(m); if (d) out.push({ ...d, raw: m[0] }); return " ".repeat(m[0].length); }); };
  take(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/g, (m) => ({ kind: "full", value: `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` }));
  take(/(\d{4})\s*年\s*(\d{1,2})\s*月/g, (m) => ({ kind: "ym", value: `${m[1]}-${pad2(m[2])}` }));
  take(/(?<![\d.])(\d{4})-(\d{2})(?![\d-])/g, (m) => ({ kind: "ym", value: `${m[1]}-${m[2]}` }));
  take(/(?<![\d.])(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, (m) => ({ kind: "md", value: `${pad2(m[1])}-${pad2(m[2])}` }));
  take(/(?<![\d./,])(\d{1,2})\/(\d{1,2})(?![\d/])/g, (m) => (Number(m[1]) <= 12 && Number(m[2]) <= 31 ? { kind: "md", value: `${pad2(m[1])}-${pad2(m[2])}` } : null));
  take(/(?<![\d.])(\d{4})\s*年(?!\s*\d)/g, (m) => ({ kind: "y", value: m[1] }));
  take(/(?<![\d.])(\d{1,2})\s*月(?![\d日])/g, (m) => (Number(m[1]) >= 1 && Number(m[1]) <= 12 ? { kind: "m", value: pad2(m[1]) } : null));
  return { dates: out, rest };
}

// ---------- 数値の取り出し ----------
const ORDINAL_AFTER = /^\s*(?:点満点|つ目|つの|番目|位(?!置)|項目|段階|文字|秒|時間|分(?!析|布|類|け)|(?:\.\d+)?\s*(?:以下|以上|未満|超|を下回|を上回))/;
const ORDINAL_BEFORE = /(?:第|上位|下位|トップ|直近|最大|最新の?|先頭|No\.?|#)\s*$/i;
function extractNumbers(text, { strictUnitsOnly = false } = {}) {
  const out = [];
  const s = String(text ?? "").replace(/^\s*(?:[-*・•]|\d+[.)．、])\s*/, (m) => " ".repeat(m.length)); // 箇条書きの番号
  const re = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(万)?/g;
  let m;
  while ((m = re.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 6), m.index), after = s.slice(m.index + m[0].length, m.index + m[0].length + 6);
    if (/[A-Za-z_]$/.test(before) || /^[A-Za-z_]/.test(after)) continue; // 型番・ID など
    if (ORDINAL_AFTER.test(after) || ORDINAL_BEFORE.test(before)) continue;
    const unit = /^\s*(件|回|組|人|名|PV|pv|ページビュー|%|％|円|点|★)/.exec(after)?.[1] ?? (/(★|☆|評価|平均)\s*$/.test(before) ? "rating" : "");
    if (strictUnitsOnly && !unit) continue;
    const value = toNum(`${m[1]}${m[2] ? `.${m[2]}` : ""}`);
    out.push({ value, decimals: m[2] ? m[2].length : 0, man: Boolean(m[3]), unit, raw: m[0].trim(), pos: m.index });
  }
  return out;
}

/** 回答の1行ずつの主張（日付・数値・サイト） */
export function extractClaims(text, options = {}) {
  return String(text ?? "").split("\n").map((line, index) => {
    const clean = line.replace(CITATION, "");
    const { dates, rest } = extractDates(clean);
    const numbers = extractNumbers(rest, options);
    const sites = [...new Set(SITE_PATTERNS.filter(([, re]) => re.test(clean)).map(([id]) => id))];
    return { index, line, clean, inference: INFERENCE.test(line), dates, numbers, sites };
  });
}
export const hasClaims = (text) => extractClaims(text).some((c) => !c.inference && (c.dates.length || c.numbers.length));

// ---------- 根拠（関数の結果・サーバーの事実）----------
function newEvidence() {
  return { numbers: [], full: new Set(), md: new Set(), ym: new Set(), y: new Set(), m: new Set(), bySite: new Map(), allowed: new Set(), low: new Set(), unreplied: new Set() };
}
const siteBucket = (ev, site) => { if (!ev.bySite.has(site)) ev.bySite.set(site, { dates: new Set(), md: new Set(), ym: new Set(), ratings: new Set(), numbers: [] }); return ev.bySite.get(site); };
function addDateString(ev, str, bucket) {
  for (const d of extractDates(str).dates) {
    if (d.kind === "full") {
      ev.full.add(d.value); ev.md.add(d.value.slice(5)); ev.ym.add(d.value.slice(0, 7)); ev.y.add(d.value.slice(0, 4)); ev.m.add(d.value.slice(5, 7));
      if (bucket) { bucket.dates.add(d.value); bucket.md.add(d.value.slice(5)); bucket.ym.add(d.value.slice(0, 7)); }
    } else if (d.kind === "ym") { ev.ym.add(d.value); ev.y.add(d.value.slice(0, 4)); ev.m.add(d.value.slice(5, 7)); if (bucket) bucket.ym.add(d.value); }
    else if (d.kind === "md") ev.md.add(d.value);
    else if (d.kind === "y") ev.y.add(d.value);
    else if (d.kind === "m") ev.m.add(d.value);
  }
}
function addNumbersFromString(ev, str) {
  const { rest } = extractDates(str);
  for (const n of extractNumbers(rest)) ev.numbers.push(n.man ? n.value * 10000 : n.value);
}
function walk(ev, value, site = null, depth = 0) {
  if (depth > 12 || value == null) return;
  if (typeof value === "number") { if (Number.isFinite(value)) { ev.numbers.push(value); if (site) siteBucket(ev, site).numbers.push(value); } return; }
  if (typeof value === "string") { addDateString(ev, value, site ? siteBucket(ev, site) : null); addNumbersFromString(ev, value); return; }
  if (Array.isArray(value)) {
    ev.numbers.push(value.length);
    // 配列の要素（オブジェクト）の数値の合計（月別の合算など）
    const sums = new Map();
    for (const item of value) if (item && typeof item === "object" && !Array.isArray(item)) for (const [k, v] of Object.entries(item)) if (typeof v === "number") sums.set(k, (sums.get(k) ?? 0) + v);
    for (const v of sums.values()) ev.numbers.push(v);
    // 一覧の中の件数（サイト別・来店月別・本文の有無・返信状態など）。「食べログの口コミが2件」のような数え上げ
    const counts = new Map();
    const bump = (k) => counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const prims = Object.entries(item).filter(([k, v]) => (typeof v === "string" && v.length <= 40) || typeof v === "boolean").filter(([k]) => k !== "text" && k !== "title");
      for (const [k, v] of prims) bump(`${k}=${v}`);
      const site = item.site ?? item.source;
      if (site != null) for (const [k, v] of prims) if (k !== "site" && k !== "source") bump(`site=${site}&${k}=${v}`);
      if (site != null && item.rating != null) bump(`site=${site}&rating=${item.rating}`);
    }
    for (const v of counts.values()) ev.numbers.push(v);
    for (const item of value) walk(ev, item, site, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const own = siteIdOf(value.site ?? value.source) ?? site;
    if (own && (value.site || value.source) && (value.date || value.visitMonth || value.rating != null)) {
      const b = siteBucket(ev, own);
      if (value.date) addDateString(ev, String(value.date), b);
      if (value.visitMonth) addDateString(ev, String(value.visitMonth), b);
      if (value.rating != null) b.ratings.add(Number(value.rating));
    }
    // 意味の決まった件数（低評価・未返信）。「評価3以下が3件」のような取り違えを見つけるため
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "number" && /lowRating/i.test(k)) ev.low.add(v);
      if (typeof v === "number" && /unreplied/i.test(k)) ev.unreplied.add(v);
    }
    if (value.filter === "low_rating" || value.filter === "unreplied") {
      const set = value.filter === "low_rating" ? ev.low : ev.unreplied;
      for (const k of ["matched", "returned"]) if (typeof value[k] === "number") set.add(value[k]);
      for (const v of Object.values(value.matchedBySite ?? {})) if (typeof v === "number") set.add(v);
    }
    const nums = Object.values(value).filter((v) => typeof v === "number" && Number.isFinite(v)).slice(0, 14);
    // 同じ行の数値どうしの差・和（増減・合計の計算）
    for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) ev.numbers.push(Math.abs(nums[i] - nums[j]), nums[i] + nums[j]);
    for (const [k, v] of Object.entries(value)) walk(ev, v, siteIdOf(k) && typeof v === "object" ? siteIdOf(k) : own, depth + 1);
  }
}
/** sources: 関数の結果（オブジェクトまたはJSON文字列）・サーバーの事実の文字列。allowedText: 質問（利用者が書いた数値は照合しない） */
export function buildEvidence(sources = [], { allowedText = "" } = {}) {
  const ev = newEvidence();
  for (const src of sources) {
    if (src == null) continue;
    if (typeof src === "string") {
      let parsed = null;
      try { parsed = JSON.parse(src); } catch { parsed = null; }
      if (parsed && typeof parsed === "object") walk(ev, parsed); else walk(ev, src);
    } else walk(ev, src);
  }
  for (const n of extractNumbers(extractDates(allowedText).rest)) ev.allowed.add(n.value);
  for (const d of extractDates(allowedText).dates) ev.allowed.add(`${d.kind}:${d.value}`);
  return ev;
}

const roundTo = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
function numberSupported(n, ev) {
  if (ev.allowed.has(n.value)) return true;
  for (const raw of ev.numbers) {
    for (const e0 of [raw, Math.abs(raw)]) {
      const e = n.man ? e0 / 10000 : e0;
      if (Math.abs(e - n.value) < 1e-9) return true;
      if (n.decimals > 0 && Math.abs(roundTo(e, n.decimals) - n.value) < 1e-9) return true;
      if (n.decimals === 0 && (n.man || Math.abs(e) >= 100) && Math.round(e) === n.value) return true;
    }
  }
  return false;
}
function dateSupported(d, ev) {
  if (ev.allowed.has(`${d.kind}:${d.value}`)) return true;
  return ev[d.kind === "full" ? "full" : d.kind]?.has(d.value) ?? false;
}

/** 回答を根拠と照合する。issues の各要素は { index, raw, reason } */
export function verifyAnswer(text, ev, options = {}) {
  const issues = [];
  let claims = 0;
  for (const c of extractClaims(text, options)) {
    if (c.inference) continue;
    for (const d of c.dates) {
      claims++;
      if (!dateSupported(d, ev)) { issues.push({ index: c.index, raw: d.raw, reason: "この日付は関数の結果にありません" }); continue; }
      // サイトと日付の組み合わせ（口コミの投稿日など）: その日付が別のサイトの口コミにだけある
      if (c.sites.length === 1 && (d.kind === "full" || d.kind === "md")) {
        const key = d.kind === "full" ? "dates" : "md";
        const own = ev.bySite.get(c.sites[0]);
        const elsewhere = [...ev.bySite.entries()].some(([s, b]) => s !== c.sites[0] && b[key].has(d.value));
        if (elsewhere && !(own && own[key].has(d.value))) issues.push({ index: c.index, raw: d.raw, reason: `この日付は${SOURCES.find((s) => s.id === c.sites[0])?.name ?? c.sites[0]}の口コミにはありません（別のサイトの口コミの日付です）` });
      }
    }
    // 件数の直前（20文字以内）に「低評価」「未返信」などがあるときだけ、その意味の件数と照合する
    const near = (re, pos) => [...c.clean.matchAll(re)].some((m) => m.index < pos && pos - (m.index + m[0].length) <= 20);
    for (const n of c.numbers) {
      claims++;
      if (!numberSupported(n, ev)) { issues.push({ index: c.index, raw: n.raw, reason: "この数値は関数の結果にありません" }); continue; }
      const lowLine = n.unit === "件" && near(LOW_TERMS, n.pos);
      const unrepliedLine = n.unit === "件" && !lowLine && near(/未返信/g, n.pos);
      if (lowLine || unrepliedLine) {
        const set = lowLine ? ev.low : ev.unreplied;
        const label = lowLine ? "低評価（評価3.0以下）" : "未返信";
        if (!set.has(n.value)) issues.push({ index: c.index, raw: `${n.raw}件`, reason: set.size ? `${label}の件数は関数の結果では ${[...set].join("・")} 件です` : `${label}の件数を関数で確認していません（get_reviews の filter や get_review_stats で確認してください）` });
      }
      if (n.unit === "rating" || n.unit === "★" || n.unit === "点") {
        if (c.sites.length === 1) {
          const own = ev.bySite.get(c.sites[0]);
          const ownHas = own && ([...own.ratings, ...own.numbers].some((e) => Math.abs(roundTo(e, n.decimals) - n.value) < 1e-9));
          const elsewhere = [...ev.bySite.entries()].some(([s, b]) => s !== c.sites[0] && [...b.ratings].some((e) => Math.abs(roundTo(e, n.decimals) - n.value) < 1e-9));
          if (!ownHas && elsewhere) issues.push({ index: c.index, raw: n.raw, reason: "この評価は別のサイトの口コミの値です" });
        }
      }
    }
  }
  return { ok: issues.length === 0, issues, claims };
}

/** 書き直しの指示（合わない値の一覧） */
export function verificationFeedback(issues) {
  const lines = [...new Map(issues.map((i) => [`${i.raw}|${i.reason}`, i])).values()].slice(0, 12).map((i) => `・「${i.raw}」: ${i.reason}`);
  return [
    "【自動検証】回答の次の値が、この質問で呼んだ関数の結果と一致しませんでした。",
    ...lines,
    "関数の結果にある値だけで回答を書き直してください（必要なら関数を呼び直してかまいません）。確認できないことは「データでは確認できません」と書き、推測には「（推測）」と付けてください。対象のサイトと期間も書いてください。",
  ].join("\n");
}

export const SAFE_NO_DATA_ANSWER = "わかりません。データでは確認できませんでした。対象のサイトや期間（例: 「食べログの全期間」「一休の先月」）を指定して、もう一度質問してください。";
export const SANITIZED_NOTE = "※ データで確認できなかった内容は、誤りを避けるため回答から省きました。";

/** 合わない値を含む行を取り除く。中身が残らなければ「わかりません」の定型文 */
export function sanitizeAnswer(text, issues) {
  const bad = new Set(issues.map((i) => i.index));
  const kept = String(text ?? "").split("\n").filter((_, i) => !bad.has(i));
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const substantive = kept.some((l) => l.replace(/[#>*\-・\s|:—]/g, "").length >= 8 && !/^\s*#/.test(l));
  return substantive ? `${body}\n\n${SANITIZED_NOTE}` : SAFE_NO_DATA_ANSWER;
}

/** 推測の言い回しで印が無い行に「（推測）」を付ける */
export function labelSpeculation(text) {
  return String(text ?? "").split("\n").map((line) => (SPECULATION.test(line) && !INFERENCE.test(line) && !/^\s*#/.test(line) ? `${line.replace(/\s+$/, "")}（推測）` : line)).join("\n");
}
export const stripCitations = (text) => String(text ?? "").replace(CITATION, "");

/** 期間（日付・「全期間」）の記載が無ければ、関数の結果の対象を1行足す */
export function ensureScopeMention(text, scopes) {
  const t = String(text ?? "");
  if (!scopes?.length || !hasClaims(t)) return t;
  if (/全期間|\d{4}\s*[-/年]\s*\d{1,2}/.test(t)) return t;
  const uniq = [...new Set(scopes.map((s) => `${s.sites}・${s.period}`))].slice(0, 3);
  return `${t.trim()}\n\n（対象: ${uniq.join(" ／ ")}）`;
}

/** レポートの文章（ai）を集計データと照合する。recommendations の数値は単位つきのものだけ照合する */
export function verifyReportAi(ai, ev) {
  const pieces = [];
  const add = (path, text, opts = {}) => { if (text) pieces.push({ path, text, opts }); };
  ai.summary.forEach((x, i) => add(["summary", i], x));
  for (const k of ["kpiComment", "siteComment", "reviewSentiment", "unrepliedComment"]) add([k], ai[k]);
  for (const k of ["positiveThemes", "negativeThemes"]) ai[k].forEach((t, i) => { add([k, i, "theme"], t.theme); add([k, i, "detail"], t.detail); });
  ai.recommendations.forEach((r, i) => { add(["recommendations", i, "title"], r.title, { strictUnitsOnly: true }); add(["recommendations", i, "detail"], r.detail, { strictUnitsOnly: true }); });
  const issues = [];
  for (const p of pieces) {
    // 文ごとに照合し、合わない文を特定する
    const sentences = p.text.split(/(?<=[。！？])/);
    sentences.forEach((sentence, si) => {
      const r = verifyAnswer(sentence.replace(/\n/g, " "), ev, p.opts);
      for (const i of r.issues) issues.push({ path: p.path, sentence: si, raw: i.raw, reason: i.reason });
    });
  }
  return { ok: issues.length === 0, issues };
}
/** 合わない文を取り除いたレポートの文章。要約・テーマ・提案の項目は、合わない値があれば項目ごと外す */
export function sanitizeReportAi(ai, issues) {
  const out = structuredClone(ai);
  const bySentence = new Map();
  for (const i of issues) {
    const key = JSON.stringify(i.path);
    if (!bySentence.has(key)) bySentence.set(key, new Set());
    bySentence.get(key).add(i.sentence);
  }
  const clean = (text, key) => {
    const bad = bySentence.get(key);
    if (!bad) return text;
    return text.split(/(?<=[。！？])/).filter((_, i) => !bad.has(i)).join("").trim();
  };
  for (const k of ["kpiComment", "siteComment", "reviewSentiment", "unrepliedComment"]) out[k] = clean(out[k], JSON.stringify([k]));
  out.summary = out.summary.filter((_, i) => !bySentence.has(JSON.stringify(["summary", i])));
  for (const k of ["positiveThemes", "negativeThemes"]) out[k] = out[k].filter((_, i) => !bySentence.has(JSON.stringify([k, i, "theme"])) && !bySentence.has(JSON.stringify([k, i, "detail"])));
  out.recommendations = out.recommendations.filter((_, i) => !bySentence.has(JSON.stringify(["recommendations", i, "title"])) && !bySentence.has(JSON.stringify(["recommendations", i, "detail"])));
  if (issues.length) out.summary.push("データで確認できなかった記述は、誤りを避けるため省きました。");
  return out;
}
/** レポートの文章の推測の言い回しに「（推測）」を付ける */
export function labelReportSpeculation(ai) {
  const out = structuredClone(ai);
  const lab = (t) => labelSpeculation(t);
  out.summary = out.summary.map(lab);
  for (const k of ["kpiComment", "siteComment", "reviewSentiment", "unrepliedComment"]) out[k] = lab(out[k]);
  for (const k of ["positiveThemes", "negativeThemes"]) out[k] = out[k].map((t) => ({ ...t, detail: lab(t.detail) }));
  return out;
}
