// 一休.comレストラン: 外部取り込み（Grok Bot → agent-api）の検証・正規化と、ダッシュボード読み込み。
// Node/Edge 共通の純粋モジュール。取り込み契約は README「一休.comレストラン（外部取り込み）」。
import { japanDate } from "./sync-data.js";

export const IKYU_SCHEMA_VERSION = 1;
export const IKYU_PV_KEYS = ["guideSp", "guidePc", "guide", "planSp", "planPc", "plan", "otherSp", "otherPc", "other", "sp", "pc", "pv", "reservations", "amount"];
const DB_COLUMN = {
  guideSp: "guide_sp", guidePc: "guide_pc", guide: "guide_total", planSp: "plan_sp", planPc: "plan_pc", plan: "plan_total",
  otherSp: "other_sp", otherPc: "other_pc", other: "other_total", sp: "sp", pc: "pc", pv: "pv", reservations: "reservations", amount: "reservation_amount",
};
export const IKYU_DB_COLUMNS = Object.values(DB_COLUMN);
export const IKYU_LIMITS = { stores: 50, monthsPerStore: 40, reviewsPerStore: 1000, publicReviewsPerStore: 1000 };

export const ikyuReviewListUrl = (storeId) => {
  if (!/^\d{6}$/.test(String(storeId))) throw new Error("一休の店舗IDが不正です");
  return `https://restaurant.ikyu.com/rsOwner/v2/${storeId}/legacy?path=/scriptO/rsOwnImpressions.asp`;
};

const fail = (message) => { throw new Error(message); };
const count = (v) => v == null || (Number.isSafeInteger(v) && v >= 0 && v <= 1e11);
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validMonth = (value) => typeof value === "string" && /^\d{4}-\d{2}$/.test(value) && validDate(`${value}-01`);
const optDate = (v) => v == null || validDate(v);
const optText = (v, max) => v == null || (typeof v === "string" && v.length <= max);
export const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

export function checkPvRow(row, where) {
  if (!row || typeof row !== "object") fail(`一休のPV（${where}）の形式が不正です`);
  for (const key of IKYU_PV_KEYS) if (!count(row[key])) fail(`一休のPV（${where}）の数値が不正です（${key}）`);
  for (const g of ["guide", "plan", "other"]) {
    const [sp, pc, total] = [row[`${g}Sp`], row[`${g}Pc`], row[g]];
    if (sp != null && pc != null && total != null && sp + pc !== total) fail(`一休のPV（${where}）の内訳が合計と一致しません（${g}）`);
  }
  const parts = ["guide", "plan", "other"].map((g) => row[g]);
  if (row.pv != null && parts.every((v) => v != null) && parts.reduce((a, b) => a + b, 0) !== row.pv) fail(`一休のPV（${where}）の総合計が一致しません`);
  if (row.pv != null && row.sp != null && row.pc != null && row.sp + row.pc !== row.pv) fail(`一休のPV（${where}）のスマホ・PC合計が一致しません`);
}

const pick = (row) => Object.fromEntries(IKYU_PV_KEYS.map((k) => [DB_COLUMN[k], row?.[k] ?? null]));
const sumKey = (days, key) => (days.length && days.every((d) => d[key] != null) ? days.reduce((a, d) => a + d[key], 0) : null);
const repliedStatus = /返信済|対応済|処理済|完了/;

// 取り込み本文を検証し、ingest_ikyu(p_run, p_stores) の形へ変換する。
// 当日（集計中）以降の日は保存しない。確定月の判定はサーバー側で行う（送信側の complete は使わない）。
export function normalizeIkyuIngest(payload, today = japanDate()) {
  if (!payload || typeof payload !== "object") fail("取り込みデータの形式が不正です");
  if (payload.schemaVersion !== IKYU_SCHEMA_VERSION) fail(`schemaVersion は ${IKYU_SCHEMA_VERSION} を指定してください`);
  if (payload.source != null && payload.source !== "ikyu") fail("一休の取り込みでは source は \"ikyu\" です");
  if (typeof payload.runId !== "string" || !/^[0-9A-Za-z._:-]{1,100}$/.test(payload.runId)) fail("runId が不正です（英数字と ._:- の1〜100文字）");
  if (!optText(payload.agent, 100) || !optText(payload.warning, 1000)) fail("agent または warning が不正です");
  if (payload.capturedAt != null && (typeof payload.capturedAt !== "string" || !Number.isFinite(Date.parse(payload.capturedAt)))) fail("capturedAt が不正です");
  if (!Array.isArray(payload.stores) || !payload.stores.length || payload.stores.length > IKYU_LIMITS.stores) fail(`stores は1〜${IKYU_LIMITS.stores}店舗で指定してください`);
  const current = today.slice(0, 7);
  const ids = new Set();
  let skippedDays = 0, hasData = false;
  const stores = payload.stores.map((store) => {
    if (!store || !/^\d{6}$/.test(String(store.storeId)) || ids.has(store.storeId)) fail("storeId が不正または重複しています（6桁の数字）");
    ids.add(store.storeId);
    if (!optText(store.name, 200)) fail("店舗名が不正です");
    const months = store.pageviews?.months ?? [];
    if (!Array.isArray(months) || months.length > IKYU_LIMITS.monthsPerStore) fail(`月数は店舗あたり${IKYU_LIMITS.monthsPerStore}か月までです`);
    const seenMonths = new Set(), seenDays = new Set(), days = [], monthRows = [];
    for (const m of months) {
      if (!validMonth(m?.month) || seenMonths.has(m.month) || m.month > current || !Array.isArray(m.days)) fail("pageviews.months[].month が不正です（YYYY-MM、当月以前、重複なし）");
      seenMonths.add(m.month);
      if (m.totals != null) checkPvRow(m.totals, `${m.month}の合計`);
      const kept = [];
      for (const d of m.days) {
        if (!validDate(d?.date) || d.date.slice(0, 7) !== m.month || seenDays.has(d.date)) fail("pageviews.months[].days[].date が不正です（その月の日付、重複なし）");
        seenDays.add(d.date);
        checkPvRow(d, d.date);
        if (d.date >= today) { skippedDays++; continue; }
        kept.push(d);
      }
      if (m.totals) {
        // 合計行は集計中の当日分を含むことがあるため、当日を除く前の全日で照合する
        for (const key of IKYU_PV_KEYS) {
          const total = sumKey(m.days, key);
          if (m.totals[key] != null && total != null && m.days.length === daysInMonth(m.month) && m.totals[key] !== total) fail(`一休の月合計と日別PVの合計が一致しません（${m.month} ${key}）`);
        }
      }
      const complete = m.month < current && kept.length === daysInMonth(m.month) && kept.every((d) => d.pv != null);
      days.push(...kept.map((d) => ({ date: d.date, ...pick(d) })));
      monthRows.push({ month: m.month, complete, days: kept.length, ...pick(Object.fromEntries(IKYU_PV_KEYS.map((k) => [k, m.totals?.[k] ?? sumKey(kept, k)]))) });
      if (kept.length) hasData = true;
    }
    const reviewBlock = store.reviews;
    const items = reviewBlock?.items ?? [];
    if (reviewBlock != null && (!Array.isArray(items) || items.length > IKYU_LIMITS.reviewsPerStore)) fail(`reviews.items は店舗あたり${IKYU_LIMITS.reviewsPerStore}件までです`);
    if (reviewBlock?.total != null && !count(reviewBlock.total)) fail("reviews.total が不正です");
    const seen = new Set();
    const reviews = items.map((r) => {
      const no = String(r?.reservationNo ?? "");
      if (!/^[0-9A-Za-z-]{1,40}$/.test(no) || seen.has(no)) fail("reviews.items[].reservationNo が不正または重複しています");
      seen.add(no);
      if (![r.visitDate, r.postedAt, r.publishedAt, r.reply?.date].every(optDate)) fail(`口コミ（予約番号${no}）の日付が不正です（YYYY-MM-DD）`);
      if (r.visitTime != null && !/^\d{2}:\d{2}$/.test(r.visitTime)) fail(`口コミ（予約番号${no}）の来店時刻が不正です（HH:MM）`);
      const scores = r.scores ?? [];
      if (!Array.isArray(scores) || scores.length > 20) fail(`口コミ（予約番号${no}）の個別評価が不正です`);
      for (const s of [{ label: "総合", value: r.rating }, ...scores]) {
        if (typeof s?.label !== "string" || s.label.length > 50 || (s.value != null && (!Number.isFinite(s.value) || s.value < 0 || s.value > 5))) fail(`口コミ（予約番号${no}）の点数が不正です（0〜5）`);
      }
      if (typeof (r.text ?? "") !== "string" || (r.text ?? "").length > 50000 || !optText(r.title, 1000) || !optText(r.handleName, 300)
        || !optText(r.publication, 100) || !optText(r.processing, 100) || (r.reply != null && (typeof r.reply.text !== "string" || r.reply.text.length > 50000))) fail(`口コミ（予約番号${no}）の本文・項目の形式が不正です`);
      if (r.needsReply != null && typeof r.needsReply !== "boolean") fail(`口コミ（予約番号${no}）の needsReply は true/false です`);
      const replyText = r.reply?.text?.trim() ? r.reply.text : null;
      hasData = true;
      return {
        reservation_no: no, visit_date: r.visitDate ?? null, visit_time: r.visitTime ?? null,
        posted_at: r.postedAt ?? null, published_at: r.publishedAt ?? null,
        handle_name: r.handleName?.trim() || null, publication: r.publication ?? null,
        rating: r.rating == null ? null : Math.round(r.rating * 100) / 100,
        scores: scores.map((s) => ({ label: s.label, value: s.value == null ? null : Math.round(s.value * 100) / 100 })),
        title: r.title ?? "", text: r.text ?? "", reply_text: replyText, reply_date: replyText ? r.reply?.date ?? null : null,
        processing: r.processing ?? null,
        needs_reply: r.needsReply ?? !(replyText || repliedStatus.test(r.processing ?? "")),
      };
    });
    const pub = normalizeIkyuPublic(store.storeId, store.public);
    if (pub && (pub.rating != null || pub.review_count != null || pub.reviews.length)) hasData = true;
    return {
      store_id: store.storeId, name: store.name?.trim() || null,
      review_total: reviewBlock?.total ?? null, reviews_included: reviewBlock != null,
      days, months: monthRows, reviews, public: pub,
    };
  });
  if (!hasData) fail("保存できるデータがありません（当日以前の日別PV・口コミ・公開ページの評価のいずれかを含めてください）");
  const warning = payload.warning?.trim() || "";
  return {
    run: {
      run_key: payload.runId, agent: payload.agent ?? "", captured_at: payload.capturedAt ?? null,
      status: warning ? "partial" : "ok",
      message: [warning, skippedDays ? `当日以降の${skippedDays}日分は集計中のため保存しませんでした` : ""].filter(Boolean).join(" / ").slice(0, 1000),
    },
    stores, skippedDays,
  };
}

// 公開ページ（restaurant.ikyu.com/<店舗ID>）の評価・口コミ数・口コミ。PR #11 と同じ口コミID（I<店舗ID>:<投稿者ID>）で
// 旧 reviews 表（source='ikyu'）へ保存するため、#11 で取り込んだ行はそのまま更新される。
export function normalizeIkyuPublic(storeId, block) {
  if (block == null) return null;
  if (typeof block !== "object" || Array.isArray(block)) fail("public の形式が不正です");
  if (block.rating != null && (!Number.isFinite(block.rating) || block.rating < 0 || block.rating > 5)) fail("public.rating は0〜5です");
  if (block.reviewCount != null && !count(block.reviewCount)) fail("public.reviewCount が不正です");
  const items = block.reviews ?? [];
  if (!Array.isArray(items) || items.length > IKYU_LIMITS.publicReviewsPerStore) fail(`public.reviews は店舗あたり${IKYU_LIMITS.publicReviewsPerStore}件までです`);
  const idPattern = new RegExp(`^I${storeId}:[0-9a-f]{8,64}$`);
  const seen = new Set();
  const reviews = items.map((r) => {
    const id = String(r?.externalId ?? "");
    if (!idPattern.test(id) || seen.has(id)) fail("public.reviews[].externalId が不正または重複しています（I<店舗ID>:<投稿者ID>）");
    seen.add(id);
    if (!validDate(r.date) || !Number.isFinite(r.rating) || r.rating < 0 || r.rating > 5) fail(`公開口コミ（${id}）の日付または点数が不正です`);
    if (typeof r.text !== "string" || !r.text.trim() || r.text.length > 50000 || !optText(r.author, 300)) fail(`公開口コミ（${id}）の本文の形式が不正です`);
    return { external_id: id, author: r.author?.trim() || "匿名", rating: Math.round(r.rating * 100) / 100, text: r.text, review_date: r.date };
  });
  return {
    rating: block.rating == null ? null : Math.round(block.rating * 100) / 100,
    review_count: block.reviewCount ?? null,
    reviews,
  };
}

// 旧 reviews 表の一休公開口コミのうち、管理画面から取り込んだ口コミ（ikyu_reviews）と本文が同じものは重複として表示しない。
export function dropPublicDuplicates(legacy, owner) {
  const norm = (t) => String(t ?? "").replace(/\s+/g, "");
  const texts = new Set(owner.map((r) => norm(r.text)).filter(Boolean));
  return legacy.filter((r) => r.source !== "ikyu" || !texts.has(norm(r.text)));
}

// ---------- ダッシュボード（ブラウザ用・SELECTのみ） ----------
const camel = (row) => Object.fromEntries(IKYU_PV_KEYS.map((k) => [k, row[DB_COLUMN[k]] == null ? null : Number(row[DB_COLUMN[k]])]));
async function all(query) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await query().range(offset, offset + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

// ikyu_reviews → 共通の口コミ一覧の行
export function ikyuReviewRow(r, storeName) {
  return {
    id: `ikyu:${r.store_id}:${r.reservation_no}`, source: "ikyu", rating: r.rating == null ? null : Number(r.rating),
    text: r.text ?? "", author: r.handle_name || "匿名", sentiment: "neutral", date: r.posted_at ?? r.published_at ?? null,
    external_id: `ikyu:${r.store_id}:${r.reservation_no}`, title: r.title ?? "", visit_month: r.visit_date ? String(r.visit_date).slice(0, 7) : null,
    details: {
      origin: "ikyu_owner", textComplete: true, storeId: r.store_id, storeName: storeName ?? null, reservationNo: r.reservation_no,
      visitDate: r.visit_date ?? null, visitTime: r.visit_time ?? null, postedAt: r.posted_at ?? null, publishedAt: r.published_at ?? null,
      publication: r.publication ?? null,
      scores: (r.scores ?? []).map((s) => ({ label: s.label, value: s.value == null ? null : Number(s.value), breakdown: null })),
      ownerReply: r.reply_text ? { text: r.reply_text, date: r.reply_date ?? "", status: r.processing ?? "" } : null,
      processing: r.processing ?? null, needsReply: !!r.needs_reply, listUrl: ikyuReviewListUrl(r.store_id),
    },
  };
}

export async function loadIkyuReviews(client) {
  const [reviews, stores] = await Promise.all([
    all(() => client.from("ikyu_reviews").select("store_id,reservation_no,visit_date,visit_time,posted_at,published_at,handle_name,publication,rating,scores,title,text,reply_text,reply_date,processing,needs_reply").order("store_id").order("reservation_no")),
    all(() => client.from("ikyu_stores").select("store_id,name").order("store_id")),
  ]);
  const names = new Map(stores.map((s) => [s.store_id, s.name]));
  return reviews.map((r) => ikyuReviewRow(r, names.get(r.store_id)));
}

export async function loadIkyuDetails(client, fromDate) {
  try {
    const [creds, stores, months, daily, runs] = await Promise.all([
      all(() => client.from("credentials").select("store_key,label,updated_at").eq("source", "ikyu").order("store_key")),
      all(() => client.from("ikyu_stores").select("store_id,name,review_total,pageviews_updated_at,reviews_updated_at,public_rating,public_review_count,public_updated_at,updated_at").order("store_id")),
      all(() => client.from("ikyu_monthly_pageviews").select(`store_id,month,complete,days,updated_at,${IKYU_DB_COLUMNS.join(",")}`).order("month").order("store_id")),
      all(() => client.from("ikyu_daily_pageviews").select(`store_id,date,${IKYU_DB_COLUMNS.join(",")}`).gte("date", fromDate).order("date").order("store_id")),
      client.from("ikyu_ingest_runs").select("run_key,agent,captured_at,received_at,status,stores,days,months,reviews,new_reviews,message").order("received_at", { ascending: false }).limit(5).then((r) => { if (r.error) throw r.error; return r.data; }),
    ]);
    const byId = new Map();
    for (const c of creds) if (/^\d{6}$/.test(c.store_key)) byId.set(c.store_key, { storeId: c.store_key, name: null, label: c.label || null, credentialUpdatedAt: c.updated_at, reviewTotal: null, pageviewsUpdatedAt: null, reviewsUpdatedAt: null, publicRating: null, publicReviewCount: null, publicUpdatedAt: null });
    for (const s of stores) {
      byId.set(s.store_id, { label: null, credentialUpdatedAt: null, ...byId.get(s.store_id), storeId: s.store_id, name: s.name, reviewTotal: s.review_total, pageviewsUpdatedAt: s.pageviews_updated_at, reviewsUpdatedAt: s.reviews_updated_at,
        publicRating: s.public_rating == null ? null : Number(s.public_rating), publicReviewCount: s.public_review_count, publicUpdatedAt: s.public_updated_at });
    }
    return {
      stores: [...byId.values()].sort((a, b) => a.storeId.localeCompare(b.storeId)),
      months: months.map((m) => ({ storeId: m.store_id, month: m.month, complete: m.complete, days: m.days, ...camel(m) })),
      daily: daily.map((d) => ({ storeId: d.store_id, date: d.date, ...camel(d) })),
      runs: runs.map((r) => ({ runKey: r.run_key, agent: r.agent, capturedAt: r.captured_at, receivedAt: r.received_at, status: r.status, stores: r.stores, days: r.days, months: r.months, reviews: r.reviews, newReviews: r.new_reviews, message: r.message })),
    };
  } catch (error) {
    console.warn(`[dashboard] ikyu details unavailable: ${error?.message ?? error}`);
    return { unavailable: true };
  }
}
