// 食べログ店舗管理トップ（https://owner.tabelog.com/）「新着ご予約情報」の件数だけを読む（氏名・電話等は取り込まない）。
// document を読む自己完結関数。Playwright page.evaluate 用（モジュール外の関数・定数を参照しない）。
//
// 実画面の形（2026-10-05 ログイン後のトップで確認）:
//   <h4 class="owner-heading3 …">新着ご予約情報</h4>
//   <dl class="owner-side__today-news">
//     <dt class="owner-side__today-news-title">新規ご予約</dt>
//     <dd class="owner-side__today-news-count"><span class="badge … today-news-badge">2</span>件</dd>
//     <dt …>ご予約内容変更</dt><dd …>…</dd>
//     <dt …>ご予約キャンセル</dt><dd …>…</dd>
//   </dl>
// ラベルは完全一致で見る（「キャンセル料請求」「本日のご予約」などサイドバーの別の欄を拾わない）。
export function readReservationNotices() {
  const norm = (text) => String(text ?? "").replace(/[\s,，]/g, "");
  const countFrom = (text) => {
    const s = norm(text);
    const m = s.match(/^(\d+)件?$/) ?? s.match(/(\d+)件/);
    return m ? Number(m[1]) : null;
  };
  const LABELS = {
    new: ["新規ご予約", "新規予約", "新規のご予約"],
    changed: ["ご予約内容変更", "ご予約内容の変更", "予約内容変更", "予約内容の変更"],
    cancelled: ["ご予約キャンセル", "予約キャンセル", "ご予約の取消", "予約取消"],
  };
  const kindOf = (text) => {
    const t = norm(text);
    for (const kind of Object.keys(LABELS)) if (LABELS[kind].includes(t)) return kind;
    return null;
  };
  const scopes = [...document.querySelectorAll(".owner-side__today-news")];
  const titles = scopes.length
    ? scopes.flatMap((scope) => [...scope.querySelectorAll("dt")])
    : [...document.querySelectorAll("dt, th")];
  const fresh = { new: null, changed: null, cancelled: null };
  for (const title of titles) {
    const kind = kindOf(title.textContent);
    if (!kind || fresh[kind] != null) continue;
    const value = title.nextElementSibling;
    const count = value ? countFrom(value.textContent) : null;
    if (count != null) fresh[kind] = count;
  }
  const found = Object.values(fresh).some((v) => v != null);
  return {
    new: fresh.new ?? 0,
    changed: fresh.changed ?? 0,
    cancelled: fresh.cancelled ?? 0,
    found,
    // 個人情報は返さない（件数のみ）
  };
}
