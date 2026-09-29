// 初回起動時に data/db.json を生成するデモデータ。
// 日次スナップ345日分（平日/週末の季節性 + ノイズ）と、日本語サンプル口コミを含みます。
import { SOURCE_IDS } from "./sources.js";
import { ikyuReviewRow } from "./ikyu-data.js";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260922);

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// サイトごとのベース値（規模感の違いを表現）
const PROFILE = {
  tabelog: { rating: 3.6, reviews: 168, pv: 2400, reservations: 18 },
  hotpepper: { rating: 3.8, reviews: 96, pv: 1800, reservations: 26 },
  google: { rating: 4.3, reviews: 210, pv: 3100, reservations: 8 },
  toreta: { rating: 4.6, reviews: 84, pv: 620, reservations: 42 },
  ikyu: { rating: 4.4, reviews: 52, pv: 480, reservations: 15 },
  retty: { rating: 3.9, reviews: 74, pv: 950, reservations: 6 },
};

function genSnapshots() {
  const out = [];
  const days = 45;
  for (const id of SOURCE_IDS) {
    const p = PROFILE[id];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dow = d.getDay();
      const weekend = dow === 5 || dow === 6 || dow === 0 ? 1.25 : 1.0;
      const trend = 1 + (days - i) * 0.0015;
      const noise = 0.88 + rand() * 0.24;
      const pv = Math.round(p.pv * weekend * trend * noise);
      const reservations = Math.max(0, Math.round(p.reservations * weekend * noise * 0.9));
      const rating = Math.round((p.rating + (rand() - 0.5) * 0.12) * 10) / 10;
      const reviewsCount = Math.round(p.reviews + (days - i) * 0.12 + rand() * 2);
      out.push({
        source: id,
        date: fmtDate(d),
        rating,
        reviews: reviewsCount,
        pv,
        visits: Math.round(pv * 0.27),
        reservations,
      });
    }
  }
  return out;
}

const SAMPLE_REVIEWS = {
  tabelog: [
    { rating: 5, sentiment: "positive", author: "肉好きさん", text: "ハンバーグがふわふわで最高でした。オープンキッチンで焼いているところも見え、スタッフの対応も丁寧。また必ず来ます。" },
    { rating: 4, sentiment: "positive", author: "ランチ派", text: "平日ランチでお世話になりました。価格の割にボリュームがあり満足。ドリンクバーも充実しています。" },
    { rating: 2, sentiment: "negative", author: "匿名", text: "週末の夜は混雑しすぎて待ち時間が長かった。予約の案内があるともっと良いです。" },
    { rating: 4, sentiment: "positive", author: "ご近所さん", text: "家族で利用しました。キッズメニューがあり助かりました。接客も柔らかく好印象です。" },
  ],
  hotpepper: [
    { rating: 5, sentiment: "positive", author: "宴会幹事", text: "コース料理を予約しました。料理のボリュームもあり、スタッフの動きも良く満足です。幹事特典もありがたい。" },
    { rating: 3, sentiment: "neutral", author: "匿名", text: "平均的なチェーンレベル。ただクーポン利用でコスパは良いです。" },
    { rating: 4, sentiment: "positive", author: "女子会主催", text: "女子会で利用。デザート盛り合わせが写真映えして盛り上がりました。" },
  ],
  google: [
    { rating: 5, sentiment: "positive", author: "Traveler", text: "Found this place by chance. Great service and the food quality exceeded expectations for the price range. Highly recommended." },
    { rating: 4, sentiment: "positive", author: "山田 太郎", text: "Google 予約で来店。スムーズな案内でスムーズに着席できました。味も安定しています。" },
    { rating: 2, sentiment: "negative", author: "匿名", text: "平日昼でも列ができていました。オーダーの取り忘れが一度ありました。" },
    { rating: 5, sentiment: "positive", author: "Kaori", text: "気づいたら常連になっていました。ハンバーグとクレームブリュレがおすすめです。" },
  ],
  toreta: [
    { rating: 5, sentiment: "positive", author: "匿名", text: "ウェブ予約から当日の案内まで一貫してスムーズ。特別な日におすすめです。" },
    { rating: 4, sentiment: "positive", author: "予約常連", text: "予約リマインダーが便利。当日も快適に過ごせました。" },
  ],
  ikyu: [
    { rating: 5, sentiment: "positive", text: "プレミアムな経験でした。料理の一皿一皿にこだわりを感じます。記念日に最適。", author: "匿名", },
    { rating: 4, sentiment: "positive", text: "シェフの料理を堪能。サービスのタイミングも絶妙でした。", author: "上質を求めて", },
  ],
  retty: [
    { rating: 4, sentiment: "positive", author: "リアル友達", text: "友人のおすすめで訪問。ハンバーグランチがコスパ最強です。" },
    { rating: 3, sentiment: "neutral", author: "匿名", text: "雰囲気は良いが、ランチは混雑しがち。時間帯をずらすのが吉。" },
  ],
};

function genReviews() {
  const out = [];
  let seq = 1;
  for (const id of SOURCE_IDS) {
    const list = SAMPLE_REVIEWS[id] ?? [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const d = new Date();
      d.setDate(d.getDate() - Math.floor(seq * 1.7 + rand() * 3));
      out.push({
        id: `rev-${seq++}`,
        source: id,
        rating: r.rating,
        text: r.text,
        author: r.author ?? "匿名",
        sentiment: r.sentiment,
        date: fmtDate(d),
      });
    }
  }
  // 新しい順にソート
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}

export function buildSeed() {
  const ikyu = buildIkyuDemo();
  return {
    credentials: [],
    snapshots: genSnapshots(),
    // 一休の口コミは取り込み形式のデモ（個別評価・返信状況つき）
    reviews: [...genReviews().filter((r) => r.source !== "ikyu"), ...ikyu.reviews].sort((a, b) => (a.date < b.date ? 1 : -1)),
    syncLog: [],
  };
}

// ---------- 一休: 取り込みデータのデモ（2店舗・約13か月の日別PV・口コミ） ----------
const IKYU_DEMO_REVIEWS = [
  ["グルメ太郎", 5, [5, 4, 5, 4, 4], "記念日で利用しました。前菜の盛り合わせが美しく、メインも絶品でした。", false],
  ["ランチ好き", 4, [4, 4, 4, 5, 3], "ランチコースのコスパが良く満足です。", false],
  ["mika", 3, [4, 3, 3, 3, 3], "料理は美味しかったですが、提供まで少し時間がかかりました。", true],
  ["ワイン党", 5, [5, 5, 4, 4, 5], "ワインペアリングが素晴らしかった。", true],
  ["はなこ", 5, [5, 5, 5, 5, 4], "誕生日プレートのサプライズに感動しました。", false],
  ["K.S", 2, [3, 2, 3, 2, 2], "予約時の席と違う席に案内されました。", true],
];
export function buildIkyuDemo(today = new Date()) {
  const rand = mulberry32(112789);
  const stores = [
    { storeId: "100001", name: "デモ 銀座店", base: 26 },
    { storeId: "100002", name: "デモ 横浜店", base: 14 },
  ];
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const daily = [];
  for (const store of stores) {
    for (let i = 400; i >= 1; i--) {
      const d = new Date(end.getTime() - i * 86_400_000);
      const dow = d.getUTCDay();
      const weekend = dow === 5 || dow === 6 ? 1.35 : dow === 0 ? 1.15 : 1;
      const season = 1 + 0.15 * Math.sin((d.getUTCMonth() / 12) * Math.PI * 2) + (400 - i) * 0.0006;
      const guide = Math.round(store.base * weekend * season * (0.75 + rand() * 0.5));
      const plan = Math.round(guide * (0.1 + rand() * 0.08));
      const other = rand() < 0.1 ? 1 : 0;
      const guideSp = Math.round(guide * 0.63), planSp = Math.round(plan * 0.66);
      const reservations = rand() < (plan / 60) ? 1 + (rand() < 0.2 ? 1 : 0) : 0;
      daily.push({
        storeId: store.storeId, date: d.toISOString().slice(0, 10),
        guideSp, guidePc: guide - guideSp, guide, planSp, planPc: plan - planSp, plan, otherSp: other, otherPc: 0, other,
        sp: guideSp + planSp + other, pc: guide - guideSp + plan - planSp, pv: guide + plan + other,
        reservations, amount: reservations * (15000 + Math.round(rand() * 12) * 1000),
      });
    }
  }
  const monthsMap = new Map();
  for (const d of daily) {
    const key = `${d.storeId}:${d.date.slice(0, 7)}`;
    const m = monthsMap.get(key) ?? { storeId: d.storeId, month: d.date.slice(0, 7), days: 0 };
    m.days++;
    for (const [k, v] of Object.entries(d)) if (typeof v === "number") m[k] = (m[k] ?? 0) + v;
    monthsMap.set(key, m);
  }
  const current = end.toISOString().slice(0, 7);
  const dim = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const months = [...monthsMap.values()].map((m) => ({ ...m, complete: m.month < current && m.days === dim(m.month) }));
  const reviews = [];
  stores.forEach((store, si) => IKYU_DEMO_REVIEWS.forEach(([handle, rating, cats, text, open], i) => {
    const posted = new Date(end.getTime() - (i * 38 + si * 11 + 3) * 86_400_000).toISOString().slice(0, 10);
    const visit = new Date(Date.parse(posted) - 2 * 86_400_000).toISOString().slice(0, 10);
    reviews.push(ikyuReviewRow({
      store_id: store.storeId, reservation_no: `DEMO${si}${i}`, visit_date: visit, visit_time: "19:00", posted_at: posted, published_at: posted,
      handle_name: handle, publication: "公開中", rating,
      scores: ["料理・味", "サービス", "雰囲気", "コストパフォーマンス", "酒・ドリンク"].map((label, j) => ({ label, value: cats[j] })),
      title: "", text, reply_text: open ? null : "ご来店ありがとうございました。またのお越しをお待ちしております。", reply_date: open ? null : posted,
      processing: open ? "未返信 ／ 未処理" : "返信済", needs_reply: open,
    }, store.name));
  }));
  return {
    demo: true,
    stores: stores.map((s) => ({ storeId: s.storeId, name: s.name, label: null, credentialUpdatedAt: null, reviewTotal: IKYU_DEMO_REVIEWS.length, pageviewsUpdatedAt: end.toISOString(), reviewsUpdatedAt: end.toISOString(),
      publicRating: s.storeId.endsWith("9") ? 4.38 : 4.21, publicReviewCount: IKYU_DEMO_REVIEWS.length, publicUpdatedAt: end.toISOString() })),
    months, daily, reviews,
    runs: [{ runKey: "demo", agent: "grok-bot", capturedAt: end.toISOString(), receivedAt: end.toISOString(), status: "ok", stores: 2, days: daily.length, months: months.length, reviews: reviews.length, newReviews: 0, message: "" }],
  };
}
