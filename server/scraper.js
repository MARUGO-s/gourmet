// Playwright 同期エンジン。
// 店舗管理画面にログインし、取得項目ごとに進捗と失敗理由を返す。
// HTMLの調査用保存は SCRAPER_DEBUG_DUMPS=true の場合だけ有効。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSource } from "./sources.js";
import { decrypt } from "./crypto.js";
import { japanDate } from "./sync-data.js";
import { collectTabelogMetrics } from "./tabelog-result.js";
import { collectTabelogPublicData } from "./tabelog-public.js";
import { collectOwnerReviews, collectOwnerDaily, collectPageHistory, readOwnerPublicUrl, selectAllMonths } from "./tabelog-owner.js";
import { collectIkyuPublic } from "./ikyu-public.js";
import { unpackIkyuUsername } from "../supabase/functions/_shared/ikyu-login.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUMP_DIR = path.join(__dirname, "..", "data", "dump");

let cachedPw = undefined;

async function loadPlaywright() {
  if (cachedPw !== undefined) return cachedPw;
  try {
    cachedPw = await import("playwright");
  } catch {
    cachedPw = null;
  }
  return cachedPw;
}

async function launchBrowser(pw) {
  // インストール済みChromeを優先。なければPlaywright Chromium。
  try {
    await fs.promises.stat("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    return await pw.chromium.launch({ headless: true, channel: "chrome", timeout: 30000 });
  } catch {
    return await pw.chromium.launch({ headless: true, timeout: 30000 });
  }
}

function waitRandom(min, max) {
  return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
}

const err = (step, message) => ({ status: "error", step, message });

// ---------- 食べログ: 日別PV（アクセス数レポートの Highcharts「総合」とデバイス別系列） ----------
// x は日付の UTC 0時。集計中の当日以降だけを除外し、確定日の0PVは保持する。
export function toDailyPv(total, devices = {}, today = japanDate()) {
  const valid = (point) => Number.isFinite(point.x) && Number.isFinite(point.y);
  const byX = (points) => new Map((points ?? []).filter(valid).map((point) => [point.x, point.y]));
  const pc = byX(devices.pc);
  const sp = byX(devices.sp);
  const app = byX(devices.app);
  const daily = total.filter(valid).map((point) => ({
    date: new Date(point.x).toISOString().slice(0, 10),
    pv: point.y,
    pc: pc.get(point.x) ?? null,
    sp: sp.get(point.x) ?? null,
    app: app.get(point.x) ?? null,
  }));
  return daily.filter((d) => d.date < today).sort((a, b) => a.date.localeCompare(b.date));
}

async function extractTabelogDailyPv(page) {
  await page.goto("https://owner.tabelog.com/owner_rst/access_report_total/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await assertAuthenticated(page);
  await page
    .waitForFunction(
      () => window.Highcharts?.charts?.some((chart) => chart?.series?.some((s) => s.data?.length > 0)),
      null,
      { timeout: 15000 },
    )
    .catch(() => {});
  await dumpChartPage(page, "report-access-tabelog");
  const raw = await page.evaluate(() => {
    const series = (window.Highcharts?.charts ?? []).filter(Boolean).flatMap((chart) => chart.series);
    const clean = (name) => String(name ?? "").replace(/<[^>]+>/g, "").trim();
    const points = (name) => {
      const found = series.find((s) => clean(s.name) === name);
      return found ? found.data.map((point) => ({ x: point.x, y: point.y })) : null;
    };
    return {
      seriesNames: series.map((s) => clean(s.name)),
      total: points("総合"),
      devices: { pc: points("PC版"), sp: points("スマートフォン版"), app: points("アプリ版") },
    };
  });
  return {
    daily: raw.total ? toDailyPv(raw.total, raw.devices) : null,
    seriesNames: raw.seriesNames,
  };
}

// ---------- 食べログ: 月別の来店指標とデバイス別PV（来店指標ページの表 #data-cvr-alldevice） ----------
// 見出しは2段（rowspan/colspan）なので列位置を格子に展開してから各列を見出し名で特定する。
// page.evaluate に渡すため外部変数を参照しないこと。
export function readConversionTable() {
  const table = document.querySelector("#data-cvr-alldevice");
  if (!table) return { months: null, headers: [] };
  const rows = [...table.querySelectorAll("tr")];
  const isDataRow = (tr) => /^\d{4}-\d{2}$/.test(tr.cells[0]?.textContent.trim() ?? "");
  const firstData = rows.findIndex(isDataRow);
  const headerRows = firstData < 0 ? rows : rows.slice(0, firstData);
  const grid = [];
  headerRows.forEach((tr, r) => {
    grid[r] = grid[r] ?? [];
    let c = 0;
    for (const cell of tr.cells) {
      while (grid[r][c] !== undefined) c++;
      const text = cell.textContent.replace(/\s+/g, "");
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        grid[r + dr] = grid[r + dr] ?? [];
        for (let dc = 0; dc < cell.colSpan; dc++) grid[r + dr][c + dc] = text;
      }
      c += cell.colSpan;
    }
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  const headers = Array.from({ length: width }, (_, c) =>
    [...new Set(grid.map((row) => row[c]).filter(Boolean))].join("/"),
  );
  // 「【PC】地図印刷ページへのアクセス数（PV）」も「アクセス数」を含むため、地図印刷を先に除外して判定する
  const find = (test) => headers.findIndex((label) => test(label));
  const cols = {
    reservations: find((l) => l.includes("インターネット予約組数")),
    calls: find((l) => l.includes("通話成立数")),
    mapPrints: find((l) => l.includes("地図印刷")),
    pv: find((l) => !l.includes("地図印刷") && l.startsWith("アクセス数")),
    pc: find((l) => l === "PC" || l.endsWith("/PC")),
    sp: find((l) => l.includes("スマートフォン")),
    app: find((l) => l.includes("アプリ")),
  };
  if (cols.reservations < 0) return { months: null, headers };
  const num = (tr, col) => {
    const text = col >= 0 ? (tr.cells[col]?.textContent ?? "") : "";
    return /\d/.test(text) ? Number(text.replace(/[^\d]/g, "")) : null;
  };
  const months = rows
    .filter(isDataRow)
    .map((tr) => {
      const entry = { month: tr.cells[0].textContent.trim() };
      for (const [key, col] of Object.entries(cols)) entry[key] = num(tr, col);
      if([entry.pv,entry.pc,entry.sp,entry.app].every(n=>n!=null)) {
        const difference=entry.pv-entry.pc-entry.sp-entry.app;
        if(difference<0)throw new Error('管理画面の月別PVの内訳が総合値を超えています');
        if(difference)entry.unclassified=difference;
      }
      return entry;
    });
  return { months, headers };
}

async function extractTabelogConversion(page) {
  await page.goto("https://owner.tabelog.com/owner_rst/access_report_total_conversion", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await assertAuthenticated(page);
  const range=await selectAllMonths(page, assertAuthenticated);
  await page.locator("#data-cvr-alldevice").waitFor({ state: "attached", timeout: 15000 });
  await dumpChartPage(page, "report-conversion-tabelog");
  const result=await page.evaluate(readConversionTable);
  const ordinal=m=>Number(m.slice(0,4))*12+Number(m.slice(-2));
  if(result.months?.length!==ordinal(range.last)-ordinal(range.first)+1 || new Set(result.months.map(m=>m.month)).size!==result.months.length)throw new Error('月別レポートの全期間を取得できませんでした');
  return result;
}

// セレクタ調整用: ページHTMLと全グラフの系列データを data/dump/ に保存する
async function dumpChartPage(page, name) {
  if (process.env.SCRAPER_DEBUG_DUMPS !== "true") return;
  try {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    fs.writeFileSync(path.join(DUMP_DIR, `${name}.html`), await page.content());
    const charts = await page.evaluate(() =>
      (window.Highcharts?.charts ?? []).filter(Boolean).map((chart) => ({
        container: chart.renderTo?.id ?? null,
        title: chart.title?.textStr ?? null,
        categories: chart.xAxis?.[0]?.categories ?? null,
        series: chart.series.map((series) => ({
          name: String(series.name ?? ""),
          points: series.data.map((point) => ({ x: point.x, y: point.y, category: point.category })),
        })),
      })),
    );
    fs.writeFileSync(
      path.join(DUMP_DIR, `${name}.json`),
      JSON.stringify({ url: page.url(), title: await page.title(), charts }, null, 2),
    );
  } catch (e) {
    console.error(`dump ${name} failed`, e);
  }
}

// ---------- 食べログ: エリア内アクセスランキング（マイレポート上位5件・アクセスランキングページ共通） ----------
// 行は td.rank / td.rname / td.access / td.compare。page.evaluate に渡すため外部変数を参照しないこと。
export function readRanking() {
  const clean = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const digits = (s) => (/\d/.test(s) ? Number(s.replace(/[^\d]/g, "")) : null);
  const entries = [...document.querySelectorAll("tr")]
    .filter((tr) => tr.querySelector(".rank") && tr.querySelector(".rname"))
    .map((tr) => {
      const compare = clean(tr.querySelector(".compare")).match(/[-+]?\d+(?:\.\d+)?/);
      return {
        rank: digits(clean(tr.querySelector(".rank"))),
        name: clean(tr.querySelector(".rname")),
        pv: digits(clean(tr.querySelector(".access"))),
        momPct: compare ? Number(compare[0]) : null,
      };
    })
    .filter((entry) => entry.rank != null && entry.name);
  const text = clean(document.body);
  return {
    area: clean(document.querySelector("#ranking-area strong")) || text.match(/「([^」]+)」エリア内/)?.[1] || null,
    updatedAt: text.match(/更新日[：:]\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
    shopName: text.match(/は、(.+?)様が属する/)?.[1]?.trim() ?? null,
    entries,
  };
}

// 全件ページ（自店の順位を含む）を優先し、取れなければマイレポートの上位5件を使う。
export function buildRanking(summary, full, fallbackName) {
  const base = full?.entries?.length ? full : summary;
  if (!base?.entries?.length) return null;
  const shopName = summary?.shopName ?? full?.shopName ?? fallbackName ?? null;
  const norm = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const self = shopName ? (base.entries.find((e) => norm(e.name) === norm(shopName)) ?? null) : null;
  // 管理画面に掲載されている全行を保存する。
  return {
    area: summary?.area ?? full?.area ?? null,
    updatedAt: summary?.updatedAt ?? full?.updatedAt ?? null,
    shopName,
    total: base.entries.length,
    self,
    entries: base.entries,
  };
}

// ---------- 食べログ: デバイス別のよく見られているページ（マイレポートのページレポート） ----------
export function readTopPages() {
  const clean = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const digits = (s) => (/\d/.test(s) ? Number(s.replace(/[^\d]/g, "")) : null);
  const month = clean(document.querySelector("#myreport-access .period")).match(/(\d{4}-\d{2})-\d{2}/)?.[1] ?? null;
  const charts = (window.Highcharts?.charts ?? []).filter(Boolean);
  const pages = (id) => {
    const chart = charts.find((c) => c.renderTo?.id === id);
    if (!chart) return null;
    return chart.series
      .flatMap((series) => series.data)
      .filter((point) => point.category && Number.isFinite(point.y))
      .map((point) => ({ name: String(point.category), pv: point.y }));
  };
  const device = (rowClass, chartId) => ({
    total: digits(clean(document.querySelector(`tr.${rowClass}.allsum .access`))),
    pages: pages(chartId),
  });
  const devices = {
    app: device("access-app", "chart-page-app"),
    pc: device("access-pc", "chart-page-pc"),
    sp: device("access-smartphone", "chart-page-smartphone"),
  };
  const hasPages = Object.values(devices).some((d) => d.pages?.length);
  return month && hasPages ? { month, devices } : null;
}

// マイレポート・アクセスランキングは追加分析なので、失敗しても同期全体は失敗させない
async function extractTabelogReports(page, fallbackName) {
  let topPages = null;
  let summary = null;
  let full = null;
  try {
    await page.goto("https://owner.tabelog.com/owner_rst/my_report/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await assertAuthenticated(page);
    await page
      .waitForFunction(
        () =>
          ["chart-page-pc", "chart-page-smartphone", "chart-page-app"].every((id) =>
            window.Highcharts?.charts?.some((c) => c?.renderTo?.id === id && c.series?.[0]?.data?.length),
          ),
        null,
        { timeout: 15000 },
      )
      .catch(() => {});
    await dumpChartPage(page, "my-report-tabelog");
    topPages = await page.evaluate(readTopPages);
    summary = await page.evaluate(readRanking);
  } catch (e) {
    if (/追加認証|店舗管理用ID/.test(String(e?.message))) throw e;
  }
  try {
    await page.goto("https://owner.tabelog.com/owner_rst/access_ranking", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await assertAuthenticated(page);
    await dumpChartPage(page, "access-ranking-tabelog");
    full = await page.evaluate(readRanking);
  } catch (e) {
    if (/追加認証|店舗管理用ID/.test(String(e?.message))) throw e;
  }
  return { topPages, ranking: buildRanking(summary, full, fallbackName) };
}

async function collectStorePublicMetrics(page) {
  const href = await page.evaluate(readOwnerPublicUrl);
  if (!href) return { rating: null, reviews: null, reviewItems: [], issue: "管理画面の自店舗ページリンクを確認できないため、公開の総合点と口コミ総数は未取得です" };
  // A fresh context: the owner session is not sent to the public restaurant page.
  const clean = await page.context().browser().newContext({
    locale: "ja-JP", timezoneId: "Asia/Tokyo", viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { "Accept-Language": "ja,en;q=0.9" },
  });
  try {
    const data = await collectTabelogPublicData(clean, href);
    return { ...data, reviewItems: [] };
  } finally {
    await clean.close();
  }
}

// Owner console for posts and history. The store's own public page supplies the official aggregate only.
async function extractTabelog(page, onProgress) {
  return collectTabelogMetrics({
    ownerReviews: () => collectOwnerReviews(page, assertAuthenticated),
    publicMetrics: () => collectStorePublicMetrics(page),
    dailyMetrics: () => collectOwnerDaily(page, assertAuthenticated, onProgress, japanDate()),
    monthlyMetrics: () => extractTabelogConversion(page),
    detailReports: (name) => extractTabelogReports(page, name),
    pageHistory: () => collectPageHistory(page, assertAuthenticated),
  }, onProgress);
}

async function assertAuthenticated(page) {
  const manual = await page.locator('input[autocomplete="one-time-code"], input[name="otp"], iframe[src*="recaptcha"][title*="challenge"], iframe[src*="hcaptcha"]').first().isVisible().catch(() => false);
  if (manual) throw new Error("追加認証が必要です。食べログの管理画面で認証を完了してから再実行してください");
  if (page.url().includes("/owner_account/login") || await page.locator("#login_id").isVisible().catch(() => false)) {
    throw new Error("食べログにログインできませんでした。店舗管理用ID・パスワード、追加認証の有無をご確認ください");
  }
}

// 長時間停止したブラウザは必ず閉じる。タイムアウト後の結果は保存側へ渡さない。
export async function syncOne(sourceId, cred, { onProgress = () => {}, timeoutMs = 480_000 } = {}) {
  let browser;
  let timedOut = false;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (browser) void browser.close().catch(() => {});
      resolve(err("timeout", "取得が制限時間を超えました。前回の保存値は保持されています。時間をおいて再実行してください"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      runSyncOne(sourceId, cred, {
        onProgress: (...args) => { if (!timedOut) onProgress(...args); },
        registerBrowser: async (value) => {
          browser = value;
          if (timedOut) { await browser.close(); throw new Error("timeout"); }
        },
      }), timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const IKYU_OWNER_GAP = "公開ページの評価と口コミを保存しました。PVと予約数は店舗管理画面のロボット確認が必要なため未取得です。";

async function extractIkyu(cred, onProgress) {
  const unpacked = unpackIkyuUsername(cred.username);
  if (!unpacked) return err("no_credential", "一休.comレストランの店舗IDを読み取れません。アカウントを登録し直してください");
  const storeId = unpacked.storeId;
  try {
    onProgress("public_metrics", "一休.comレストランの公開ページを取得しています");
    const parsed = await collectIkyuPublic(storeId);
    if (parsed.rating == null || parsed.reviews == null) {
      return err("extraction", "一休.comレストランの公開ページから評価または口コミ数を読み取れませんでした");
    }
    return {
      status: "partial",
      warning: IKYU_OWNER_GAP,
      data: { rating: parsed.rating, reviews: parsed.reviews, pv: null, reservations: null },
      reviews: parsed.items,
      daily: [],
      monthly: [],
    };
  } catch (error) {
    return err(error.step || "public_page", error.message || "一休.comレストランの公開ページを取得できませんでした");
  }
}

async function runSyncOne(sourceId, cred, { onProgress, registerBrowser }) {
  const source = getSource(sourceId);
  if (!source) return err("unknown_source", `不明なサイト: ${sourceId}`);
  if (!cred) return err("no_credential", `${source.name} のログイン情報が未登録です`);
  if (sourceId === "ikyu") return await extractIkyu(cred, onProgress);

  // cred は { username, passwordEnc }（DB保存行）を期待。平文 password のみの場合も許容。
  const password = cred.passwordEnc ? decrypt(cred.passwordEnc) : cred.password;
  if (!password) return err("decrypt_failed", "パスワードの復号に失敗しました（ENCRYPTION_KEY 不一致の可能性）");
  const username = cred.username;

  const pw = await loadPlaywright();
  if (!pw) return err("no_playwright", "Playwright が未インストールのため同期できません");

  let browser;
  try {
    onProgress("browser", "取得用ブラウザを起動しています");
    browser = await launchBrowser(pw);
    await registerBrowser(browser);
  } catch (e) {
    return err("browser_launch", "取得用ブラウザを起動できませんでした。ChromeまたはChromiumのインストールを確認してください");
  }

  try {
    const context = await browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "Accept-Language": "ja,en;q=0.9" },
    });
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(30000);
    // The requested data is text/tables. Do not download review photographs.
    await context.route('**/*', route => ['image','media','font'].includes(route.request().resourceType()) ? route.abort() : route.continue());
    const page = await context.newPage();

    // 段階1: ログインページ読み込み
    try {
      onProgress("login", "ログイン画面を開いています");
      await page.goto(source.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitRandom(1500, 3000);
    } catch (e) {
      return err("login_page_load", "ログイン画面を開けませんでした。通信状態を確認して再実行してください");
    }

    // 段階2: ログインID・パスワード入力
    try {
      onProgress("authentication", "店舗管理用アカウントでログインしています");
      await page.waitForSelector(source.login.password, { timeout: 10000 });
      await page.fill(source.login.username, username);
      await page.fill(source.login.password, password);
      await waitRandom(800, 2000);
    } catch (e) {
      return err("field_fill", "ログインフォームが見つかりません。画面変更や追加認証の有無を確認してください");
    }

    // 段階3: ログイン実行
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}),
        page.click(source.login.submit),
      ]);
      await waitRandom(1500, 3000);
    } catch (e) {
      return err("button_click", "ログイン処理を完了できませんでした。時間をおいて再実行してください");
    }

    // 段階4: 管理画面（着地）読み込み
    try {
      await page.goto(source.dashboardUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitRandom(1500, 3000);
    } catch (e) {
      return err("dashboard_load", "管理画面を開けませんでした。通信状態を確認してください");
    }

    await dumpChartPage(page, `landing-${sourceId}`);

    const loginFormVisible = await page
      .locator(source.login.password)
      .first()
      .isVisible()
      .catch(() => false);
    if (loginFormVisible) {
      const loginError = await page
        .locator('[role="alert"], .alert, .error, [class*="error"]')
        .allTextContents()
        .then((messages) => messages.map((message) => message.trim()).find(Boolean))
        .catch(() => null);
      return err(
        "authentication",
        loginError
          ? `${source.name}へのログインに失敗しました: ${loginError}`
          : `${source.name}へのログインに失敗しました。IDとパスワードをご確認ください`,
      );
    }

    // 段階5: 数値抽出
    if (sourceId === "tabelog") {
      await assertAuthenticated(page);
      return await extractTabelog(page, onProgress);
    }

    const data = { rating: null, reviews: null, pv: null, reservations: null };
    for (const [key, sel] of Object.entries(source.fields)) {
      try {
        const t = await page.textContent(sel, { timeout: 3000 });
        if (t != null) {
          const n = parseFloat(String(t).replace(/[^\d.]/g, ""));
          if (!Number.isNaN(n)) data[key === "reviewCount" ? "reviews" : key] = n;
        }
      } catch {
        // セレクタ不一致は項目ごとにスキップ
      }
    }

    const foundReviews = [];
    try {
      await page.waitForSelector(source.reviewsSelector, { timeout: 3000 });
      const items = await page.$$(source.reviewsSelector);
      for (const el of items.slice(0, 10)) {
        const text = (await el.textContent())?.trim().replace(/\s+/g, " ").slice(0, 200) ?? "";
        if (text) foundReviews.push({ text });
      }
    } catch {
      // 口コミ要素が見つからない場合はスキップ
    }

    await browser.close();
    const noData = Object.values(data).every((v) => v == null);
    if (noData) {
      return {
        status: "error",
        step: "extraction",
        message: "ログイン後の画面から数値を取得できませんでした。取得項目の設定を確認してください",
      };
    }
    return { status: "ok", data, reviews: foundReviews };
  } catch (e) {
    const message = String(e?.message ?? "");
    if (/追加認証|店舗管理用ID/.test(message)) return err("authentication", message);
    if (/不正|一致しません|正しく取得/.test(message)) return err("validation", message);
    return err("extraction", "食べログの数値を取得できませんでした。通信状態と管理画面の表示を確認してください");
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
