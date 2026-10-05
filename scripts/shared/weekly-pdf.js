// 週報のビュー（scripts/shared/weekly-report.js の renderWeeklyReportHtml に渡すもの）→ PDF と M-talk のカードの要約。
// HTML は M-talk に添付できないため、同じビューから PDF を作る（AI分析レポートと同じ supabase/functions/_shared/report-pdf.js：
// pdf-lib＋fontkit、Noto Sans JP のサブセットを埋め込み、A4縦）。グラフは表と文で表す（数値は HTML と同じビュー・同じ計算）。
// 内容ルールは HTML と同じ: 未取得は「未取得」、事実と推測を分ける、お客様の氏名・連絡先・予約番号・口コミ本文は載せない（ビューに無い）。
import { NA, dailyStats, fmt, mdJa, shortMd, slashDate, weekdayJa } from "./weekly-report.js";

const cellText = (c) => {
  const o = typeof c === "object" && c !== null ? c : { text: c };
  // 表の区切り（|）と改行は Markdown の表を壊すので置き換える
  return String(o.text ?? NA).replace(/\|/g, "｜").replace(/\s*\n\s*/g, " ").trim() || NA;
};
const line = (s) => String(s ?? "").replace(/\s*\n\s*/g, " ").trim();

/** renderTable と同じ table（{ caption, head, rows }）→ Markdown の表（見出し行＋区切り＋行）と出典の注記。 */
export function tableMarkdown(table) {
  if (!table?.head?.length) return [];
  const head = table.head.map((h) => cellText(h.label != null ? { text: h.label } : h));
  const out = [`| ${head.join(" | ")} |`, `| ${table.head.map((h) => (h.num ? "---:" : "---")).join(" | ")} |`];
  for (const r of table.rows ?? []) out.push(`| ${(r.cells ?? []).map(cellText).join(" | ")} |`);
  if (table.caption) out.push("", `_${line(table.caption)}_`);
  return [...out, ""];
}

/** 1サイトのビュー → Markdown（見出しは ## サイト、### 節）。 */
export function weeklyViewMarkdown(v) {
  const label = v.site?.label || "サイト";
  const asOf = v.asOf;
  const dailyAsOf = v.dailyAsOf || asOf;
  const s = dailyStats(v.daily, dailyAsOf);
  const md = [`## ${label}週報（${line(v.storeName)}${v.storeKey ? `・${line(v.storeKey)}` : ""}）`, ""];
  md.push(`### 今週のポイント：${(v.hero?.title ?? []).slice(0, 2).map(line).join("")}`, "");
  (v.hero?.points ?? []).slice(0, 5).forEach((p, i) => md.push(`${i + 1}. ${line(p)}`));
  md.push("", `> FOCUS（まず取り組むこと）：${line(v.hero?.focus)}`, "");

  md.push("### まず、押さえたい4つの数字", "", "| 指標 | 値 | 比較 | 補足 |", "| --- | ---: | --- | --- |");
  for (const k of (v.kpis ?? []).slice(0, 4)) md.push(`| ${cellText(k.label)} | ${cellText(`${k.value ?? NA}${k.unit ? ` ${k.unit}` : ""}`)} | ${cellText(k.delta || NA)} | ${cellText(k.note || "")} |`);
  md.push("");

  const m = v.monthly;
  if (m) {
    md.push(`### ${line(m.heading?.title || "月次比較")}`, "");
    const first = m.metrics?.[0];
    if (first) md.push(`**${line(first.title)}**：${line(first.change)}。${line(first.explain || m.caption)}`, "");
    md.push(...tableMarkdown(m.table));
  }

  md.push(`### 直近7日の閲覧数`, "");
  const wowDiff = s.last7.pv != null && s.prior7.pv != null ? s.last7.pv - s.prior7.pv : null;
  md.push(`直近7日（${shortMd(s.windows.last7.from)}–${shortMd(s.windows.last7.to)}）**${fmt(s.last7.pv)} PV**、前の7日（${shortMd(s.windows.prior7.from)}–${shortMd(s.windows.prior7.to)}）${fmt(s.prior7.pv)} PV。`
    + (wowDiff != null && s.wow != null ? `前の7日間より ${fmt(Math.abs(wowDiff))} PV（${Math.abs(s.wow).toFixed(1)}%）${wowDiff >= 0 ? "増" : "減"}。` : "前週比較：未取得。"), "");
  md.push(`_出典：${line(v.weekly?.source)}。${dailyAsOf === asOf ? `${slashDate(asOf)}は集計中のため含めていません` : `管理画面に未反映の${slashDate(dailyAsOf)}以降は含めていません（作成日 ${slashDate(asOf)}）`}（0扱いにはしていません）。_`, "");
  md.push(...tableMarkdown(v.weekly?.table));
  if (v.weekly?.tableNote) md.push(`_${line(v.weekly.tableNote)}_`, "");

  md.push(`### 直近30日の日別PV（${slashDate(s.windows.last30.from)}–${slashDate(s.windows.last30.to)}）`, "");
  if (s.last30.length) {
    md.push(`合計 ${fmt(s.sum30)} PV／1日平均 ${s.avg30 != null ? s.avg30.toFixed(1) : NA} PV（出典：${line(v.dailyPanel?.source)}）`, "");
    md.push(`- ピーク：${s.peaks.map((d) => `${mdJa(d.date)} ${fmt(d.pv)}PV`).join("、") || NA}`);
    md.push(`- 落ち込み：${s.dips.map((d) => `${mdJa(d.date)} ${fmt(d.pv)}PV`).join("、") || NA}`, "");
    const peak = new Set(s.peaks.map((d) => d.date)), dip = new Set(s.dips.map((d) => d.date));
    md.push("| 日付 | PV | 区分 |", "| --- | ---: | --- |");
    for (const d of s.last30) md.push(`| ${slashDate(d.date)}（${weekdayJa(d.date)}） | ${fmt(d.pv)} | ${peak.has(d.date) ? "ピーク" : dip.has(d.date) ? "落ち込み" : ""} |`);
    md.push("", `_表 日別アクセス数（出典：${line(v.dailyPanel?.tableSource)}／単位：PV）_`, "");
  } else md.push("（日別PV：未取得）", "");

  const rv = v.reviews;
  if (rv) {
    md.push("### 自店の評価と新着口コミ", "", `#### ${line(rv.profileTitle)}`, "", ...tableMarkdown(rv.profileTable));
    md.push(`#### ${line(rv.newTitle || "直近7日の新着口コミ")}：${line(rv.statText)}`, "", line(rv.note), "", `_${line(rv.idea)}_`, "");
  }

  const comp = v.competitors;
  if (comp) {
    md.push(`### ${line(comp.heading?.title || "競合比較")}`, "");
    if (comp.list?.length) {
      md.push(`| 店舗（${line(comp.areaLabel || "設定エリア")}） | 評価 | 口コミ数 |`, "| --- | ---: | ---: |");
      for (const c of comp.list) md.push(`| ${cellText(c.name)}${c.own ? "（自店）" : ""} | ${c.rating != null ? Number(c.rating).toFixed(2) : NA} | ${fmt(c.reviews)} |`);
      md.push("");
    } else md.push("（競合データ：未取得）", "");
    md.push(`**読み取り：**${line(comp.insight)}`, "");
    if (comp.side) {
      md.push(`#### ${line(comp.side.title)}`, "", `_${line(comp.side.sub)}_`, "");
      if (comp.side.opportunity) md.push(`- ${line(comp.side.opportunity.tag)}：**${line(comp.side.opportunity.price)}**（${line(comp.side.opportunity.note)}）`);
      else md.push(`- （${line(comp.side.missing)}：未取得）`);
      for (const b of comp.side.bullets ?? []) md.push(`- **${line(b.label)}：**${line(b.text)}`);
      md.push("");
    }
    if (comp.table) md.push(...tableMarkdown(comp.table), `**最近の変化：**${line(comp.changeNote)}`, "");
    else md.push(`（${line(comp.missing || "競合詳細")}：未取得）`, "");
  }

  const area = v.area;
  if (area) {
    md.push(`### ${line(area.heading?.title || "エリア")}`, "");
    for (const p of area.panels ?? []) {
      if (!p) continue;
      md.push(`#### ${line(p.title)}`, "");
      if (p.sub) md.push(`_${line(p.sub)}_`, "");
      if (p.stat != null) md.push(`**${line(p.stat)}**`, "");
      if (p.table) md.push(...tableMarkdown(p.table));
      for (const n of p.notes ?? []) md.push(`_${line(n)}_`, "");
      if (p.missing) md.push(`（${line(p.missing)}：未取得）`, "");
    }
  }

  md.push("### 次に取り組む3つのこと", "");
  (v.actions ?? []).slice(0, 3).forEach((a, i) => md.push(`${i + 1}. **${line(a.title)}**：${line(a.body)}`));
  md.push("", "### 数字の見方", "");
  for (const f of v.footnotes ?? []) md.push(`- ${line(f)}`);
  md.push("");
  if (v.footer) md.push(`_${line(v.footer.left)} ／ ${line(v.footer.right)}_`, "");
  return md.join("\n");
}

/** 複数サイトのビュー → 1つの PDF 用 Markdown（# 表題 → サイトごとの節）。 */
export function weeklyReportMarkdown(views, { storeName, asOf }) {
  const labels = views.map((v) => v.site?.label).filter(Boolean).join("・");
  return [`# ${line(storeName)} 週報（${labels}）`, "", ...views.flatMap((v, i) => [...(i ? ["---", ""] : []), weeklyViewMarkdown(v)])].join("\n");
}

/**
 * 週報 PDF（A4縦）。PDFLib・fontkit・fonts は report-pdf.js と同じものを渡す（Node: pdf-lib / fontkit、fonts は loadReportFonts）。
 * @returns {Promise<Uint8Array>}
 */
export async function renderWeeklyPdf({ PDFLib, fontkit, fonts, renderReportPdf, views, storeName, asOf }) {
  const labels = views.map((v) => v.site?.label).filter(Boolean).join("・");
  return renderReportPdf({
    PDFLib, fontkit, fonts,
    report: { title: `${storeName} 週報（${labels}）`, storeName, from: asOf, to: asOf, createdAt: `${asOf}T00:00:00+09:00`, markdown: weeklyReportMarkdown(views, { storeName, asOf }) },
    meta: [`作成日 ${slashDate(asOf)}（日本時間）／対象サイト：${labels}`, "数値は各サイトの管理画面・公開ページから取得した値です。取れなかった項目は「未取得」と表示しています。お客様の氏名・連絡先は載せていません。"],
    footer: "Review Command Center · 週報",
  });
}

/** カードの要約（1サイト = agent-api /weekly/deliver の sections の1件）: KPI 4つ＋直近7日のPV、ポイント2つ。 */
export function weeklyCardSection(v) {
  const s = dailyStats(v.daily, v.dailyAsOf || v.asOf);
  const fields = (v.kpis ?? []).slice(0, 4).map((k) => ({
    label: line(k.label).slice(0, 24),
    value: `${k.value ?? NA}${k.unit && k.value !== NA ? ` ${k.unit}` : ""}${k.delta && k.delta !== NA ? `（${line(k.delta)}）` : ""}`,
  }));
  const wow = s.wow != null ? `、前7日比 ${s.wow > 0 ? "+" : s.wow < 0 ? "−" : ""}${Math.abs(s.wow).toFixed(1)}%` : "";
  fields.push({ label: "直近7日のPV", value: s.last7.pv != null ? `${fmt(s.last7.pv)} PV（${shortMd(s.windows.last7.from)}–${shortMd(s.windows.last7.to)}${wow}）` : NA });
  const items = (v.hero?.points ?? []).slice(0, 2).map((p) => line(p).replace(/\*\*/g, ""));
  return { source: v.site?.key, fields, items };
}
