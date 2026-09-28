export const japanDate = (date = new Date()) => new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
}).format(date);

const count = (v) => Number.isSafeInteger(v) && v >= 0;
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function validateTabelogResult(result) {
  if (!result.data || !Array.isArray(result.daily) || !Array.isArray(result.monthly)) throw new Error("取得結果の形式が不正です");
  const { rating, reviews } = result.data;
  if ((rating != null && (!Number.isFinite(rating) || rating < 0 || rating > 5))
    || (reviews != null && !count(reviews))) throw new Error("評価または口コミ数を正しく取得できませんでした");
  const missing = rating == null || reviews == null || !result.daily.length || !result.monthly.length;
  if (missing && (result.status !== "partial" || !result.warning)) throw new Error("評価・口コミ数・日別PV・月別予約組数に未取得の項目があります");
  if (rating == null && reviews == null && !result.daily.length && !result.monthly.length) throw new Error("保存できる数値がありません");
  const dates = new Set();
  for (const row of result.daily) {
    if (!validDate(row.date) || !count(row.pv) || dates.has(row.date)) throw new Error("日別PVの日付または数値が不正です");
    dates.add(row.date);
    const values = [row.pc, row.sp, row.app];
    if (values.some((v) => v != null && !count(v))) throw new Error("端末別PVの数値が不正です");
    if (values.every((v) => v != null) && values.reduce((a, b) => a + b, 0) !== row.pv) {
      throw new Error("日別PVの合計と端末別PVの合計が一致しません");
    }
  }
  const months = new Set();
  for (const row of result.monthly) {
    if (!validDate(`${row.month}-01`) || !count(row.reservations) || months.has(row.month)) {
      throw new Error("月別予約組数の年月または数値が不正です");
    }
    months.add(row.month);
    if ([row.pv, row.pc, row.sp, row.app, row.calls, row.mapPrints].some((v) => v != null && !count(v))) {
      throw new Error("月別レポートの数値が不正です");
    }
    if ([row.pv, row.pc, row.sp, row.app].every((v) => v != null) && row.pc + row.sp + row.app !== row.pv) {
      throw new Error("月別PVの合計と端末別PVの合計が一致しません");
    }
  }
}

export function snapshotUpdates(userId, source, result, today = japanDate()) {
  const rows = new Map();
  const add = (date, values) => rows.set(date, { ...rows.get(date), user_id: userId, source, date, ...values });
  if (result.daily) {
    for (const d of result.daily) add(d.date, { pv: d.pv });
    for (const m of result.monthly ?? []) add(`${m.month}-01`, { reservations: m.reservations });
    const current = Object.fromEntries(Object.entries(result.data ?? {}).filter(([key, value]) => ["rating", "reviews"].includes(key) && value != null));
    if (Object.keys(current).length) add(today, current);
  } else {
    add(today, Object.fromEntries(Object.entries(result.data ?? {}).filter(([, v]) => v != null)));
  }
  return [...rows.values()];
}

// 同じ行のPV・予約・評価をまとめる。取得対象外の既存列を0で上書きしない。
export function mergeSnapshots(updates, existing) {
  const byDate = new Map(existing.map((row) => [row.date, row]));
  return updates.map((row) => ({ rating: null, reviews: null, pv: null, visits: null, reservations: null, ...byDate.get(row.date), ...row }));
}

export function verifySnapshots(expected, saved) {
  const byDate = new Map((saved ?? []).map((row) => [row.date, row]));
  for (const row of expected) {
    const actual = byDate.get(row.date);
    if (!actual) throw new Error(`${row.date} の保存を確認できませんでした`);
    for (const key of ["rating", "reviews", "pv", "visits", "reservations"]) {
      if (row[key] == null) {
        if (actual[key] != null) throw new Error(`${row.date} の未取得項目が数値に置き換わっています（${key}）`);
        continue;
      }
      if (actual[key] == null || !Number.isFinite(Number(actual[key])) || Math.abs(Number(actual[key]) - row[key]) > 0.0001) {
        throw new Error(key === "rating"
          ? "評価の保存値が一致しません。データベースの小数点精度を確認してください"
          : `${row.date} の取得値と保存値が一致しません（${key}）`);
      }
    }
  }
}

export async function must(query) {
  const { data, error } = await query;
  if (error) throw new Error(error.message || "データベース処理に失敗しました");
  return data;
}

export async function saveSyncResult(client, userId, source, result) {
  if (source === "tabelog") validateTabelogResult(result);
  const today = japanDate();
  const updates = snapshotUpdates(userId, source, result, today);
  const existing = await must(client.from("snapshots")
    .select("date,rating,reviews,pv,visits,reservations").eq("user_id", userId).eq("source", source).in("date", updates.map((r) => r.date)));
  const rows = mergeSnapshots(updates, existing ?? []);
  const saved = await must(client.from("snapshots").upsert(rows, { onConflict: "user_id,source,date" })
    .select("date,rating,reviews,pv,visits,reservations"));
  verifySnapshots(rows, saved);

  // JSON-LDに含まれる口コミは抜粋。掲載されなかった過去の口コミを削除しない。
  if (result.reviews?.length) {
    const known = new Set((await must(client.from("reviews").select("text").eq("user_id", userId).eq("source", source))).map((r) => r.text));
    const fresh = result.reviews.filter((review) => {
      if (!review.text || known.has(review.text)) return false;
      known.add(review.text);
      return true;
    });
    if (fresh.length) await must(client.from("reviews").insert(fresh.map((review) => ({
      user_id: userId, source, rating: review.rating ?? 0, text: review.text,
      author: review.author ?? "匿名", sentiment: "neutral", review_date: today,
    }))));
  }
  return {
    rating: result.data.rating ?? null, reviews: result.data.reviews ?? null,
    dailyDays: result.daily?.length ?? 0, monthlyMonths: result.monthly?.length ?? 0,
    latestPvDate: result.daily?.map((d) => d.date).sort().at(-1) ?? null,
  };
}
