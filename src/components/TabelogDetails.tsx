import type { DeviceKey, Details, RankingEntry } from "../types";

type Available = Exclude<Details, { unavailable: true }>;

export const DEVICE_LABEL: Record<DeviceKey, string> = { app: "アプリ", pc: "PC", sp: "スマホ" };
const DEVICES: DeviceKey[] = ["app", "pc", "sp"];

const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("ja-JP"));
const monthLabel = (month: string) => `${month.slice(0, 4)}年${Number(month.slice(5))}月`;

function Panel({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-line bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3.5">
        <h2 className="text-[13px] font-bold tracking-tight">{title}</h2>
        {badge ? (
          <span className="ml-auto rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-faint">{badge}</span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-4 py-2.5 text-[10px] font-bold tracking-wide whitespace-nowrap text-faint ${right ? "text-right" : ""}`}>
      {children}
    </th>
  );
}

function Mom({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-faint">—</span>;
  const cls = pct > 0 ? "text-ok" : pct < 0 ? "text-danger" : "text-faint";
  return <span className={`font-bold ${cls}`}>{pct > 0 ? `+${pct}` : pct}%</span>;
}

function Ranking({ ranking }: { ranking: Available["ranking"] }) {
  if (!ranking) {
    return (
      <Panel title="エリア内アクセスランキング">
        <p className="px-5 py-8 text-center text-[12px] font-semibold text-faint">次回のGrok Botの取り込み後に表示されます</p>
      </Panel>
    );
  }
  const { self } = ranking;
  const row = (e: RankingEntry) => {
    const mine = self?.rank === e.rank;
    return (
      <tr key={e.rank} className={`border-b border-line last:border-b-0 ${mine ? "bg-brand-soft" : ""}`}>
        <td className={`px-4 py-2 text-[11px] font-bold whitespace-nowrap ${mine ? "text-brand" : "text-subtle"}`}>{e.rank}位</td>
        <td className={`max-w-[180px] truncate px-4 py-2 text-[12px] ${mine ? "font-bold text-brand" : "font-semibold"}`}>
          {e.name}
          {mine ? <span className="ml-1.5 text-[9px] font-bold">（自店）</span> : null}
        </td>
        <td className="px-4 py-2 text-right text-[12px] font-bold whitespace-nowrap">{num(e.pv)}</td>
        <td className="px-4 py-2 text-right text-[11px] whitespace-nowrap">
          <Mom pct={e.momPct} />
        </td>
      </tr>
    );
  };
  const badge = [ranking.area, ranking.updatedAt ? `更新 ${ranking.updatedAt}` : null].filter(Boolean).join(" · ");
  return (
    <Panel title="エリア内アクセスランキング" badge={badge}>
      <div className="max-h-[400px] overflow-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line">
              <Th>順位</Th>
              <Th>店名</Th>
              <Th right>アクセス数（PV）</Th>
              <Th right>前月比</Th>
            </tr>
          </thead>
          <tbody>
            {ranking.entries.map(row)}
          </tbody>
        </table>
      </div>
      {self ? (
        <p className="border-t border-line px-5 py-2.5 text-[11px] font-semibold text-subtle">
          {ranking.area ? `${ranking.area}エリアで` : ""}自店は <span className="font-bold text-brand">{self.rank}位</span>
        </p>
      ) : (
        <p className="border-t border-line px-5 py-2.5 text-[11px] font-semibold text-faint">
          自店の順位はまだ取得できていません
        </p>
      )}
    </Panel>
  );
}

function TopPages({ topPages }: { topPages: Available["topPages"] }) {
  if (!topPages) {
    return (
      <Panel title="よく見られているページ">
        <p className="px-5 py-8 text-center text-[12px] font-semibold text-faint">次回のGrok Botの取り込み後に表示されます</p>
      </Panel>
    );
  }
  return (
    <Panel title="よく見られているページ" badge={monthLabel(topPages.month)}>
      <div className="grid gap-5 p-5 md:grid-cols-3">
        {DEVICES.map((key) => {
          const d = topPages.devices[key];
          const max = Math.max(1, ...(d.pages ?? []).map((p) => p.pv));
          return (
            <div key={key} className="min-w-0">
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-[12px] font-bold">{DEVICE_LABEL[key]}</span>
                <span className="text-[10px] font-bold text-faint">計 {num(d.total)} PV</span>
              </div>
              {d.pages?.length ? (
                <ol className="flex flex-col gap-1.5">
                  {d.pages.map((p) => (
                    <li key={p.name}>
                      <div className="flex items-baseline justify-between gap-2 text-[11px]">
                        <span className="truncate font-semibold text-subtle">{p.name}</span>
                        <span className="font-bold whitespace-nowrap">{num(p.pv)}</span>
                      </div>
                      <div className="mt-0.5 h-1 rounded bg-surface">
                        <div className="h-1 rounded bg-brand" style={{ width: `${(p.pv / max) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-[11px] font-semibold text-faint">データなし</p>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function Monthly({ monthly }: { monthly: Available["monthly"] }) {
  if (!monthly.length) {
    return (
      <Panel title="月別レポート">
        <p className="px-5 py-8 text-center text-[12px] font-semibold text-faint">次回のGrok Botの取り込み後に表示されます</p>
      </Panel>
    );
  }
  const share = (part: number | null, total: number | null) =>
    part != null && total ? `${Math.round((part / total) * 100)}%` : "";
  return (
    <Panel title="月別レポート（アクセス数・来店指標）" badge={`${monthly.length}か月分`}>
      <div className="max-h-[480px] overflow-auto">
        <table className="w-full min-w-[640px] text-left">
          <thead>
            <tr className="border-b border-line">
              <Th>月</Th>
              <Th right>PV合計</Th>
              {DEVICES.map((key) => (
                <Th key={key} right>
                  {DEVICE_LABEL[key]}
                </Th>
              ))}
              <Th right>ネット予約組数</Th>
              <Th right>電話 通話成立数</Th>
              <Th right>地図印刷PV</Th>
              <Th right>端末内訳との差</Th>
            </tr>
          </thead>
          <tbody>
            {monthly.map((m) => (
              <tr key={m.month} className="border-b border-line last:border-b-0 hover:bg-surface">
                <td className="px-4 py-2 text-[11px] font-bold whitespace-nowrap text-subtle">{monthLabel(m.month)}</td>
                <td className="px-4 py-2 text-right text-[12px] font-bold">{num(m.pv)}</td>
                {DEVICES.map((key) => (
                  <td key={key} className="px-4 py-2 text-right text-[11px] font-semibold whitespace-nowrap">
                    {num(m[key])}
                    <span className="ml-1 text-[9px] font-bold text-faint">{share(m[key], m.pv)}</span>
                  </td>
                ))}
                <td className="px-4 py-2 text-right text-[12px] font-bold text-ok">{num(m.reservations)}</td>
                <td className="px-4 py-2 text-right text-[12px] font-bold">{num(m.calls)}</td>
                <td className="px-4 py-2 text-right text-[12px] font-bold">{num(m.mapPrints)}</td>
                <td className="px-4 py-2 text-right text-[12px] font-bold">{num(m.unclassified ?? ([m.pv,m.pc,m.sp,m.app].every(n=>n!=null) ? 0 : null))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-5 py-2.5 text-[10px] font-semibold text-faint">
        電話 通話成立数は、食べログ予約専用番号への電話のうち通話が成立した数です（予約が成立した数ではありません）。
        総合PVとPC・スマホ・アプリの合計に差がある月は、管理画面の表示値を保持し、計算上の差を別列に表示します。差の端末種別は管理画面に掲載されていません。
      </p>
    </Panel>
  );
}

export default function TabelogDetails({ details }: { details: Details }) {
  if (details.unavailable) {
    return (
      <section className="rounded-md border border-line bg-warn-soft px-5 py-4 text-[12px] font-semibold text-warn">
        食べログの詳細分析（エリア内ランキング・よく見られているページ・月別レポート）を表示するには、データベースに表を追加する必要があります（supabase/migrations/003_create_source_reports.sql）。
      </section>
    );
  }
  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        <Ranking ranking={details.ranking} />
        <TopPages topPages={details.topPages} />
      </div>
      <Monthly monthly={details.monthly} />
      {details.ownerReviews ? <Panel title="管理画面の口コミ取得結果">
        <p className="p-5 text-[12px] leading-relaxed">掲載 {details.ownerReviews.groups}件 ／ 再訪問分を含む {details.ownerReviews.entries}投稿（全文 {details.ownerReviews.fullText}投稿・抜粋 {details.ownerReviews.excerpts}投稿・点数のみ {details.ownerReviews.scoreOnly ?? 0}投稿）。個別点数・本文・店舗返信は下の口コミ一覧から確認できます。</p>
      </Panel> : null}
      {details.pageHistory ? <Panel title="全期間のページ別アクセス" badge={`${monthLabel(details.pageHistory.first.slice(0,4)+'-'+details.pageHistory.first.slice(4))}〜${monthLabel(details.pageHistory.last.slice(0,4)+'-'+details.pageHistory.last.slice(4))}`}>
        <div className="grid gap-5 p-5 md:grid-cols-3">{DEVICES.map(key => <div key={key}>
          <h3 className="mb-2 text-[12px] font-bold">{DEVICE_LABEL[key]}</h3>
          {details.pageHistory!.devices[key].map(p => <p key={p.name} className="flex justify-between gap-3 py-1 text-[11px]"><span>{p.name}</span><span className="font-bold">{num(p.pv)} PV</span></p>)}
        </div>)}</div>
      </Panel> : null}
    </>
  );
}
