import { validateTabelogResult } from './sync-data.js';

// Each authorized page is collected once. A denied public page never causes
// endpoint switching, access-control bypass, or loss of valid owner-console data.
export async function collectTabelogMetrics(collectors, onProgress = () => {}) {
  const issues = [];
  async function collect(step, label, read, fallback) {
    onProgress(step, `${label}を取得しています`);
    try { return await read(); }
    catch (error) {
      if (/追加認証|店舗管理用ID|ログインできません/.test(String(error?.message))) throw error;
      issues.push(`${label}を取得できませんでした`);
      return fallback;
    }
  }
  const owner = collectors.ownerReviews ? await collect('owner_reviews', '管理画面の口コミ全件・個別点数', collectors.ownerReviews, {items:[]}) : null;
  const publicData = owner ? {rating:null,reviews:null,reviewItems:owner.items,issue:'店舗総合点・公開ページの口コミ総数は管理画面では確認できないため未取得です。個別口コミの点数・管理画面の掲載件数とは別の指標です。'}
    : await collect('public_metrics', '評価・口コミ数', collectors.publicMetrics, {});
  const pv = await collect('daily_pv', '日別・端末別PV', collectors.dailyMetrics, {});
  const reservations = await collect('monthly', '月別予約組数・来店指標', collectors.monthlyMetrics, {});
  const reports = await collect('reports', 'エリア順位・ページ別PV', () => collectors.detailReports(publicData.name), {});
  if (owner?.summary) reports.ownerReviews = owner.summary;
  if (collectors.pageHistory) reports.pageHistory = await collect('reports', '全期間の端末別ページPV', collectors.pageHistory, null);
  const daily = pv.daily ?? [];
  const monthly = reservations.months ?? [];
  const data = { rating: publicData.rating ?? null, reviews: publicData.reviews ?? null };
  const missing = [];
  if (data.rating == null) missing.push('評価');
  if (data.reviews == null) missing.push('口コミ数');
  if (!daily.length) missing.push('日別PV');
  if (!monthly.length) missing.push('月別予約組数');
  else if(monthly.some(m=>m.reservations==null)) missing.push('一部の月の予約組数');
  if (publicData.issue) issues.push(publicData.issue);
  if (data.rating == null && data.reviews == null && !daily.length && !monthly.length && !owner?.items.length) {
    return { status:'error', step:'extraction', message:`食べログ: 保存できる数値がありません。${issues.join(' / ')}` };
  }
  const result = { status:missing.length ? 'partial' : 'ok', data, daily, monthly, reviews:publicData.reviewItems ?? [], reports };
  const detailsMissing = [];
  if (!reports.ranking) detailsMissing.push('エリア順位');
  if (!reports.topPages) detailsMissing.push('よく見られるページ');
  if (owner && !owner.summary) detailsMissing.push('管理画面の口コミ');
  if (collectors.pageHistory && !reports.pageHistory) detailsMissing.push('全期間のページ別PV');
  if (owner?.summary?.excerpts) issues.push(`管理画面で${owner.summary.excerpts}件は抜粋のみの表示です。全文とは区別して保存します。`);
  if (owner?.summary?.scoreOnly) issues.push(`管理画面で${owner.summary.scoreOnly}件は点数のみの表示で本文は掲載されていません。`);
  if (daily.some(d => [d.pc,d.sp,d.app].some(v => v == null))) detailsMissing.push('一部の端末別PV');
  if (missing.length || detailsMissing.length) {
    result.warning = `${[...missing,...detailsMissing].join('・')}は未取得です。取得できた数値だけを保存します。以前の値がある項目は取得日付きで保持します。${issues.length ? ` ${issues.join(' / ')}` : ''}`;
  }
  validateTabelogResult(result);
  return result;
}
