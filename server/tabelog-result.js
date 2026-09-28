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
  const publicData = await collect('public_metrics', '評価・口コミ数', collectors.publicMetrics, {});
  const pv = await collect('daily_pv', '日別・端末別PV', collectors.dailyMetrics, {});
  const reservations = await collect('monthly', '月別予約組数・来店指標', collectors.monthlyMetrics, {});
  const reports = await collect('reports', 'エリア順位・ページ別PV', () => collectors.detailReports(publicData.name), {});
  const daily = pv.daily ?? [];
  const monthly = reservations.months ?? [];
  const data = { rating: publicData.rating ?? null, reviews: publicData.reviews ?? null };
  const missing = [];
  if (data.rating == null) missing.push('評価');
  if (data.reviews == null) missing.push('口コミ数');
  if (!daily.length) missing.push('日別PV');
  if (!monthly.length) missing.push('月別予約組数');
  if (publicData.issue) issues.push(publicData.issue);
  if (data.rating == null && data.reviews == null && !daily.length && !monthly.length) {
    return { status:'error', step:'extraction', message:`食べログ: 保存できる数値がありません。${issues.join(' / ')}` };
  }
  const result = { status:missing.length ? 'partial' : 'ok', data, daily, monthly, reviews:publicData.reviewItems ?? [], reports };
  const detailsMissing = [];
  if (!reports.ranking) detailsMissing.push('エリア順位');
  if (!reports.topPages) detailsMissing.push('よく見られるページ');
  if (daily.some(d => [d.pc,d.sp,d.app].some(v => v == null))) detailsMissing.push('一部の端末別PV');
  if (missing.length || detailsMissing.length) {
    result.warning = `${[...missing,...detailsMissing].join('・')}は未取得です。取得できた数値だけを保存します。以前の値がある項目は取得日付きで保持します。${issues.length ? ` ${issues.join(' / ')}` : ''}`;
  }
  validateTabelogResult(result);
  return result;
}
