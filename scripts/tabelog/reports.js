// 食べログ: 店舗管理画面のレポート読み取り（エージェント側。アプリの実行環境では使わない）。
// read* は document を読む自己完結関数（Grok Bot のブラウザで page.evaluate する／保存HTMLを scripts/tabelog-html-to-json.mjs で読む）。
import { japanDate } from "../../supabase/functions/_shared/sync-data.js";

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

// ---------- 食べログ: マイレポートの端末別ページサマリーと来店指標（#myreport-access / #myreport-cvr） ----------
// 端末（PC版・スマートフォン版・アプリ版）ごとの「店舗トップ」と「ページ合計」のPV、レポート日の期間、来店指標の3つの値。
// page.evaluate に渡すため外部変数を参照しないこと。表が無ければ null。
export function readMyReportDevices() {
  const clean = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const digits = (s) => (/\d/.test(s) ? Number(s.replace(/[^\d]/g, "")) : null);
  const box = document.querySelector("#myreport-access");
  if (!box) return null;
  const period = clean(box.querySelector(".period")).match(/(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
  const devices = {};
  for (const [key, cls] of [["pc", "access-pc"], ["sp", "access-smartphone"], ["app", "access-app"]]) {
    const top = box.querySelector(`tr.${cls}.days .access`), all = box.querySelector(`tr.${cls}.allsum .access`);
    if (top || all) devices[key] = { topPage: top ? digits(clean(top)) : null, allPages: all ? digits(clean(all)) : null };
  }
  if (!Object.keys(devices).length) return null;
  const cvr = document.querySelector("#myreport-cvr");
  const value = (cls) => { const el = cvr?.querySelector(`tr.${cls} .cvr`); return el ? digits(clean(el)) : null; };
  const cvrPeriod = clean(cvr?.querySelector(".period")).match(/(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
  return {
    from: period?.[1] ?? null, to: period?.[2] ?? null, devices,
    conversion: cvr ? { from: cvrPeriod?.[1] ?? null, to: cvrPeriod?.[2] ?? null, calls: value("cv-tel"), netReservations: value("cv-yoyaku"), mapPrintsPc: value("cv-print") } : null,
  };
}

// マイレポートの端末別ページサマリーの検証（数値は0以上の整数、期間は YYYY-MM-DD）。不正なら null（取り込まない）。
export function validDeviceSummary(v) {
  const count = (x) => x == null || (Number.isSafeInteger(x) && x >= 0);
  const day = (x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
  if (!v || !day(v.from) || !day(v.to) || v.from > v.to || !v.devices || typeof v.devices !== "object") return null;
  const keys = Object.keys(v.devices);
  if (!keys.length || keys.some((k) => !["pc", "sp", "app"].includes(k) || !count(v.devices[k]?.topPage) || !count(v.devices[k]?.allPages))) return null;
  if (v.conversion && ![v.conversion.calls, v.conversion.netReservations, v.conversion.mapPrintsPc].every(count)) return null;
  return v;
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
