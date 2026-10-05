// 食べログの取得結果（collectTabelogMetrics の出力）→ agent-api /ingest の共通形式（schemaVersion 1）。
// エージェント側の純粋関数。サーバー側でも normalizeSourceIngest が再検証する。
import { validateTabelogResult } from "./validate.js";

const isoDate = (text) => {
  const m = String(text ?? "").match(/(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};
const devices = (row) => {
  const all = [row.pc, row.sp, row.app].every((v) => v != null);
  return { pvPc: row.pc ?? null, pvSp: row.sp ?? null, pvApp: row.app ?? null, pvOther: row.unclassified ?? (all ? 0 : null) };
};

export function tabelogResultToPayload(result, { storeKey, name = null, publicUrl = null, runId, agent = "grok-bot", capturedAt = new Date().toISOString(), requestId, today } = {}) {
  if (!result || !["ok", "partial"].includes(result.status)) throw new Error(result?.message ?? "食べログの取得結果がありません");
  validateTabelogResult(result);
  if (!/^[0-9A-Za-z_-]{0,40}$/.test(String(storeKey ?? ""))) throw new Error("storeKey が不正です（食べログの店舗ID等、英数字40文字以内）");
  const captureDay = today ?? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(capturedAt));
  const owned = (result.reviews ?? []).filter((r) => r.externalId);
  const reports = [];
  const r = result.reports ?? {};
  if (r.ranking) reports.push({ kind: "area_ranking", period: r.ranking.updatedAt ?? captureDay, data: r.ranking });
  if (r.topPages) reports.push({ kind: "top_pages", period: r.topPages.month, data: r.topPages });
  if (r.deviceSummary) reports.push({ kind: "device_summary", period: r.deviceSummary.to.slice(0, 7), data: r.deviceSummary });
  if (r.ownerReviews) reports.push({ kind: "owner_reviews", period: captureDay, data: r.ownerReviews });
  if (r.pageHistory) reports.push({ kind: "page_history", period: `${r.pageHistory.first}-${r.pageHistory.last}`, data: r.pageHistory });
  const d = result.data ?? {};
  if (d.saveCount != null || d.budgetNight != null || d.budgetDay != null || d.station != null || d.openedOn != null) {
    reports.push({
      kind: "public_profile",
      period: captureDay,
      data: {
        rating: d.rating ?? null,
        reviewCount: d.reviews ?? null,
        saveCount: d.saveCount ?? null,
        budgetNight: d.budgetNight ?? null,
        budgetDay: d.budgetDay ?? null,
        station: d.station ?? null,
        openedOn: d.openedOn ?? null,
        capturedAt,
      },
    });
  }
  if (r.reservationNotices) {
    reports.push({
      kind: "reservation_notices",
      period: r.reservationNotices.capturedAt?.slice?.(0, 10) ?? captureDay,
      data: {
        new: r.reservationNotices.new ?? 0,
        changed: r.reservationNotices.changed ?? 0,
        cancelled: r.reservationNotices.cancelled ?? 0,
        capturedAt: r.reservationNotices.capturedAt ?? capturedAt,
      },
    });
  }
  if (Array.isArray(r.publicGenreRankings)) {
    for (const row of r.publicGenreRankings) {
      const period = `${captureDay}_${row.areaKey ?? "area"}_${row.genreKey ?? "genre"}`.slice(0, 40);
      reports.push({ kind: "public_genre_ranking", period, data: row });
    }
  }
  if (r.publicCompetitors) {
    reports.push({ kind: "public_competitors", period: captureDay, data: r.publicCompetitors });
  }
  if (Array.isArray(r.publicNewOpens)) {
    for (const row of r.publicNewOpens) {
      const period = `${captureDay}_${row.areaKey ?? "area"}_${row.genreKey ?? "genre"}`.slice(0, 40);
      reports.push({ kind: "public_new_opens", period, data: row });
    }
  }
  const summary = (d.rating != null || d.reviews != null || d.saveCount != null || d.budgetNight != null || d.budgetDay != null)
    ? {
      rating: d.rating ?? null,
      reviewCount: d.reviews ?? null,
      ...(d.saveCount != null ? { saveCount: d.saveCount } : {}),
      ...(d.budgetNight != null ? { budgetNight: d.budgetNight } : {}),
      ...(d.budgetDay != null ? { budgetDay: d.budgetDay } : {}),
      ...(d.station != null ? { station: d.station } : {}),
    }
    : null;
  const store = {
    storeKey: String(storeKey ?? ""), name, ...(publicUrl ? { publicUrl } : {}),
    summary,
    daily: result.daily.map((day) => ({ date: day.date, pv: day.pv, ...devices(day) })),
    monthly: result.monthly.map((m) => ({
      month: m.month, pv: m.pv ?? null, ...devices(m), reservations: m.reservations ?? null, calls: m.calls ?? null,
      ...(m.mapPrints != null ? { extra: { mapPrints: m.mapPrints } } : {}),
    })),
    reviews: owned.length || r.ownerReviews ? {
      total: owned.length,
      items: owned.map((x) => ({
        externalId: x.externalId, rating: x.rating ?? null, title: x.title ?? "", text: x.text ?? "",
        textComplete: x.details?.textComplete ?? true, author: x.author ?? null, postedAt: x.date ?? null, visitMonth: x.visitMonth ?? null,
        scores: (x.details?.scores ?? []).map((s) => ({ label: String(s.label ?? ""), value: s.value ?? null, breakdown: s.breakdown ?? null })),
        reply: x.details?.ownerReply?.text ? { text: x.details.ownerReply.text, date: isoDate(x.details.ownerReply.date), status: x.details.ownerReply.status || null } : null,
        details: { origin: x.details?.origin ?? null, groupId: x.groupId ?? null, usedPrice: x.details?.usedPrice ?? null },
      })),
    } : null,
    reports,
  };
  return {
    schemaVersion: 1, source: "tabelog", runId: runId ?? `tabelog-${String(storeKey || "default")}-${capturedAt.replace(/[^0-9]/g, "").slice(0, 14)}`,
    agent, capturedAt, ...(requestId ? { requestId } : {}), ...(result.warning ? { warning: result.warning.slice(0, 1000) } : {}),
    stores: [store],
  };
}
