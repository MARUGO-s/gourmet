// データの鮮度（Node/Deno 共通）。AI分析の答え（アプリの /ask・M-talk の /mtalk-chat）に、使ったサイトごとの
// 「最後に取り込めた日時（日本時間）」と「入っている期間」を付ける。例: 「データ：一休 10/1 18:30取得（9/1〜9/30）」
// 同じ取り込みに日別と月別の両方があれば両方の期間を書く。例: 「食べログ 10/1 15:28取得（日別8/1〜9/30・月別2019/12月〜2026/9月）」
//
// ・取り込み = Grok Bot の毎日の取得（ログインして管理画面のHTMLを保存）→ ingest。答えはこの取り込み済みの確定値だけで作る。
// ・最後の取り込みから36時間を超えたら「古い」、取り込みが1回も無いサイトは「データなし」とはっきり書く。
// ・最後の取得依頼がログイン情報の問題（needs_relogin）で止まっていれば、その理由（決まった文）と「ログイン情報を更新」のボタン（links）を返す。
// 読み込みは本人（持ち主）の user_id で絞った SELECT だけ。読めない表があっても答えは止めない（その項目を「不明」にする）。
import { publicFailureLabel } from "./failure-text.js";
import { loginLinks } from "./login-help.js";
import { SOURCES } from "./sources.js";

export const FRESHNESS = { staleHours: 36 };
// 毎日取り込む手順があるサイト（取り込みが無ければ「データなし」と書く）
export const FRESHNESS_SOURCES = ["ikyu", "tabelog"];
export const FRESHNESS_LABELS = { ikyu: "一休", tabelog: "食べログ", hotpepper: "ホットペッパー", google: "Google", toreta: "トレタ", retty: "Retty" };

const ms = (v) => (v ? Date.parse(v) : NaN);
const jstParts = (v) => { const d = new Date(ms(v) + 9 * 3600_000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
/** ISO → 「10/1 18:30」（日本時間） */
export function jstShort(v) {
  if (!Number.isFinite(ms(v))) return "";
  const p = jstParts(v);
  return `${p.m}/${p.d} ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
}
/** 「2026-09-01」〜「2026-09-30」→「9/1〜9/30」（年が今年でなければ年も付ける） */
/** @param {any} from @param {any} to @param {number | null} [todayYear] */
export function periodLabel(from, to, todayYear = null) {
  const f = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(from ?? "")), t = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(to ?? ""));
  if (!f || !t) return "";
  const one = (m, withYear) => `${withYear ? `${m[1]}/` : ""}${Number(m[2])}${m[3] ? `/${Number(m[3])}` : "月"}`;
  const year = todayYear ?? Number(t[1]);
  const withYear = Number(f[1]) !== year || Number(t[1]) !== year;
  if (f[0] === t[0]) return one(f, withYear); // 同じ日・同じ月は1つだけ（「9月〜9月」と書かない）
  return `${one(f, withYear)}〜${one(t, withYear)}`;
}

/**
 * サイトごとの鮮度。runs = 取り込み [{ source, receivedAt, from, to, monthFrom?, monthTo? }]（from/to はその取り込みで入った日別の範囲、monthFrom/monthTo は月別の範囲）、
 * requests = 最近の取得依頼 [{ id, source, store_id, status, failure_kind, finished_at }]。
 * 返り値: [{ source, label, lastIngestAt, from, to, monthFrom, monthTo, ageHours, stale, missing, failure: { kind, label, at, storeId, requestId } | null }]
 */
export function summarizeFreshness({ runs = [], requests = [], sources = FRESHNESS_SOURCES, now = Date.now() } = {}) {
  const out = [];
  for (const source of sources) {
    const mine = runs.filter((r) => r.source === source && Number.isFinite(ms(r.receivedAt))).sort((a, b) => ms(b.receivedAt) - ms(a.receivedAt));
    const last = mine[0] ?? null;
    const ageHours = last ? Math.max(0, (now - ms(last.receivedAt)) / 3600_000) : null;
    const req = requests.filter((r) => r.source === source && ["done", "failed"].includes(r.status) && Number.isFinite(ms(r.finished_at)))
      .sort((a, b) => ms(b.finished_at) - ms(a.finished_at))[0];
    // 最後の依頼が失敗し、そのあとに取り込みが無いときだけ理由を出す
    const failure = req && req.status === "failed" && (!last || ms(req.finished_at) > ms(last.receivedAt))
      ? { kind: req.failure_kind ?? "other", label: publicFailureLabel(req.failure_kind ?? "other"), at: req.finished_at, storeId: String(req.store_id ?? ""), requestId: req.id ?? null }
      : null;
    out.push({
      source, label: FRESHNESS_LABELS[source] ?? source,
      lastIngestAt: last?.receivedAt ?? null, from: last?.from ?? null, to: last?.to ?? null,
      monthFrom: last?.monthFrom ?? null, monthTo: last?.monthTo ?? null,
      ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
      stale: ageHours != null && ageHours > FRESHNESS.staleHours,
      missing: !last,
      failure,
    });
  }
  return out;
}

/** 入っている期間の文。日別だけ「9/1〜9/30」、月別だけ「8月〜9月」、両方「日別8/1〜9/30・月別2019/12月〜2026/9月」 */
export function coveredLabel(e, todayYear = null) {
  const daily = periodLabel(e?.from, e?.to, todayYear);
  const monthly = periodLabel(e?.monthFrom, e?.monthTo, todayYear);
  if (daily && monthly) return `日別${daily}・月別${monthly}`;
  return daily || monthly;
}

/**
 * 答えの最後に付ける文。
 *   「データ：一休 10/1 18:30取得（9/1〜9/30）／食べログ 10/1 15:28取得（8/1〜9/30）」
 *   古い・無いサイトは「※」の行で理由を書く。
 */
/** @param {any[]} entries @param {{ todayYear?: number | null }} [options] */
export function formatFreshness(entries, { todayYear = null } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return "";
  const heads = list.map((e) => {
    if (e.missing) return `${e.label} 取り込みなし`;
    const period = coveredLabel(e, todayYear);
    return `${e.label} ${jstShort(e.lastIngestAt)}取得${period ? `（${period}）` : ""}`;
  });
  const notes = [];
  for (const e of list) {
    if (e.missing) notes.push(`※${e.label}のデータはまだ取り込まれていません（${e.label}の数値はわかりません）。`);
    else if (e.stale) notes.push(`※${e.label}のデータは最後の取得から${FRESHNESS.staleHours}時間以上たっています（${jstShort(e.lastIngestAt)}取得）。最新の数値ではありません。`);
    if (e.failure) notes.push(`※${e.label}の直近の取得：${e.failure.label}`);
  }
  return [`データ：${heads.join("／")}`, ...notes].join("\n");
}

/** モデルへ渡す前提（system）。数値の照合の根拠にもなる。 */
/** @param {any[]} entries @param {{ todayYear?: number | null }} [options] */
export function freshnessSystemMessage(entries, { todayYear = null } = {}) {
  const text = formatFreshness(entries, { todayYear });
  if (!text) return "";
  return [
    "取り込み済みデータの鮮度（サイトごとの最後の取得日時・入っている期間）:",
    text,
    "期間は最後の取り込みで入った範囲（日別・月別は別。月別の記録は日別の範囲より前の月にもある）。数値の有無は関数の結果で確かめ、関数の結果に無い日付・月だけを「わかりません」と答える。鮮度の行はシステムが回答の最後に付けるので、回答では繰り返さなくてよい。",
  ].join("\n");
}

/** ログイン情報の問題で止まっているサイト → M-talk の「ログイン情報を更新」ボタン（login-help.js）。 */
export function freshnessLinks(entries, storeNames = {}) {
  return loginLinks((entries ?? []).filter((e) => e.failure?.kind === "needs_relogin").map((e) => ({
    source: e.source, storeId: e.failure.storeId, storeName: storeNames[`${e.source}:${e.failure.storeId}`] ?? "", requestId: e.failure.requestId, kind: "needs_relogin",
  })));
}

/** 回答で使ったサイト（関数の結果の sites = 表示名）→ 鮮度を出すサイト。分からなければデータのあるサイト全部。 */
export function sitesForAnswer(usedLabels, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const ids = new Set();
  for (const label of usedLabels ?? []) {
    const hit = list.find((e) => e.label === label || e.source === label || SOURCES.find((x) => x.id === e.source)?.name === label);
    if (hit) ids.add(hit.source);
  }
  return ids.size ? list.filter((e) => ids.has(e.source)) : list;
}

/**
 * 答え（answerWithTools の結果）に付ける鮮度。関数を呼ばなかった答え（あいさつ・使い方）には付けない。
 * 返り値: { text: 鮮度の行（空なら付けない）, links: ログイン情報を更新のボタン }
 */
/** @param {any} result @param {any} ds @param {{ todayYear?: number | null }} [options] */
export function answerFreshness(result, ds, { todayYear = null } = {}) {
  if (!result || !Array.isArray(result.calls) || !result.calls.length) return { text: "", links: [] };
  const entries = sitesForAnswer(result.sites ?? [], ds?.freshness ?? []);
  const names = {};
  for (const s of ds?.sites ?? []) {
    const store = (ds.stores ?? []).find((x) => x.id === s.storeId || x.id === s.store_id);
    if (store) names[`${s.source}:${s.siteStoreKey ?? s.site_store_key ?? ""}`] = store.name;
  }
  return { text: formatFreshness(entries, { todayYear }), links: freshnessLinks(entries, names) };
}

// ---------- 読み込み（本人の user_id で絞った SELECT だけ） ----------
const rows = async (q) => { try { const { data, error } = await q; return error ? [] : (data ?? []); } catch { return []; } };
const day = (v) => (v ? String(v).slice(0, 10) : null);

// 日別の範囲は PV のある行だけ（当日の空行＝まだ数値の無い日を「入っている」と書かない）
async function rangeOf(client, table, runId, extra = (q) => q) {
  const [first, last] = await Promise.all([
    rows(extra(client.from(table).select("date").eq("run_id", runId).not("pv", "is", null)).order("date", { ascending: true }).limit(1)),
    rows(extra(client.from(table).select("date").eq("run_id", runId).not("pv", "is", null)).order("date", { ascending: false }).limit(1)),
  ]);
  return { from: day(first[0]?.date), to: day(last[0]?.date) };
}
async function monthRangeOf(client, table, runId, extra = (q) => q) {
  const [first, last] = await Promise.all([
    rows(extra(client.from(table).select("month").eq("run_id", runId).not("pv", "is", null)).order("month", { ascending: true }).limit(1)),
    rows(extra(client.from(table).select("month").eq("run_id", runId).not("pv", "is", null)).order("month", { ascending: false }).limit(1)),
  ]);
  return { from: first[0]?.month ?? null, to: last[0]?.month ?? null };
}

/** @param {any} client 本人で絞った読み取り用クライアント（RLS の JWT か scopedReadClient） */
export async function loadFreshness(client, { now = Date.now(), sources = FRESHNESS_SOURCES } = {}) {
  try { return await loadFreshnessRows(client, { now, sources }); }
  catch { return []; } // 読めなければ鮮度は付けない（「取り込みなし」と誤って書かない）
}
async function loadFreshnessRows(client, { now, sources }) {
  const [ikyuRuns, agentRuns, requests] = await Promise.all([
    rows(client.from("ikyu_ingest_runs").select("id,received_at").order("received_at", { ascending: false }).limit(1)),
    rows(client.from("agent_ingest_runs").select("id,source,received_at").order("received_at", { ascending: false }).limit(30)),
    rows(client.from("agent_requests").select("id,source,store_id,status,failure_kind,finished_at").in("status", ["done", "failed"]).order("finished_at", { ascending: false }).limit(30)),
  ]);
  const runs = [];
  if (ikyuRuns[0]) {
    const [r, m] = await Promise.all([rangeOf(client, "ikyu_daily_pageviews", ikyuRuns[0].id), monthRangeOf(client, "ikyu_monthly_pageviews", ikyuRuns[0].id)]);
    runs.push({ source: "ikyu", receivedAt: ikyuRuns[0].received_at, ...r, monthFrom: m.from, monthTo: m.to });
  }
  const seen = new Set();
  for (const run of agentRuns) {
    if (seen.has(run.source) || run.source === "ikyu") continue;
    seen.add(run.source);
    const bySource = (q) => q.eq("source", run.source);
    const [r, m] = await Promise.all([rangeOf(client, "source_daily_metrics", run.id, bySource), monthRangeOf(client, "source_monthly_metrics", run.id, bySource)]);
    runs.push({ source: run.source, receivedAt: run.received_at, ...r, monthFrom: m.from, monthTo: m.to });
  }
  const all = [...new Set([...sources, ...runs.map((r) => r.source)])];
  return summarizeFreshness({ runs, requests, sources: all, now });
}
