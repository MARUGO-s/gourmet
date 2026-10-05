// 食べログ店舗管理トップ「新着ご予約情報」の件数だけを読む（氏名・電話等は取り込まない）。
// document を読む自己完結関数。Playwright page.evaluate 用。
export function readReservationNotices() {
  const countFrom = (text) => {
    const m = String(text ?? "").replace(/,/g, "").match(/(\d+)\s*件/);
    if (m) return Number(m[1]);
    const n = String(text ?? "").replace(/,/g, "").match(/^(\d+)$/);
    return n ? Number(n[1]) : null;
  };
  const pick = (labels) => {
    const nodes = [...document.querySelectorAll("a, button, li, th, td, span, div, h2, h3, dt, dd")];
    for (const label of labels) {
      const el = nodes.find((n) => {
        const t = (n.textContent ?? "").replace(/\s+/g, " ").trim();
        return t === label || t.startsWith(label) || new RegExp(`^${label}[\\s（(：:].*`).test(t);
      });
      if (!el) continue;
      const own = countFrom(el.textContent);
      if (own != null) return own;
      const sib = el.nextElementSibling;
      if (sib) {
        const c = countFrom(sib.textContent);
        if (c != null) return c;
      }
      const parent = el.parentElement;
      if (parent) {
        const c = countFrom(parent.textContent.replace(label, ""));
        if (c != null) return c;
      }
    }
    return null;
  };
  // 件数ノードが data-* やクラスで載っている場合
  const byAttr = (keys) => {
    for (const key of keys) {
      const el = document.querySelector(`[data-notice="${key}"], [data-count-kind="${key}"], .js-notice-${key}, #notice-${key}`);
      if (!el) continue;
      const c = countFrom(el.getAttribute("data-count") ?? el.textContent);
      if (c != null) return c;
    }
    return null;
  };
  const fresh = {
    new: byAttr(["new", "create", "created"]) ?? pick(["新規予約", "新規のご予約", "新規"]),
    changed: byAttr(["changed", "change", "modified"]) ?? pick(["予約内容の変更", "内容変更", "変更"]),
    cancelled: byAttr(["cancelled", "canceled", "cancel"]) ?? pick(["キャンセル", "取消"]),
  };
  const found = [fresh.new, fresh.changed, fresh.cancelled].some((v) => v != null);
  return {
    new: fresh.new ?? 0,
    changed: fresh.changed ?? 0,
    cancelled: fresh.cancelled ?? 0,
    found,
    // 個人情報は返さない（件数のみ）
  };
}
