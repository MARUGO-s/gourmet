// 食べログ週報 HTML（エージェント／ローカル用の既定テンプレート）。
// 見た目は全サイト共通の scripts/shared/weekly-report.js（サンプル週報 UI）。このファイルは食べログ固有の
// 数値・文言（来店指標・通話成立・予約通知・公開ページ・競合・エリア）を共通ビューへ詰めるアダプタ。
// 内容ルールは青写真（未取得は「未取得」、事実と推測を分離、PII 禁止）。エクスポート入口: scripts/tabelog-weekly-report.mjs
// 詳細: docs/weekly-report.md / docs/tabelog-weekly-report.md
import {
  NA, clsDelta, dailyStats, deltaArrow, fmt, fmtDiff, fmtPct, isNum, mom, monthLabel, niceMax,
  pickMonthPair, renderWeeklyReportHtml, shortMd, shortMonth, slashDate,
} from "../shared/weekly-report.js";
import { pctChange, shiftDate, sumDailyPv, weeklyPvWindows, within30Days } from "../shared/weekly-windows.js";

export const TABELOG_SITE = { key: "tabelog", label: "食べログ" };
// 文字列は素のまま組み立てる（エスケープは共通テンプレートが行う）
const yenText = (s) => (s ? s : "掲載なし");

/**
 * @param {object} input
 * @param {string} input.storeName
 * @param {string} input.storeKey
 * @param {string} input.asOf YYYY-MM-DD
 * @param {object} [input.monthly] { prev: {month,pv,reservations,calls,pvPc,pvSp,pvApp}, cur: {...} }
 * @param {Array<{date,pv}>} [input.daily]
 * @param {object} [input.publicProfile] { rating, reviewCount, saveCount, budgetNight, budgetDay, station }
 * @param {object} [input.notices] { new, changed, cancelled }
 * @param {number|null} [input.newReviews7d]
 * @param {object} [input.accessRanking] { area, self: {rank,pv}, momPct, competitorsNote }
 * @param {Array} [input.competitors] top+self profiles
 * @param {Array} [input.genreRanks] { label, rank, note }
 * @param {Array} [input.newOpens]
 * @param {Array<{title,body}>} [input.nextActions]
 * @param {string[]} [input.heroTitle] two headline lines
 * @param {string[]} [input.heroPoints] bullet points (may include **bold** markers)
 * @param {string} [input.focusText] (may include **bold** markers)
 * @param {string} [input.areaLabel]
 * @param {string} [input.competitorInsight]
 * @param {string} [input.competitorChangeNote]
 * @param {string} [input.reviewNote]
 * @param {string} [input.reviewIdea]
 */
export function buildTabelogWeeklyView(input) {
  const asOf = input.asOf;
  const name = input.storeName || "店舗";
  const { windows, last7, wow } = dailyStats(input.daily ?? [], asOf);

  const cur = input.monthly?.cur ?? {};
  const prev = input.monthly?.prev ?? {};
  const pvMom = mom(cur.pv, prev.pv);
  const resMom = mom(cur.reservations, prev.reservations);
  const callMom = mom(cur.calls, prev.calls);
  const profile = input.publicProfile ?? {};
  const notices = input.notices ?? null;
  const competitors = input.competitors ?? [];
  const genreRanks = input.genreRanks ?? [];
  const newOpens = input.newOpens ?? [];
  const access = input.accessRanking ?? null;
  const newReviews7d = input.newReviews7d ?? null;
  const areaLabel = input.areaLabel || access?.area || "設定エリア";
  const shortName = name.replace(/^BISTRO\s+/i, "").trim() || name;

  // Hero headline + points (facts only; guesses stay out)
  const defaultTitle = (() => {
    if (isNum(wow) && wow > 0) return ["閲覧は回復。", "次は、口コミと予約導線。"];
    if (isNum(wow) && wow < 0) return ["閲覧は軟調。", "予約導線と口コミを確認。"];
    if (isNum(pvMom) && pvMom > 0) return ["月次の閲覧は堅調。", "次は、口コミと予約導線。"];
    return [name, "今週の確認ポイント"];
  })();
  const heroTitle = (input.heroTitle?.length ? input.heroTitle : defaultTitle).slice(0, 2);

  const defaultPoints = [];
  if (isNum(cur.pv) && isNum(prev.pv)) {
    const weeklyBit = isNum(last7.pv) && isNum(wow)
      ? `直近7日（${shortMd(windows.last7.from)}–${shortMd(windows.last7.to)}）は${fmt(last7.pv)}PVで前7日比${fmtPct(wow)}。`
      : "";
    defaultPoints.push(`${shortMonth(cur.month)}のPVは**${fmt(cur.pv)}**（${shortMonth(prev.month)}${fmt(prev.pv)}から${fmtPct(pvMom)}）。${weeklyBit}`);
  } else {
    defaultPoints.push(`月次PV：未取得。`);
  }
  if (isNum(cur.reservations) || isNum(cur.calls)) {
    const parts = [];
    if (isNum(cur.reservations)) {
      parts.push(isNum(prev.reservations)
        ? `ネット予約は**${fmt(cur.reservations)}組**（${shortMonth(prev.month)}${fmt(prev.reservations)}組）`
        : `ネット予約は**${fmt(cur.reservations)}組**`);
    } else parts.push("ネット予約は未取得");
    if (isNum(cur.calls)) {
      parts.push(isNum(prev.calls)
        ? `予約専用番号の通話成立は**${fmt(cur.calls)}件**（${shortMonth(prev.month)}${fmt(prev.calls)}件）`
        : `予約専用番号の通話成立は**${fmt(cur.calls)}件**`);
    } else parts.push("通話成立は未取得");
    defaultPoints.push(`${parts.join("、")}。`);
  } else {
    defaultPoints.push("ネット予約・通話成立：未取得。");
  }
  {
    const revBit = newReviews7d == null ? "直近7日の新着口コミは未取得" : `直近7日の新着口コミは**${fmt(newReviews7d)}件**`;
    const ratingBit = isNum(profile.rating)
      ? `評価${Number(profile.rating).toFixed(2)}・口コミ${fmt(profile.reviewCount)}件`
      : "評価・口コミ数は未取得";
    const comps = competitors.filter((c) => !c.own && isNum(c.rating));
    const gapBit = comps.length && isNum(profile.rating)
      ? `、上位${comps.length}店（${Math.min(...comps.map((c) => c.rating)).toFixed(2)}–${Math.max(...comps.map((c) => c.rating)).toFixed(2)}）との差は継続`
      : "";
    defaultPoints.push(`${revBit}。${ratingBit}${gapBit}。`);
  }
  const heroPoints = (input.heroPoints?.length ? input.heroPoints : defaultPoints).slice(0, 5);

  const focus = input.focusText
    ?? (isNum(cur.calls) && isNum(prev.calls)
      ? `通話成立が **${fmt(prev.calls)}件 → ${fmt(cur.calls)}件** に変化。電話・ネット予約の導線と、来店後に口コミを書いてもらうきっかけ作りを優先します。※通話成立は予約確定を意味しません。`
      : "データがそろい次第、最優先の課題を表示します。");

  const nextActions = (input.nextActions?.length ? input.nextActions : [
    { title: "口コミのきっかけを作る", body: isNum(profile.reviewCount) ? `会計時のカードや予約後のメッセージで、率直な感想を投稿しやすい案内を用意します。口コミ数（${fmt(profile.reviewCount)}件）を競合と比較し、差があれば埋める導線を確認します。` : "会計時のカードや予約後のメッセージで、率直な感想を投稿しやすい案内を用意します。" },
    { title: "予約導線を見直す", body: isNum(cur.calls) && isNum(prev.calls) ? `PVの動きと通話成立（${fmt(prev.calls)}件→${fmt(cur.calls)}件）を見比べ、店舗ページの予約可能枠・コース掲載・電話受付時間の表記がそろっているか確認します。` : "店舗ページの予約可能枠・コース掲載・電話受付時間の表記がそろっているか確認します。" },
    { title: "ランチの魅力を具体的に見せる", body: profile.budgetDay ? `${profile.budgetDay}の料理内容・量・雰囲気を写真と説明で伝えます。昼予算の掲載有無はランチ営業の有無を意味しません。` : "昼予算が掲載されている場合、料理内容・量・雰囲気を写真と説明で伝えます。" },
  ]);

  const chartMaxPv = niceMax(Math.max(Number(prev.pv) || 0, Number(cur.pv) || 0));
  const chartMaxRes = niceMax(Math.max(Number(prev.reservations) || 0, Number(cur.reservations) || 0));
  const chartMaxCalls = niceMax(Math.max(Number(prev.calls) || 0, Number(cur.calls) || 0));
  const val = (n) => (isNum(n) ? n : null);
  const monthsSub = `${monthLabel(prev.month)}・${monthLabel(cur.month)}の確定値`;

  const metrics = [
    {
      key: "pv", button: "閲覧数",
      title: isNum(cur.pv) && isNum(pvMom) ? `ページ閲覧数は前月比${Math.abs(pvMom).toFixed(1)}%${pvMom >= 0 ? "増" : "減"}` : (isNum(cur.pv) ? "ページ閲覧数" : "ページ閲覧数（未取得）"),
      subtitle: `${monthsSub} / PV`, values: [val(prev.pv), val(cur.pv)], max: chartMaxPv, unit: "PV",
      change: fmtPct(pvMom), cls: clsDelta(pvMom),
      explain: isNum(cur.pv) && isNum(prev.pv)
        ? `閲覧数の差分は ${cur.pv - prev.pv >= 0 ? "+" : "−"}${fmt(Math.abs(cur.pv - prev.pv))}PV。予約・通話の動きとあわせて導線を確認します。`
        : "月次PVが未取得です。",
    },
    {
      key: "booking", button: "ネット予約",
      title: isNum(cur.reservations) && isNum(prev.reservations)
        ? `ネット予約は${fmt(prev.reservations)}組から${fmt(cur.reservations)}組へ`
        : (isNum(cur.reservations) ? `ネット予約は${fmt(cur.reservations)}組` : "ネット予約（未取得）"),
      subtitle: `${monthsSub} / 組`, values: [val(prev.reservations), val(cur.reservations)], max: chartMaxRes, unit: "組",
      change: fmtPct(resMom), cls: clsDelta(resMom),
      explain: "インターネット予約組数です。来店人数や売上とは異なります。",
    },
    {
      key: "calls", button: "電話通話",
      title: isNum(cur.calls) && isNum(prev.calls)
        ? `電話の通話成立は${fmt(prev.calls)}件から${fmt(cur.calls)}件へ`
        : (isNum(cur.calls) ? `電話の通話成立は${fmt(cur.calls)}件` : "通話成立（未取得）"),
      subtitle: `${monthsSub} / 件`, values: [val(prev.calls), val(cur.calls)], max: chartMaxCalls, unit: "件",
      change: fmtPct(callMom), cls: clsDelta(callMom),
      explain: "食べログ予約専用番号の通話成立数です。予約確定数とは異なります。",
    },
  ];
  const n = (text) => ({ text, num: true });
  const pvSplit = (m) => (isNum(m.pvPc) || isNum(m.pvSp) || isNum(m.pvApp) ? `${fmt(m.pvPc)}／${fmt(m.pvSp)}／${fmt(m.pvApp)}` : NA);

  const ownComp = competitors.find((c) => c.own);
  const otherComps = competitors.filter((c) => !c.own);
  const lunchOpportunity = (() => {
    const day = profile.budgetDay || ownComp?.budgetDay;
    if (!day) return null;
    const othersWithDay = otherComps.filter((c) => c.budgetDay && c.budgetDay !== "掲載なし");
    return {
      tag: `${shortName} のランチ予算`,
      price: day,
      note: othersWithDay.length
        ? `比較店のうち昼予算の掲載がある店舗があります。手頃なランチを具体的に伝える余地があるかは、掲載内容の確認が必要です。`
        : `昼予算の掲載がある比較店が少ない／ない場合でも、「掲載なし」はランチ営業なしを意味しません。`,
    };
  })();

  const competitorInsight = input.competitorInsight ?? (() => {
    if (!otherComps.length || !isNum(profile.rating)) return "競合スナップショット：未取得。";
    const ratings = otherComps.map((c) => c.rating).filter(isNum);
    if (!ratings.length) return `自店の評価は${Number(profile.rating).toFixed(2)}。比較店の評価は未取得。`;
    const lo = Math.min(...ratings).toFixed(2);
    const hi = Math.max(...ratings).toFixed(2);
    const gapLo = (Math.min(...ratings) - Number(profile.rating)).toFixed(2);
    const gapHi = (Math.max(...ratings) - Number(profile.rating)).toFixed(2);
    return `自店の評価は${Number(profile.rating).toFixed(2)}。比較した上位店（${lo}–${hi}）とは${gapLo}–${gapHi}の差があります。`;
  })();

  const reviewNote = input.reviewNote ?? (
    newReviews7d == null
      ? "新着口コミ件数は未取得です。公開ページに投稿日が表示されない場合は、件数と一覧表示から判定し、判定方法と限界を明記してください。"
      : newReviews7d === 0
        ? `確認範囲の新着投稿は ${fmt(0)} 件でした。公開ページに投稿日が表示されない場合は、件数と一覧で判定しています。訪問日・訪問月と投稿日は区別してください。`
        : `確認範囲で新着口コミが ${fmt(newReviews7d)} 件ありました。内容の要約は別途確認してください（本レポートに顧客の氏名・連絡先は記載しません）。`
  );
  const reviewIdea = input.reviewIdea ?? "改善・返信のアイデア：直近の口コミが少ない／ない状態が続く場合は、会計時のカードや予約完了メッセージで「感想を食べログでお聞かせください」と案内する導線を用意する。";

  const opensInRange = newOpens.filter((e) => e.within30d);
  const periodLabelLast = `${shortMd(windows.last7.from)}–${shortMd(windows.last7.to)}`;
  const ratingRange = (list) => `${Math.min(...list.map((c) => c.rating)).toFixed(2)}–${Math.max(...list.map((c) => c.rating)).toFixed(2)}`;
  const ratedOthers = otherComps.filter((c) => isNum(c.rating));
  const reviewedOthers = otherComps.filter((c) => isNum(c.reviews));

  return {
    site: TABELOG_SITE,
    storeName: name,
    storeKey: input.storeKey,
    asOf,
    daily: input.daily ?? [],
    hero: { title: heroTitle, points: heroPoints, focus },
    kpis: [
      { label: `${shortMonth(cur.month)}のページ閲覧数`, value: fmt(cur.pv), unit: "PV", deltaCls: clsDelta(pvMom), delta: isNum(pvMom) ? deltaArrow(pvMom) : NA, note: isNum(prev.pv) ? `${shortMonth(prev.month)} ${fmt(prev.pv)} PV` : "前月：未取得" },
      { label: `${shortMonth(cur.month)}のネット予約`, value: fmt(cur.reservations), unit: "組", deltaCls: clsDelta(resMom), delta: isNum(resMom) ? deltaArrow(resMom) : NA, note: isNum(prev.reservations) ? `${shortMonth(prev.month)} ${fmt(prev.reservations)}組` : "前月：未取得" },
      { label: `${shortMonth(cur.month)}の電話通話成立`, value: fmt(cur.calls), unit: "件", deltaCls: clsDelta(callMom), delta: isNum(callMom) ? deltaArrow(callMom) : NA, note: isNum(prev.calls) ? `${shortMonth(prev.month)} ${fmt(prev.calls)}件／予約確定件数ではありません` : "予約確定件数ではありません／前月：未取得" },
      { label: "直近7日の新着口コミ", value: fmt(newReviews7d), unit: "件", deltaCls: "neutral", delta: periodLabelLast, note: `累計${fmt(profile.reviewCount)}${isNum(profile.reviewCount) ? "件" : ""}` },
    ],
    monthly: {
      heading: { number: "01 / STORE ADMIN", title: "店舗管理データ：閲覧と予約の動き", lead: "見たい指標を選ぶと、月次グラフが切り替わります。" },
      periods: [shortMonth(prev.month), shortMonth(cur.month)],
      subtitle: monthsSub,
      metrics,
      caption: "月次の閲覧・予約・通話を切り替えで確認できます。",
      table: {
        caption: "表1 月次比較（出典：店舗管理画面「来店指標（TEL数・ネット予約数など）」月別／単位：PV・件・組）",
        head: [{ label: "指標" }, { label: monthLabel(prev.month), num: true }, { label: monthLabel(cur.month), num: true }, { label: "増減", num: true }, { label: "前月比", num: true }],
        rows: [
          { cells: ["アクセス数（PV）", n(fmt(prev.pv)), n(fmt(cur.pv)), n(fmtDiff(cur.pv, prev.pv)), n(fmtPct(pvMom))] },
          { cells: ["食べログ予約専用番号 通話成立数（件）", n(fmt(prev.calls)), n(fmt(cur.calls)), n(fmtDiff(cur.calls, prev.calls)), n(fmtPct(callMom))] },
          { cells: ["インターネット予約組数（組）", n(fmt(prev.reservations)), n(fmt(cur.reservations)), n(fmtDiff(cur.reservations, prev.reservations)), n(fmtPct(resMom))] },
          { cells: ["PV内訳 PC／スマートフォン／アプリ", n(pvSplit(prev)), n(pvSplit(cur)), n("—"), n("—")] },
        ],
      },
    },
    weekly: {
      source: "店舗管理画面 アクセス数レポート（日別）",
      table: {
        caption: `表2 予約通知（出典：店舗管理画面トップ「新着ご予約情報」／${slashDate(asOf)} 確認時点／単位：件）`,
        head: [{ label: "区分" }, { label: "通知件数", num: true }],
        rows: [
          { cells: ["新規予約", n(notices ? fmt(notices.new) : NA)] },
          { cells: ["予約内容の変更", n(notices ? fmt(notices.changed) : NA)] },
          { cells: ["キャンセル", n(notices ? fmt(notices.cancelled) : NA)] },
        ],
      },
      tableNote: "※確認時点で表示されていた新着通知の件数です。週・月の予約総数やキャンセル総数ではありません。顧客の氏名・連絡先は記載しません。",
    },
    dailyPanel: { source: "アクセス数レポート（日別）", tableSource: "店舗管理画面 アクセス数レポート" },
    reviews: {
      profileTitle: "評価・口コミ・保存数",
      profileTable: {
        caption: `表4 公開店舗ページの指標（出典：食べログ公開店舗ページ／${slashDate(asOf)} 取得）`,
        head: [{ label: "指標" }, { label: "値", num: true }, { label: "単位" }],
        rows: [
          { cells: ["評価", n(isNum(profile.rating) ? Number(profile.rating).toFixed(2) : NA), "点（5点満点）"] },
          { cells: ["口コミ数", n(fmt(profile.reviewCount)), "件"] },
          { cells: ["保存数", n(fmt(profile.saveCount)), "人"] },
          { cells: ["予算（夜／昼）", n(profile.budgetNight || profile.budgetDay ? `${yenText(profile.budgetNight)}／${yenText(profile.budgetDay)}` : NA), "円"] },
        ],
      },
      newTitle: "直近7日の新着口コミ",
      statText: newReviews7d == null ? NA : newReviews7d === 0 ? "該当口コミなし" : `${fmt(newReviews7d)}件`,
      note: reviewNote,
      idea: reviewIdea,
    },
    competitors: {
      heading: { number: "03 / COMPETITORS", title: "競合比較（評価上位店）", lead: "評価と口コミ件数を切り替えて確認できます。" },
      areaLabel,
      list: competitors.map((c) => ({ name: c.own ? `${shortName}（自店）` : c.name, rating: c.rating ?? null, reviews: c.reviews ?? null, own: !!c.own })),
      insight: competitorInsight,
      side: {
        title: lunchOpportunity ? "強み・価格帯の確認" : "価格帯の確認",
        sub: "公開ページに掲載された予算で比較",
        opportunity: lunchOpportunity,
        missing: "昼予算",
        bullets: [
          { label: "価格", text: `夜 ${profile.budgetNight ? yenText(profile.budgetNight) : NA} ／ 昼 ${profile.budgetDay ? yenText(profile.budgetDay) : NA}。「昼予算 掲載なし」はランチ営業の有無を意味しません。` },
          { label: "評価", text: `${isNum(profile.rating) ? Number(profile.rating).toFixed(2) : NA}${ratedOthers.length ? ` ／ 比較店 ${ratingRange(ratedOthers)}` : " ／ 比較店：未取得"}` },
          { label: "口コミ数", text: `${fmt(profile.reviewCount)}${reviewedOthers.length ? ` ／ 比較店 ${fmt(Math.min(...reviewedOthers.map((c) => c.reviews)))}–${fmt(Math.max(...reviewedOthers.map((c) => c.reviews)))}` : " ／ 比較店：未取得"}` },
        ],
      },
      table: competitors.length ? {
        caption: `表5 競合比較（出典：公開ランキング一覧および各店公開ページ／${slashDate(asOf)} 取得／評価は点、口コミは件、保存は人、予算は円）`,
        head: [{ label: "#" }, { label: "店名" }, { label: "評価", num: true }, { label: "口コミ", num: true }, { label: "夜予算" }, { label: "昼予算" }, { label: "最寄駅" }, { label: "保存", num: true }],
        rows: competitors.map((c, i) => ({
          cls: c.own ? "own" : "",
          cells: [c.own ? "—" : String(i + 1), `${c.name}${c.own ? "（自店）" : ""}`, n(isNum(c.rating) ? Number(c.rating).toFixed(2) : NA), n(fmt(c.reviews)), yenText(c.budgetNight), yenText(c.budgetDay), c.station ?? NA, n(fmt(c.saveCount))],
        })),
      } : null,
      changeNote: input.competitorChangeNote || "前回スナップショットが無い項目は、価格変更の有無を推定していません。「昼予算 掲載なし」は公開ページに記載がないことを示します。",
      missing: "競合詳細",
    },
    area: {
      heading: { number: "04 / AREA", title: "エリアの新規オープンとランキング" },
      panels: [
        {
          title: "直近30日の新規オープン・新規掲載",
          sub: `確認範囲：オープン日 ${slashDate(windows.last30.from)}–${slashDate(asOf)}`,
          stat: newOpens.length ? (opensInRange.length ? `${opensInRange.length}件` : "該当なし") : NA,
          table: newOpens.length ? {
            caption: `表6 ニューオープン順の店舗（出典：公開ニューオープン順一覧と各店ページのオープン日／${slashDate(asOf)} 取得）`,
            head: [{ label: "エリア" }, { label: "店名（ジャンル）" }, { label: "オープン日" }, { label: "30日以内" }],
            rows: newOpens.slice(0, 12).map((e) => ({ cells: [e.areaLabel ?? "", `${e.name}${e.genreLabel ? `（${e.genreLabel}）` : ""}`, e.openedOn ? slashDate(e.openedOn) : "確認不可", e.openedOn == null ? "判定不可" : e.within30d ? "対象" : "対象外"] })),
          } : null,
          notes: newOpens.length ? ["オープン日が確認できない店舗は新規掲載と推定していません。オープン日と掲載開始日は別です。"] : [],
          missing: newOpens.length ? null : "ニューオープン一覧",
        },
        {
          title: "自店のエリア内順位",
          sub: areaLabel,
          table: {
            caption: `表7 エリア順位（出典：店舗管理画面「アクセス数ランキング」、公開ランキング一覧（評価順）／${slashDate(asOf)} 取得／単位：位）`,
            head: [{ label: "ランキング" }, { label: "順位", num: true }, { label: "備考" }],
            rows: [
              { cells: ["アクセス数ランキング", n(access?.self?.rank != null ? fmt(access.self.rank) : NA), `${access?.self?.pv != null ? `${fmt(access.self.pv)}PV` : NA}${access?.momPct != null ? `、前月比${fmtPct(access.momPct)}` : ""}`] },
              ...(genreRanks.length
                ? genreRanks.map((g) => ({ cells: [g.label, n(g.rank != null ? fmt(g.rank) : NA), g.note ?? "広告枠を除く掲載順"] }))
                : [{ cells: ["ジャンル公開順位", n(NA), "広告枠を除く掲載順"] }]),
            ],
          },
          notes: [access?.competitorsNote || "アクセス数の順位と評価順の順位は別の指標です。広告枠の扱いと対象エリアを明記してください。"],
        },
      ],
    },
    actions: nextActions,
    footnotes: [
      "月次・週次・日別・確認時点のデータは対象期間が異なるため、同じ集計として扱いません。",
      "電話の「通話成立」は予約完了を意味しません。未取得の項目は空欄やゼロにせず「未取得」と記載します。",
      "予約通知の件数は確認時点の新着通知数で、期間合計ではありません。",
      "口コミの投稿日を確認できない場合は、判定方法と限界を明記します。顧客の氏名・連絡先は記載しません。",
      "グラフの切り替えはこのファイル内の表示だけに作用し、外部への通信は行いません。",
    ],
    footer: {
      left: `${name} · 食べログ週報 · 作成日 ${slashDate(asOf)}（Asia/Tokyo）`,
      right: `出典：食べログ店舗管理画面・公開ページ${input.storeKey ? ` · 店舗ID ${input.storeKey}` : ""}`,
    },
  };
}

/** 食べログ週報 HTML（共通テンプレートで描画） */
export function buildWeeklyReportHtml(input) {
  return renderWeeklyReportHtml(buildTabelogWeeklyView(input));
}

/** DB/ツール結果から週報入力を組み立てる（足りない節は空→「未取得」） */
export function assembleWeeklyReportInput({
  storeKey, storeName, asOf, monthlyRows = [], dailyRows = [], reviews = null,
  publicProfile = null, notices = null, accessRanking = null,
  competitors = [], genreRanks = [], newOpens = [], nextActions,
  heroTitle, heroPoints, focusText, areaLabel, competitorInsight, competitorChangeNote,
  reviewNote, reviewIdea,
}) {
  const months = [...monthlyRows].filter((m) => m.month).sort((a, b) => a.month.localeCompare(b.month));
  const curMonth = asOf.slice(0, 7);
  // 直近の確定月（当月より前）と、その前月
  const complete = months.filter((m) => m.month < curMonth);
  const cur = complete.at(-1) ?? months.at(-1) ?? null;
  const prev = cur ? complete.filter((m) => m.month < cur.month).at(-1) ?? null : null;
  const windows = weeklyPvWindows(asOf);
  const newReviews7d = Array.isArray(reviews)
    ? reviews.filter((r) => {
      const d = r.postedAt ?? r.review_date ?? r.date;
      return d && d >= windows.last7.from && d <= windows.last7.to;
    }).length
    : null; // reviews 未渡し = 未取得（空配列は0件）
  return {
    storeKey, storeName, asOf,
    monthly: {
      prev: prev ? { month: prev.month, pv: prev.pv, reservations: prev.reservations ?? prev.netReservations, calls: prev.calls, pvPc: prev.pvPc, pvSp: prev.pvSp, pvApp: prev.pvApp } : {},
      cur: cur ? { month: cur.month, pv: cur.pv, reservations: cur.reservations ?? cur.netReservations, calls: cur.calls, pvPc: cur.pvPc, pvSp: cur.pvSp, pvApp: cur.pvApp } : {},
    },
    daily: dailyRows,
    publicProfile: publicProfile ?? {},
    notices,
    newReviews7d,
    accessRanking,
    competitors,
    genreRanks,
    newOpens: (newOpens ?? []).map((e) => ({ ...e, within30d: e.within30d ?? within30Days(e.openedOn, asOf) })),
    nextActions,
    heroTitle, heroPoints, focusText, areaLabel, competitorInsight, competitorChangeNote,
    reviewNote, reviewIdea,
  };
}

export { weeklyPvWindows, sumDailyPv, pctChange, shiftDate, within30Days };
