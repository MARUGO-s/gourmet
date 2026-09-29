import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createRequest, getCredentials, getDashboard, getRequests, getSources } from "./api";
import type { AgentRequest, AgentRequestAction, CredentialRow, DashboardData, SourceMeta } from "./types";
import { supabase } from "./lib/supabase";
import { hasOpenRequests } from "./lib/agent-requests";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import KpiRow from "./components/KpiRow";
import TrafficChart from "./components/TrafficChart";
import ReviewsTable from "./components/ReviewsTable";
import CredentialsPanel from "./components/CredentialsPanel";
import TabelogDetails from "./components/TabelogDetails";
import IngestPanel from "./components/IngestPanel";
import RequestsPanel from "./components/RequestsPanel";
import SchedulesPanel from "./components/SchedulesPanel";
// 一休の詳細分析は選択時だけ読み込む（初期バンドルを小さく保つ）
const IkyuDetails = lazy(() => import("./components/IkyuDetails"));

type View = "dashboard" | "requests" | "schedules" | "accounts";
const VIEW_TITLES: Record<View, [string, string | null]> = {
  dashboard: ["ダッシュボード", null], requests: ["取得依頼", "Grok Botへの取得依頼と履歴"], schedules: ["自動取得の設定", "店舗×サイトごとの自動取得の周期（日本時間）"], accounts: ["アカウント管理", "口コミサイトのアカウント（店舗×サイト）"],
};

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [sources, setSources] = useState<SourceMeta[]>([]);
  const [filter, setFilter] = useState<"all" | string>("all");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [requests, setRequests] = useState<AgentRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const currentUser = useRef(userId);
  currentUser.current = userId;
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const openIds = useRef<Set<string>>(new Set());

  const refreshAll = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => { if (alive) setUserId(data.session?.user.id ?? null); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setUserId(session?.user.id ?? null));
    return () => { alive = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    setData(null);
    setSources([]);
    setCredentials([]);
    setRequests([]);
    setNotice(null);
    openIds.current = new Set();
  }, [userId]);

  useEffect(() => {
    let alive = true;
    getSources().then((rows) => { if (alive) setSources(rows); }).catch(() => { if (alive) setSources([]); });
    if (userId) getCredentials().then((rows) => { if (alive) setCredentials(rows); }).catch(() => { if (alive) setCredentials([]); });
    return () => { alive = false; };
  }, [refreshKey, userId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getDashboard(filter)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setNotice({ text: e instanceof Error ? e.message : "データの取得に失敗しました", error: true }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [filter, refreshKey, userId]);

  // 取得依頼: 処理待ちがある間は30秒ごとに確認し、完了したらダッシュボードを読み直す
  const loadRequests = useCallback(async () => {
    if (!currentUser.current) return;
    const user = currentUser.current;
    setRequestsLoading(true);
    try {
      const { requests: rows } = await getRequests();
      if (currentUser.current !== user) return;
      const finished = rows.some((r) => openIds.current.has(r.id) && r.status === "done");
      openIds.current = new Set(rows.filter((r) => r.status === "queued" || r.status === "claimed").map((r) => r.id));
      setRequests(rows);
      if (finished) refreshAll();
    } catch (e) {
      if (currentUser.current === user) setNotice({ text: e instanceof Error ? e.message : "取得依頼を読み込めませんでした", error: true });
    } finally {
      if (currentUser.current === user) setRequestsLoading(false);
    }
  }, [refreshAll]);

  useEffect(() => { if (userId) void loadRequests(); }, [userId, loadRequests]);
  const pending = hasOpenRequests(requests);
  useEffect(() => {
    if (!userId || !pending) return;
    const timer = setInterval(() => void loadRequests(), 30_000);
    return () => clearInterval(timer);
  }, [userId, pending, loadRequests]);

  const onRequest = useCallback(async (source: string, storeId: string, action: AgentRequestAction = "sync_now", params?: { fromMonth?: string; note?: string }) => {
    if (!userId) return;
    const key = `${source}/${storeId}`;
    setBusyKey(key);
    setNotice(null);
    try {
      await createRequest({ source, storeId, action, ...(params ? { params } : {}) });
      if (currentUser.current === userId) setNotice({ text: "Grok Botへ依頼しました。約5分ごとに確認され、取得が始まると「取得中」になります", error: false });
    } catch (e) {
      if (currentUser.current === userId) setNotice({ text: e instanceof Error ? e.message : "依頼を登録できませんでした", error: true });
    } finally {
      if (currentUser.current === userId) setBusyKey(null);
      void loadRequests();
    }
  }, [userId, loadRequests]);

  const filteredSrc = filter === "all" ? "すべてのサイト" : (sources.find((s) => s.id === filter)?.name ?? "");
  const [title, subtitle] = VIEW_TITLES[view];
  const openCount = requests.filter((r) => r.status === "queued" || r.status === "claimed").length;

  return (
    <div className="flex min-h-screen">
      <Sidebar view={view} onView={setView} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={title}
          subtitle={subtitle ?? filteredSrc}
          lastSync={data?.lastSync ?? null}
          demo={data?.demo ?? false}
          signedIn={!!userId}
          openRequests={openCount}
          onRequests={() => setView("requests")}
        />

        {notice ? (
          <div
            className={`flex items-center gap-2 border-b px-6 py-2.5 text-[11px] font-bold ${
              notice.error
                ? "border-line bg-danger-soft text-danger"
                : "border-line bg-ok-soft text-ok"
            }`}
          >
            {notice.error ? "⚠" : "✓"} {notice.text}
          </div>
        ) : null}

        <main className="flex flex-1 flex-col gap-5 px-6 py-6">
          {view === "dashboard" ? (
            <>
              <nav className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => setFilter("all")}
                  className={`rounded-md border px-3 py-1.5 text-[12px] font-bold transition ${
                    filter === "all"
                      ? "border-brand bg-brand-soft text-brand"
                      : "border-line bg-card text-subtle hover:text-ink"
                  }`}
                >
                  すべて
                </button>
                {sources.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setFilter(s.id)}
                    title={s.hasCredential ? "" : "アカウント未登録"}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-bold transition ${
                      filter === s.id
                        ? "border-brand bg-brand-soft text-brand"
                        : "border-line bg-card text-subtle hover:text-ink"
                    }`}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                    {s.name}
                    {!s.hasCredential ? (
                      <span className="text-[9px] font-bold text-faint">未登録</span>
                    ) : null}
                  </button>
                ))}
              </nav>

              <IngestPanel filter={filter} signedIn={!!userId} sources={sources} credentials={credentials} requests={requests} busyKey={busyKey}
                onRequest={(source, storeId) => void onRequest(source, storeId)} onRequests={() => setView("requests")} onAccounts={() => setView("accounts")} />

              {loading ? (
                <div className="rounded-md border border-line bg-card px-6 py-12 text-center text-[12px] font-semibold text-faint">
                  読み込み中…
                </div>
              ) : data ? (
                <>
                  <KpiRow kpis={data.kpis} />
                  <section className="rounded-md border border-line bg-card p-5">
                    <header className="mb-3 flex items-center gap-2">
                      <h2 className="text-[13px] font-bold tracking-tight">
                        ページビューの推移（日別）
                      </h2>
                      <span className="ml-auto rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-faint">
                        {data.series.length} 日分
                      </span>
                    </header>
                    <TrafficChart
                      series={data.series}
                      deviceDaily={data.details && !data.details.unavailable ? data.details.deviceDaily : undefined}
                    />
                  </section>
                  {data.details ? <TabelogDetails details={data.details} /> : null}
                  {filter === "ikyu" && data.ikyu ? <Suspense fallback={<div className="rounded-md border border-line bg-card px-6 py-8 text-center text-[12px] font-semibold text-faint">読み込み中…</div>}><IkyuDetails ikyu={data.ikyu} reviews={data.reviews} /></Suspense> : null}
                  <section className="rounded-md border border-line bg-card">
                    <header className="flex items-center gap-2 border-b border-line px-5 py-3.5">
                      <h2 className="text-[13px] font-bold tracking-tight">取得済みの口コミ</h2>
                      <span className="ml-auto rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-faint">
                        {data.reviews.length} 件
                      </span>
                    </header>
                    <ReviewsTable reviews={data.reviews} sources={sources} />
                  </section>
                </>
              ) : (
                <div className="rounded-md border border-line bg-card px-6 py-12 text-center text-[12px] font-semibold text-faint">
                  データがありません
                </div>
              )}
            </>
          ) : view === "requests" ? (
            userId ? (
              <RequestsPanel sources={sources} credentials={credentials} requests={requests} loading={requestsLoading} busyKey={busyKey}
                onRequest={(source, storeId, action, params) => void onRequest(source, storeId, action, params)} onRefresh={() => void loadRequests()} />
            ) : (
              <div className="rounded-md border border-line bg-card px-6 py-12 text-center text-[12px] font-semibold text-faint">右上の「ログイン」から開始してください</div>
            )
          ) : view === "schedules" ? (
            userId ? (
              <SchedulesPanel key={userId} sources={sources} credentials={credentials} />
            ) : (
              <div className="rounded-md border border-line bg-card px-6 py-12 text-center text-[12px] font-semibold text-faint">右上の「ログイン」から開始してください</div>
            )
          ) : (
            <CredentialsPanel key={userId ?? "guest"} sources={sources} onChanged={refreshAll} />
          )}
        </main>
      </div>
    </div>
  );
}
