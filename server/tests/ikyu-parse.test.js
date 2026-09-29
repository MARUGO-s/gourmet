// 一休パーサー（取り込み用ツール）のテスト。fixtures/ikyu-* はすべて合成（SYNTHETIC）HTMLで、実画面の保存ではない。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodeHtml, detectCharset, parseHtml } from "../../scripts/ikyu/html-lite.js";
import { parseIkyuPageview, parseIkyuReviews, buildIkyuStore, parseCount, parseRating, parseJapaneseDate } from "../../scripts/ikyu/parse.js";

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const pvHtml = () => decodeHtml(fixture("ikyu-pageview-2026-09.sjis.html")).html;
const rv1 = () => fixture("ikyu-reviews-page1.html").toString("utf8");
const rv2 = () => fixture("ikyu-reviews-page2.html").toString("utf8");

test("Shift_JIS bytes are decoded from the meta charset, HTTP header first, UTF-8 saved pages stay UTF-8", () => {
  const sjis = fixture("ikyu-pageview-2026-09.sjis.html");
  assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(sjis));
  assert.equal(detectCharset(sjis), "shift_jis");
  assert.equal(detectCharset(sjis, "text/html; charset=Windows-31J"), "shift_jis");
  assert.match(decodeHtml(sjis).html, /店舗ガイド/);
  // 「店舗」= 0x93 0x58 0x95 0xDC (Shift_JIS)
  assert.equal(decodeHtml(new Uint8Array([0x93, 0x58, 0x95, 0xdc])).html, "店舗");
  // ブラウザ保存のHTML: 本文UTF-8 + meta Shift_JIS
  const saved = fixture("ikyu-reviews-page1.html");
  assert.match(saved.toString("latin1"), /charset=Shift_JIS/);
  assert.equal(detectCharset(saved), "utf-8");
});

test("PV table: month totals and verified days match the manually checked figures", () => {
  const r = parseIkyuPageview(pvHtml(), "2026-09");
  assert.equal(r.days.length, 30);
  assert.deepEqual([r.totals.pv, r.totals.guide, r.totals.plan, r.totals.other, r.totals.sp, r.totals.pc], [665, 586, 79, 0, 419, 246]);
  assert.equal(r.days.find((d) => d.date === "2026-09-22").pv, 95);
  assert.equal(r.days.find((d) => d.date === "2026-09-25").pv, 118);
  const d22 = r.days.find((d) => d.date === "2026-09-22");
  assert.equal(d22.guideSp + d22.guidePc, d22.guide);
  assert.equal(d22.reservations, 2); assert.equal(d22.amount, 33000);
  // 未掲載（-）は0ではなくnull
  assert.equal(r.days.at(-1).pv, null);
  assert.equal(r.storeName, "ビストロ サヴァサヴァ");
  assert.equal(r.months[0], "2024-09"); assert.equal(r.months.at(-1), "2027-01");
});

test("PV parser refuses inconsistent or unexpected tables instead of guessing", () => {
  const html = pvHtml();
  assert.throws(() => parseIkyuPageview(html.replace("<FONT size=\"2\">09/22(火)</FONT>", "<FONT size=\"2\">10/22(木)</FONT>"), "2026-09"), /日付/);
  // 9/22 の店舗ガイド・スマホを1増やす → 行内の合計不一致
  const broken = html.replace(/(09\/22\(火\)<\/FONT><TD[^>]*><FONT size="2">)(\d+)/, (_, a, n) => `${a}${Number(n) + 1}`);
  assert.throws(() => parseIkyuPageview(broken, "2026-09"), /一致しません/);
  assert.throws(() => parseIkyuPageview(html.replaceAll("プラン詳細", "プラン一覧").replaceAll("店舗ガイド", "店舗"), "2026-09"), /見つかりません|列/);
  assert.throws(() => parseIkyuPageview('<form><input type="text" name="StoreId"><input type="password"></form>', "2026-09"), /ログインできません/);
  assert.equal(parseCount("1,234"), 1234); assert.equal(parseCount("¥12,000"), 12000); assert.equal(parseCount("-"), null);
  assert.throws(() => parseCount("abc"));
});

test("reviews: 10 + 3 entries with ratings, categories, dates, status and list link; the search form is ignored", () => {
  const p1 = parseIkyuReviews(rv1(), "112789");
  const p2 = parseIkyuReviews(rv2(), "112789");
  assert.equal(p1.items.length, 10); assert.equal(p2.items.length, 3);
  assert.equal(p1.total, 13); assert.equal(p2.total, 13);
  assert.equal(p1.next.text, "次へ>"); assert.equal(p2.next, null);
  const first = p1.items[0];
  assert.equal(first.reservationNo, "26092000");
  assert.equal(first.visitDate, "2026-09-20"); assert.equal(first.visitTime, "18:30");
  assert.equal(first.postedAt, "2026-09-22"); assert.equal(first.publishedAt, "2026-09-24");
  assert.equal(first.handleName, "グルメ太郎"); assert.equal(first.publication, "公開中");
  assert.equal(first.rating, 5);
  assert.deepEqual(first.scores.map((s) => s.label), ["総合", "料理・味", "サービス", "雰囲気", "コストパフォーマンス", "酒・ドリンク"]);
  assert.match(first.text, /記念日で利用しました。.*\nスタッフの方/s);
  assert.equal(first.reply, null); assert.equal(first.needsReply, true);
  assert.match(first.listUrl, /^https:\/\/restaurant\.ikyu\.com\/rsOwner\/v2\/112789\/legacy\?path=\/scriptO\/rsOwnImpressions\.asp$/);
  assert.equal(p1.items[5].publication, "非公開"); assert.equal(p1.items[5].publishedAt, null);
  // 予約者の氏名は出力に含めない
  assert.ok(!JSON.stringify(p1.items).includes("山田"));
  assert.ok(!JSON.stringify(p1.items).includes("返信を登録する"));
});

test("a replied review is not flagged as 要返信", () => {
  const html = rv1()
    .replace('<textarea name="txtReply0" rows="4" cols="70"></textarea>', '<textarea name="txtReply0" rows="4" cols="70">ご来店ありがとうございました。</textarea>')
    .replace('<font color="#CC0000">未返信</font> ／ 未処理', "返信済");
  const first = parseIkyuReviews(html, "112789").items[0];
  assert.equal(first.reply.text, "ご来店ありがとうございました。");
  assert.equal(first.processing, "返信済"); assert.equal(first.needsReply, false);
});

test("store payload requires every review page and keeps only contract fields", () => {
  const store = buildIkyuStore("112789", { pvPages: [{ month: "2026-09", html: pvHtml() }], reviewPages: [rv1(), rv2()] });
  assert.equal(store.name, "ビストロ サヴァサヴァ");
  assert.equal(store.reviews.total, 13); assert.equal(store.reviews.items.length, 13);
  assert.equal(store.reviews.items[0].externalId, undefined); assert.equal(store.reviews.items[0].listUrl, undefined);
  assert.throws(() => buildIkyuStore("112789", { reviewPages: [rv1()] }), /全件/);
  assert.throws(() => parseIkyuReviews(rv1(), "12345"), /店舗ID/);
});

test("helpers: ratings, Japanese dates and a tolerant HTML tree", () => {
  assert.equal(parseRating("★★★★☆"), 4); assert.equal(parseRating("4.5点"), 4.5); assert.equal(parseRating("評価なし"), null); assert.equal(parseRating("7"), null);
  assert.equal(parseJapaneseDate("2026年9月2日(水)"), "2026-09-02"); assert.equal(parseJapaneseDate("2026/02/30"), null);
  const root = parseHtml("<table><tr><td>a<td>b<tr><td><table><tr><td>x</table><td>c</table><script>'<td>'</script>");
  const outer = root.byTag("table")[0];
  assert.equal(outer.rows().length, 2);
  assert.deepEqual(outer.rows()[1].cells().map((c) => c.inline), ["x", "c"]);
});

// 2026-09に実画面で確認した構造（主要ページ別とサイト別が別グループ、口コミ本体/返信/ステータスが兄弟の表、評価は1セル、星は私用領域文字）。値は合成。
test("real-layout (2026-09) PV and review markup are parsed", () => {
  const pv = `<table class="main"><tr><th rowspan="2">日付</th><th colspan="3">アクセス数<br>（主要ページ別）</th><th colspan="3">アクセス数<br>（サイト別）</th><th colspan="2">予約状況<br>(当日に入った予約)</th></tr>
<tr><td>店舗ガイド</td><td>プラン詳細</td><td>その他</td><td>スマホ</td><td>PC</td><td>合計</td><td>プラン数</td><td>合計金額</td></tr>
<tr><td>2026/09/01（火）</td><td>1</td><td>0</td><td>0</td><td>1</td><td>0</td><td><b>1</b></td><td>1件</td><td>0円</td></tr>
<tr><td>2026/09/02（水）</td><td>5</td><td>1</td><td>0</td><td>2</td><td>4</td><td><b>6</b></td><td></td><td></td></tr></table>`;
  const parsed = parseIkyuPageview(pv, "2026-09");
  assert.deepEqual(parsed.days.map((d) => [d.guide, d.plan, d.other, d.sp, d.pc, d.pv, d.reservations]), [[1, 0, 0, 1, 0, 1, 1], [5, 1, 0, 2, 4, 6, null]]);
  const bad = pv.replace("<b>6</b>", "<b>7</b>");
  assert.throws(() => parseIkyuPageview(bad, "2026-09"));
  const review = (no) => `<div><table class="bg"><tr><td><table class="main"><tr><th>予約番号</th><td><form method="post" action="./rsOwnRsrvDtl.asp"><input type="submit" name="reserveNo" value="${no}"></form>(一休.comレストラン)</td><th>来店日時</th><td>2024/01/23 18:30</td><th>来店者名</th><td>合成 太郎</td></tr>
<tr><th>サイトに掲載</th><td>クチコミ掲載中</td><th>投稿日時</th><td>2024/01/23 23:01:46</td><th>ハンドルネーム</th><td>synthetic</td></tr>
<tr><th>評価</th><td colspan="5">総合評価&nbsp;\uE60F(4.5)&nbsp;<br>料理・味&nbsp;\uE60D(5.0)&nbsp; コストパフォーマンス&nbsp;(4.0)</td></tr>
<tr><th>利用の感想</th><td colspan="5">合成の感想です。</td></tr></table></td></tr></table>
<table class="bg"><tr><td><table class="main"><tr><th>返信公開の希望</th><td>－</td><th>返信日時</th><td>－</td><th>返信担当者</th><td>－</td></tr>
<tr><th>返信コメント</th><td colspan="5"><b><font color="ff0000">未返信</font></b></td></tr></table></td></tr></table>
<table><tr><td>ステータス：<b>未処理（未返信）</b></td></tr></table>`;
  const r = parseIkyuReviews(`${review("IR0000000001")}${review("IR0000000002")}</div>`, "112789");
  assert.equal(r.items.length, 2);
  const [a] = r.items;
  assert.equal(a.reservationNo, "IR0000000001");
  assert.equal(a.rating, 4.5);
  assert.deepEqual(a.scores.map((s) => [s.label, s.value]), [["総合評価", 4.5], ["料理・味", 5], ["コストパフォーマンス", 4]]);
  assert.equal(a.publication, "クチコミ掲載中");
  assert.equal(a.reply, null);
  assert.equal(a.needsReply, true);
  assert.equal(a.processing, "未処理(未返信)");
  assert.ok(!JSON.stringify(a).includes("合成 太郎"), "来店者名は保存しない");
});
