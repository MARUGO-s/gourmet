// 食べログの取得結果（collectTabelogMetrics の出力）の検証。エージェント側で送信前に実行する。
// サーバー側でも agent-api /ingest が共通形式として再検証する。
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function validateTabelogResult(result) {
  if (!result.data || !Array.isArray(result.daily) || !Array.isArray(result.monthly)) throw new Error("取得結果の形式が不正です");
  const { rating, reviews, saveCount } = result.data;
  if ((rating != null && (!Number.isFinite(rating) || rating < 0 || rating > 5))
    || (reviews != null && !count(reviews))
    || (saveCount != null && !count(saveCount))) throw new Error("評価または口コミ数を正しく取得できませんでした");
  const missing = rating == null || reviews == null || !result.daily.length || !result.monthly.length || result.monthly.some(m=>m.reservations==null);
  if (missing && (result.status !== "partial" || !result.warning)) throw new Error("評価・口コミ数・日別PV・月別予約組数に未取得の項目があります");
  if (rating == null && reviews == null && !result.daily.length && !result.monthly.length && !result.reviews?.length) throw new Error("保存できる数値がありません");
  if (result.daily.length > 5000 || result.monthly.length > 240 || (result.reviews?.length ?? 0) > 1000) throw new Error('取得対象の上限を超えています');
  const ids = new Set();
  for (const review of result.reviews ?? []) if (review.externalId) {
    if (!/^B\d+:(?:\d+|excerpt)$/.test(review.externalId) || ids.has(review.externalId)) throw new Error('口コミの識別情報が不正です');
    ids.add(review.externalId);
    if ((review.date != null && !validDate(review.date)) || (review.visitMonth != null && !validDate(`${review.visitMonth}-01`))) throw new Error('口コミの日付が不正です');
    if (review.rating != null && (!Number.isFinite(review.rating) || review.rating < 0 || review.rating > 5)) throw new Error('口コミの点数が不正です');
    if (typeof review.text !== 'string' || review.text.length > 50000 || typeof review.details?.textComplete !== 'boolean') throw new Error('口コミ本文の形式が不正です');
  }
  const dates = new Set();
  for (const row of result.daily) {
    if (!validDate(row.date) || !count(row.pv) || dates.has(row.date)) throw new Error("日別PVの日付または数値が不正です");
    dates.add(row.date);
    const values = [row.pc, row.sp, row.app];
    if (values.some((v) => v != null && !count(v))) throw new Error("端末別PVの数値が不正です");
    if(row.unclassified!=null&&!count(row.unclassified))throw new Error('日別PVの内訳差が不正です');
    if (values.every((v) => v != null) && values.reduce((a, b) => a + b, 0) + (row.unclassified??0) !== row.pv) {
      throw new Error("日別PVの合計と端末別PVの合計が一致しません");
    }
  }
  const months = new Set();
  for (const row of result.monthly) {
    if (!validDate(`${row.month}-01`) || (row.reservations != null && !count(row.reservations)) || months.has(row.month)) {
      throw new Error("月別予約組数の年月または数値が不正です");
    }
    months.add(row.month);
    if ([row.pv, row.pc, row.sp, row.app, row.calls, row.mapPrints].some((v) => v != null && !count(v))) {
      throw new Error("月別レポートの数値が不正です");
    }
    if(row.unclassified!=null&&!count(row.unclassified))throw new Error('月別PVの内訳差が不正です');
    if ([row.pv, row.pc, row.sp, row.app].every((v) => v != null) && row.pc + row.sp + row.app + (row.unclassified??0) !== row.pv) {
      throw new Error("月別PVの合計と端末別PVの合計が一致しません");
    }
  }
}
