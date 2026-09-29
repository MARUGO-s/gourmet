import { useState } from "react";
import type { DashboardData, Review, SourceMeta } from "../types";

function Score({ rating }: { rating: number | null }) {
  return <span className="font-bold">{rating == null ? "未掲載" : rating.toFixed(2)}</span>;
}

function ReviewBody({ review: r }: { review: Review }) {
  const scores = r.details?.scores ?? [];
  return <details className="min-w-[260px] max-w-[600px]">
    <summary className="cursor-pointer text-[12px] leading-relaxed text-subtle">
      <span className="font-bold">{r.title || r.text.slice(0, 70) || "本文なし"}</span>
      <span className="ml-2 text-[10px] text-faint">{!r.text ? "点数のみ" : r.details?.textComplete === false ? "抜粋" : "本文を表示"}</span>
      {r.details?.needsReply ? <span className="ml-2 rounded bg-danger-soft px-1.5 py-0.5 text-[9px] font-bold text-danger">要返信</span> : null}
      <span className="mt-1 block text-[10px] text-faint">{r.author}</span>
    </summary>
    <div className="mt-3 space-y-3 text-[12px] leading-relaxed">
      {!r.text ? <p className="text-faint">管理画面に本文は掲載されていません。</p> : r.details?.textComplete === false ? <p className="text-warn">管理画面に掲載されている抜粋です。</p> : null}
      <p className="whitespace-pre-wrap break-words">{r.text}</p>
      {scores.map((s, i) => <div key={i} className="rounded bg-surface p-2">
        <p>{s.label || "個別評価"}：<Score rating={s.value} /></p>
        {s.breakdown ? <p className="mt-1 text-[11px] text-subtle">{s.breakdown.replace(/\d+\.\d+/g, n => Number(n).toFixed(2))}</p> : null}
      </div>)}
      {r.details?.usedPrice ? <p className="text-subtle">{r.details.usedPrice}</p> : null}
      {r.details?.origin === "ikyu_owner" ? <p className="text-[11px] text-subtle">
        {r.details.storeName ? `${r.details.storeName} ・ ` : ""}予約番号 {r.details.reservationNo} ・ 来店 {r.details.visitDate ?? "—"} {r.details.visitTime ?? ""} ・ {r.details.publication ?? ""} ・ {r.details.processing ?? ""}
        {r.details.listUrl ? <a href={r.details.listUrl} target="_blank" rel="noopener noreferrer" className="ml-2 font-bold text-brand underline">一休の返信画面 ↗</a> : null}
      </p> : null}
      {r.details?.ownerReply ? <div className="rounded border border-line p-3">
        <p className="font-bold">お店からの返信 <span className="text-faint">{r.details.ownerReply.date}</span></p>
        <p className="mt-1 text-[10px] text-faint">{r.details.ownerReply.status}</p>
        <p className="mt-2 whitespace-pre-wrap">{r.details.ownerReply.text}</p>
      </div> : null}
    </div>
  </details>;
}

export default function ReviewsTable({ reviews, sources }: { reviews: DashboardData["reviews"]; sources: SourceMeta[] }) {
  const [requestedPage, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(reviews.length / 20));
  const page = Math.min(requestedPage, pages - 1);
  const srcMap = new Map(sources.map(s => [s.id, s]));
  return <>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left">
        <thead><tr className="border-b border-line">
          {["更新日・訪問月", "サイト", "個別評価", "口コミ内容"].map(h => <th key={h} className="px-4 py-2.5 text-[10px] font-bold text-faint">{h}</th>)}
        </tr></thead>
        <tbody>{reviews.slice(page * 20, (page + 1) * 20).map(r => <tr key={r.id} className="border-b border-line align-top last:border-b-0">
          <td className="px-4 py-3 text-[11px] whitespace-nowrap text-faint">{r.date ?? "更新日未掲載"}{r.visit_month ? <span className="mt-1 block">{r.visit_month} 訪問</span> : null}</td>
          <td className="px-4 py-3 text-[11px] font-bold whitespace-nowrap">{srcMap.get(r.source)?.name ?? r.source}</td>
          <td className="px-4 py-3 text-[11px] whitespace-nowrap">{r.details?.scores && r.details.scores.length > 1 ? r.details.scores.map((s,i) => <p key={i}>{s.label} <Score rating={s.value} /></p>) : <Score rating={r.rating} />}</td>
          <td className="cell-wrap px-4 py-3"><ReviewBody review={r} /></td>
        </tr>)}
        {!reviews.length ? <tr><td colSpan={4} className="cell-wrap px-4 py-6 text-center text-[12px] text-faint">口コミはありません</td></tr> : null}</tbody>
      </table>
    </div>
    {reviews.length ? <nav aria-label="口コミのページ" className="flex items-center justify-end gap-3 border-t border-line px-4 py-3 text-[12px]">
      <span>{page * 20 + 1}〜{Math.min((page + 1) * 20, reviews.length)} / {reviews.length}投稿</span>
      <button disabled={!page} onClick={() => setPage(page - 1)} className="rounded border border-line px-3 py-1 disabled:opacity-40">前へ</button>
      <button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className="rounded border border-line px-3 py-1 disabled:opacity-40">次へ</button>
    </nav> : null}
  </>;
}
