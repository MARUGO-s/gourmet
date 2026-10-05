// 管理画面のページの保存HTML（site_page_snapshots）。Node/Deno 共通の純粋モジュール。
//
// 毎日の取得（Grok Bot、ログインしてページを開いて保存するだけ）で、ログインごとに当月・前月の分析・統計・予約・プランのページを保存する。
// ・解析済みのページ（parsed）: 保存HTMLを scripts/*-html-to-json.mjs で数値にして /agent-api/ingest へ（従来どおり）。
// ・まだ解析していないページ（raw）: HTMLをそのまま /agent-api/pages/ingest で site_page_snapshots へ（店舗×サイト×ページ×月で最新1件）。
//   サンプルがそろったら解析を足して、保存済みのHTMLから数値を作り直せる（parsed_at で管理）。
// ・予約一覧などお客様の個人情報（氏名・電話・メール・住所）を含むページは pii: true。表は service_role だけが読め（RLS・付与なし）、
//   AI分析の関数・アプリ・M-talk には渡さない。解析するときも個人情報は取り出さない（件数・人数・日時・プラン・金額・状態だけ）。
// ・アカウント・パスワード・カード・口座・APIトークンなどの設定ページは保存しない（カタログに無いページは受け付けない）。
// ・公開 tabelog.com は本カタログ外（PUBLIC_FETCH_CATALOG）。構造化 JSON のみ /ingest。詳細は docs/tabelog-page-snapshots.md。
export const SNAPSHOT_LIMITS = { htmlBytes: 3_000_000, pagesPerRequest: 20, requestBytes: 7_500_000 };

const IKYU_BASE = "https://restaurant.ikyu.com/rsOwner/v2/{storeId}";
const legacy = (path) => `${IKYU_BASE}/legacy?path=/scriptO/${path}`;
const TABELOG = "https://owner.tabelog.com";

// period: "month" = 当月・前月（YYYY-MM）、"current" = 開いた時点の表示（当日の日付 YYYY-MM-DD で保存）
// status: parsed = 解析・取り込み済み（/agent-api/ingest）、raw = 保存HTMLだけ（/agent-api/pages/ingest）
export const PAGE_CATALOG = {
  ikyu: [
    { page: "ikyu_pv_daily", title: "販売集計 › 日付別アクセス（PV・予約件数・金額）", menu: "販売集計", url: `${IKYU_BASE}/legacy?path=/scriptO/rsOwnSalesResultPageviewList.asp?SelMonth={YYYY}/{MM}`, period: "month", status: "parsed", pii: false },
    { page: "ikyu_sales_top", title: "販売集計（トップ）", menu: "販売集計", url: legacy("rsOwnSalesResultTop.asp"), period: "current", status: "raw", pii: false },
    { page: "ikyu_sales_plan", title: "販売集計 › プラン別販売", menu: "販売集計の画面内リンク", url: legacy("rsOwnSalesResultPlanList.asp?SelMonth={YYYY}/{MM}&dateType=1"), period: "month", status: "raw", pii: false, note: "URLは販売集計の画面内のリンクから開く（直接のURLは未確認）" },
    { page: "ikyu_sales_date", title: "販売集計 › 日付別販売", menu: "販売集計の画面内リンク", url: legacy("rsOwnSalesResultDateList.asp?SelMonth={YYYY}/{MM}&dateType=1"), period: "month", status: "raw", pii: false, note: "URLは販売集計の画面内のリンクから開く（直接のURLは未確認）" },
    { page: "ikyu_sales_comparison", title: "前年比", menu: "前年比", url: legacy("salesComparisonDtlDspO.asp"), period: "current", status: "raw", pii: false },
    { page: "ikyu_billing", title: "実績の確認・変更", menu: "実績の確認・変更", url: legacy("rsOwnBillingDtl.asp"), period: "current", status: "raw", pii: true },
    { page: "ikyu_reviews", title: "クチコミ確認・返信", menu: "クチコミ確認・返信", url: legacy("rsOwnImpressions.asp"), period: "current", status: "parsed", pii: false },
    { page: "ikyu_reservations", title: "予約一覧", menu: "予約一覧", url: legacy("rsOwnRsrvSrchList.asp"), period: "current", status: "raw", pii: true },
    { page: "ikyu_reservations_today", title: "本日の予約", menu: "本日の予約", url: legacy("rsOwnRsrvSrchList.asp?dispDate=TODAY"), period: "current", status: "raw", pii: true },
    { page: "ikyu_plans", title: "プラン（一覧・料金・条件・公開状態）", menu: "プラン", url: `${IKYU_BASE}/plans`, period: "current", status: "raw", pii: false },
    { page: "ikyu_plan_calendar", title: "プラン販売カレンダー", menu: "プラン販売カレンダー", url: `${IKYU_BASE}/plans/calendar/`, period: "month", status: "raw", pii: false },
    { page: "ikyu_courses", title: "コース", menu: "コース", url: `${IKYU_BASE}/courses`, period: "current", status: "raw", pii: false },
    { page: "ikyu_inventory_calendar", title: "在庫カレンダー（席・在庫）", menu: "在庫", url: `${IKYU_BASE}/inventories/calendar`, period: "month", status: "raw", pii: false },
    { page: "ikyu_seats", title: "席", menu: "席", url: `${IKYU_BASE}/seats`, period: "current", status: "raw", pii: false },
    { page: "ikyu_seat_groups", title: "カスタム席グループ", menu: "カスタム席グループ", url: `${IKYU_BASE}/seat_groups`, period: "current", status: "raw", pii: false },
    { page: "ikyu_sales_promotions", title: "タイムセール・ポイントアップ", menu: "タイムセール・ポイントアップ", url: "https://restaurant.ikyu.com/rsOwner/v3/{storeId}/sales-promotions", period: "current", status: "raw", pii: false },
    { page: "ikyu_cancel_policy", title: "キャンセルポリシー（プランの条件）", menu: "キャンセルポリシー", url: legacy("rsOwnCancelPolicy.asp"), period: "current", status: "raw", pii: false },
    { page: "ikyu_last_minute", title: "直前割設定", menu: "直前割設定", url: `${IKYU_BASE}/last_minute_promotion`, period: "current", status: "raw", pii: false },
  ],
  tabelog: [
    { page: "tabelog_owner_home", title: "店舗管理トップ（新着ご予約情報）", menu: "トップ", url: `${TABELOG}/owner_rst/`, period: "current", status: "raw", pii: true, note: "新着ご予約情報は件数のみ構造化（scripts/tabelog/owner-home.js）。氏名等の個人情報は取り込まない。HTMLは contains_pii" },
    { page: "tabelog_access_total_daily", title: "アクセス数レポート（日別・端末別）", menu: "アクセス数レポート", url: `${TABELOG}/owner_rst/access_report_total?display_type=daily&start_month={YYYY}{MM}`, period: "month", status: "parsed", pii: false },
    { page: "tabelog_access_total_monthly", title: "アクセス数レポート（月別）", menu: "アクセス数レポート › 月別", url: `${TABELOG}/owner_rst/access_report_total?display_type=monthly`, period: "current", status: "raw", pii: false },
    { page: "tabelog_conversion", title: "来店指標（TEL数・ネット予約数など）", menu: "来店指標", url: `${TABELOG}/owner_rst/access_report_total_conversion`, period: "current", status: "parsed", pii: false },
    { page: "tabelog_tel_conversion", title: "電話効果指標詳細（月別）", menu: "電話効果指標詳細", url: `${TABELOG}/owner_rst/access_report_tel_conversion?display_type=monthly&start_month={PREV_YYYY}{PREV_MM}&end_month={YYYY}{MM}`, period: "month", status: "raw", pii: false },
    { page: "tabelog_my_report", title: "マイレポート（端末別ページサマリー・来店指標）", menu: "マイレポート", url: `${TABELOG}/owner_rst/my_report`, period: "current", status: "parsed", pii: false },
    { page: "tabelog_access_ranking", title: "アクセス数ランキング（エリア内の順位）", menu: "アクセス数ランキング", url: `${TABELOG}/owner_rst/access_ranking?target_month={YYYY}{MM}`, period: "month", status: "parsed", pii: false },
    ...["pc", "smartphone", "smartphone_app"].flatMap((device) => [
      { page: `tabelog_access_${device}_daily`, title: `端末別の日別アクセス数（${device}）`, menu: "アクセス数レポート › 端末別", url: `${TABELOG}/owner_rst/access_report?device=${device}&display_type=daily&start_month={YYYY}{MM}`, period: "month", status: "raw", pii: false },
      { page: `tabelog_access_${device}_top`, title: `端末別の日別アクセス数・店舗トップ（${device}）`, menu: "日別アクセス数", url: `${TABELOG}/owner_rst/access_report?device=${device}&display_type=daily&selected_page=rstdtl_top&start_month={YYYY}{MM}`, period: "month", status: "raw", pii: false },
      { page: `tabelog_access_${device}_total_cnt`, title: `アクセス数の内訳（${device}）`, menu: "アクセス数の内訳", url: `${TABELOG}/owner_rst/access_report?device=${device}&display_type=daily&selected_page=total_cnt&start_month={YYYY}{MM}`, period: "month", status: "raw", pii: false },
      { page: `tabelog_page_report_${device}`, title: `月間ページレポート（${device}）`, menu: "月間ページレポート", url: `${TABELOG}/owner_rst/access_report_page?device=${device}&start_month={PREV_YYYY}{PREV_MM}&end_month={YYYY}{MM}`, period: "month", status: "parsed", pii: false, note: "tabelog-html-to-json.mjs の manifest.pageHistory（pc / sp / app）で取り込む" },
    ]),
    { page: "tabelog_filled_sort_report", title: "設定内容の確認（掲載情報の充実度）", menu: "今すぐ設定内容を確認する", url: `${TABELOG}/owner_rst/filled_sort_report`, period: "current", status: "raw", pii: false },
    { page: "tabelog_kyujin_access", title: "食べログ求人 アクセスレポート", menu: "アクセスレポート（求人）", url: `${TABELOG}/owner_rst/tbkyujin_plan_access_reports`, period: "current", status: "raw", pii: false },
    { page: "tabelog_reviews", title: "口コミ返信（口コミ一覧）", menu: "口コミ返信", url: `${TABELOG}/owner_rst/reply_top/?srt=visit&sby=desc&PG={N}&smp=&lc=2`, period: "current", status: "parsed", pii: false },
    { page: "tabelog_pickup", title: "ピックアップ！口コミ", menu: "ピックアップ！口コミ", url: `${TABELOG}/owner_rst/rstupreview_entry/?srt=visit&sby=desc&PG={N}&smp=&lc=2`, period: "current", status: "parsed", pii: false },
    { page: "tabelog_reservation_results", title: "予約実績の確認", menu: "予約実績の確認", url: `${TABELOG}/owner_payment/monthly_result`, period: "current", status: "raw", pii: true },
    { page: "tabelog_cancel_history", title: "キャンセル料請求の履歴一覧", menu: "履歴一覧", url: `${TABELOG}/owner_rst/owner_cancel_request_history/index`, period: "current", status: "raw", pii: true },
    { page: "tabelog_courses", title: "コース一覧（名前・料金・条件・公開状態）", menu: "コース一覧", url: `${TABELOG}/owner_plan/published_list`, period: "current", status: "raw", pii: false },
    { page: "tabelog_course_calendar", title: "コースの利用可能日", menu: "コースの利用可能日", url: `${TABELOG}/owner_plan/calendar`, period: "current", status: "raw", pii: false },
    { page: "tabelog_seat_type", title: "座席情報", menu: "座席情報", url: `${TABELOG}/owner_rst/seat_type`, period: "current", status: "raw", pii: false },
    { page: "tabelog_vacancy", title: "空席情報", menu: "空席情報", url: `${TABELOG}/owner_vacancy/top`, period: "current", status: "raw", pii: false },
    { page: "tabelog_coupons", title: "クーポン一覧", menu: "クーポン一覧", url: `${TABELOG}/owner_rst/rst_entry_coupon`, period: "current", status: "raw", pii: false },
  ],
};

// 保存しないページ（アカウント・支払い・権限など。間違えて保存しないよう、名前が似ていても受け付けない）
export const NEVER_SAVE = [
  "パスワード変更", "ログインID変更", "オペレータ", "APIトークン", "クレジットカード情報", "口座照会・変更", "口座変更", "会員情報", "請求明細", "契約情報", "通知再受信", "応募者一覧", "メッセージ",
];


// 公開ページ（tabelog.com）は site_page_snapshots には保存しない（ホスト制限）。
// Grok Bot が公開取得し、構造化 JSON を /ingest（agent_reports: public_profile / public_genre_ranking /
// public_competitors / public_new_opens）へ送る。URL 組み立ては scripts/tabelog/store-config.js。
// ルーチンは PUBLIC_FETCH_CATALOG + store-config.publicFetchPlan(storeKey) を参照。
export const PUBLIC_FETCH_CATALOG = [
  { page: "tabelog_public_store", title: "公開店舗ページ（評価・口コミ・保存・予算・駅）", host: "tabelog.com", pathPattern: "/{pref}/{L}/{M}/{storeId8}/", status: "structured", pii: false, note: "scripts/tabelog/public.js → public_profile" },
  { page: "tabelog_public_rank_genre", title: "エリア×ジャンル 評価順一覧", host: "tabelog.com", pathPattern: "/{areaPath}/rstLst/{genre}/?Srt=D&SrtT=rt", status: "structured", pii: false, note: "広告枠スキップ。scripts/tabelog/public-lists.js → public_genre_ranking" },
  { page: "tabelog_public_rank_newopen", title: "エリア×ジャンル ニューオープン順", host: "tabelog.com", pathPattern: "/{areaPath}/rstLst/{genre}/?Srt=D&SrtT=nod", status: "structured", pii: false, note: "scripts/tabelog/public-lists.js → public_new_opens（オープン日は各店公開ページで補完）" },
];

export const pageInfo = (source, page) => (PAGE_CATALOG[source] ?? []).find((p) => p.page === page) ?? null;
export const rawPages = (source) => (PAGE_CATALOG[source] ?? []).filter((p) => p.status === "raw");

const PERIOD = /^(?:\d{4}-(0[1-9]|1[0-2])|\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))$/;
const STORE = /^[0-9A-Za-z_-]{0,40}$/;
const RUN_KEY = /^[0-9A-Za-z._:-]{1,100}$/;
const fail = (message) => { throw new Error(message); };

// フォームに残った秘密の値（パスワード・トークン）を保存前に消す（HTMLの他の部分は変えない）
const SECRET_INPUT = /<input\b[^>]*\b(?:type\s*=\s*["']?password["']?|name\s*=\s*["']?[^"'\s>]*(?:pass|token|csrf|authenticity|secret|session)[^"'\s>]*["']?)[^>]*>/gi;
export function scrubSecrets(html) {
  return String(html ?? "")
    .replace(SECRET_INPUT, (tag) => tag.replace(/\bvalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, 'value=""'))
    .replace(/<meta\b[^>]*name\s*=\s*["']csrf-token["'][^>]*>/gi, "");
}

const byteLength = (s) => new TextEncoder().encode(s).length;

/**
 * /agent-api/pages/ingest の入力 → 保存する行。
 * { schemaVersion: 1, runKey, capturedAt, pages: [{ source, storeKey, page, period, url, html }] }
 */
export function normalizePageSnapshots(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schemaVersion !== 1) fail("schemaVersion 1 の JSON を送ってください");
  const runKey = String(input.runKey ?? "");
  if (!RUN_KEY.test(runKey)) fail("runKey が不正です");
  const capturedAt = input.capturedAt == null ? null : String(input.capturedAt);
  if (capturedAt != null && (!Number.isFinite(Date.parse(capturedAt)) || Date.parse(capturedAt) > now + 10 * 60_000)) fail("capturedAt が不正です");
  const pages = input.pages;
  if (!Array.isArray(pages) || !pages.length || pages.length > SNAPSHOT_LIMITS.pagesPerRequest) fail(`pages は1〜${SNAPSHOT_LIMITS.pagesPerRequest}件です`);
  const seen = new Set();
  let total = 0;
  const rows = pages.map((p, i) => {
    const where = (m) => `pages[${i}]: ${m}`;
    const source = String(p?.source ?? "");
    const info = pageInfo(source, String(p?.page ?? ""));
    if (!info) fail(where("source / page がカタログにありません（page-snapshots.js の PAGE_CATALOG）"));
    const storeKey = String(p.storeKey ?? "");
    if (!STORE.test(storeKey) || (source === "ikyu" && !/^\d{6}$/.test(storeKey))) fail(where("storeKey が不正です"));
    const period = String(p.period ?? "");
    if (!PERIOD.test(period)) fail(where("period は YYYY-MM か YYYY-MM-DD です"));
    if (info.period === "month" && !/^\d{4}-\d{2}$/.test(period)) fail(where("このページの period は YYYY-MM です"));
    let url;
    try { url = new URL(String(p.url ?? "")); } catch { fail(where("url が不正です")); }
    const host = source === "ikyu" ? "restaurant.ikyu.com" : "owner.tabelog.com";
    if (url.protocol !== "https:" || url.hostname !== host) fail(where(`url は https://${host} のページだけです`));
    const html = scrubSecrets(typeof p.html === "string" ? p.html : "");
    if (!/<html|<body|<table|<div/i.test(html)) fail(where("html がありません"));
    const bytes = byteLength(html);
    if (bytes > SNAPSHOT_LIMITS.htmlBytes) fail(where(`html は${SNAPSHOT_LIMITS.htmlBytes}バイトまでです`));
    total += bytes;
    const key = `${source}|${storeKey}|${info.page}|${period}`;
    if (seen.has(key)) fail(where("同じページ・期間が重複しています"));
    seen.add(key);
    return { source, store_key: storeKey, page: info.page, period, url_path: `${url.pathname}${url.search}`.slice(0, 500), html, bytes, contains_pii: info.pii, captured_at: capturedAt, run_key: runKey };
  });
  if (total > SNAPSHOT_LIMITS.requestBytes) fail(`合計は${SNAPSHOT_LIMITS.requestBytes}バイトまでです（分けて送ってください）`);
  return rows;
}

/** 当月・前月（日本時間）→ { cur: {YYYY, MM}, prev: {YYYY, MM} } */
export function targetMonths(now = Date.now()) {
  const d = new Date(now + 9 * 3600_000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const f = ({ y, m }) => ({ YYYY: String(y), MM: String(m).padStart(2, "0"), month: `${y}-${String(m).padStart(2, "0")}` });
  return { cur: f({ y, m }), prev: f(prev) };
}

/** ルーチン用: ログイン1回で保存するページの一覧（URLの {YYYY}{MM} を当月・前月で埋める）。 */
export function routinePageList(source, storeId, now = Date.now()) {
  const { cur, prev } = targetMonths(now);
  const fill = (url, mo) => url.replaceAll("{storeId}", storeId).replaceAll("{YYYY}", mo.YYYY).replaceAll("{MM}", mo.MM)
    .replaceAll("{PREV_YYYY}", prev.YYYY).replaceAll("{PREV_MM}", prev.MM);
  const out = [];
  for (const p of PAGE_CATALOG[source] ?? []) {
    const months = p.period === "month" ? [cur, prev] : [null];
    for (const mo of months) out.push({ page: p.page, title: p.title, status: p.status, pii: p.pii, period: mo ? mo.month : "today", url: fill(p.url, mo ?? cur) });
  }
  return out;
}
