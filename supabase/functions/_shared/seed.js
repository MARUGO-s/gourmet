// 初回起動時に data/db.json を生成するデモデータ。
// 日次スナップ345日分（平日/週末の季節性 + ノイズ）と、日本語サンプル口コミを含みます。
import { SOURCE_IDS } from "./sources.js";

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
  return {
    credentials: [],
    snapshots: genSnapshots(),
    reviews: genReviews(),
    syncLog: [],
  };
}
