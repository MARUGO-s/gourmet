import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getActiveSync, getDashboard, getSources, getSyncJob, syncNow } from "./api";
import type { DashboardData, SourceMeta, SyncJob } from "./types";
import { supabase } from "./lib/supabase";
import { getSyncState } from "./lib/sync-status";
import { headerSync, unconnectedSyncMessage } from "./lib/sync-availability";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import KpiRow from "./components/KpiRow";
import TrafficChart from "./components/TrafficChart";
import ReviewsTable from "./components/ReviewsTable";
import CredentialsPanel from "./components/CredentialsPanel";
import TabelogDetails from "./components/TabelogDetails";
import SyncPanel from "./components/SyncPanel";

type View = "dashboard" | "accounts";

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [sources, setSources] = useState<SourceMeta[]>([]);
  const [filter, setFilter] = useState<"all" | string>("all");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<SyncJob | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const currentUser = useRef(userId);
  currentUser.current = userId;
  const syncState = getSyncState(job, starting);
  const syncing = syncState.busy;
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refreshAll = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => { if (alive) setUserId(data.session?.user.id ?? null); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setUserId(session?.user.id ?? null));
    return () => { alive = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    let alive = true;
    setJob(null);
    setData(null);
    setSources([]);
    setStarting(false);
    setNotice(null);
    if (userId) getActiveSync().then(({ job: active }) => { if (alive && active) setJob(active); }).catch(() => {});
    return () => { alive = false; };
  }, [userId]);

  useEffect(() => {
    let alive = true;
    getSources().then((rows) => { if (alive) setSources(rows); }).catch(() => { if (alive) setSources([]); });
    return () => { alive = false; };
  }, [refreshKey, userId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getDashboard(filter)
      .then((d) => {
        if (alive) {
          setData(d);
        }
      })
      .catch((e) => {
        if (alive) setNotice(e instanceof Error ? e.message : "データの取得に失敗しました");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [filter, refreshKey, userId]);

  useEffect(() => {
    if (!job?.id || !userId) return;
    const id = job.id;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await getSyncJob(id);
        if (!alive) return;
        setJob(next);
        setNotice(null);
        if (next.status !== "running") { refreshAll(); return; }
        timer = setTimeout(poll, next.step === "queued" ? 10000 : 3000);
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 401)) {
          setJob((current) => current ? { ...current, status: "error", message: e.message } : null);
          return;
        }
        setNotice("進捗を確認できません。接続を再確認しています。取得処理はサーバーで継続しています");
        timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [job?.id, userId, refreshAll]);

  const onSync = useCallback(async (source = filter) => {
    if (syncing || !userId) return;
    setStarting(true);
    setNotice(null);
    try {
      const next = await syncNow(source);
      if (currentUser.current === userId) setJob(next);
    } catch (e) {
      if (currentUser.current === userId) {
        setNotice(e instanceof Error ? e.message : "同期に失敗しました");
        // 開始応答だけが途切れた場合は、実行済みジョブの進捗へ復帰する。
        const active = await getActiveSync().catch(() => null);
        if (currentUser.current === userId && active?.job) setJob(active.job);
      }
    } finally {
      if (currentUser.current === userId) setStarting(false);
    }
  }, [filter, syncing, userId]);

  const filteredSrc = filter === "all" ? "すべてのサイト" : (sources.find((s) => s.id === filter)?.name ?? "");
  const hasNoticeError = notice != null;
  const header = headerSync(!!userId, filter, sources);
  const onHeaderSync = useCallback(() => {
    if (!header.enabled) return;
    if (header.mode === "unconnected") {
      setNotice(unconnectedSyncMessage(header.name, header.hasCredential));
      if (!header.hasCredential) setView("accounts");
      return;
    }
    void onSync(header.mode === "ikyu" ? "ikyu" : undefined);
  }, [header, onSync]);

  return (
    <div className="flex min-h-screen">
      <Sidebar view={view} onView={setView} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={view === "dashboard" ? "ダッシュボード" : "アカウント管理"}
          subtitle={view === "dashboard" ? filteredSrc : "口コミサイトのアカウント"}
          syncState={syncState}
          lastSync={data?.lastSync ?? null}
          demo={data?.demo ?? false}
          onSync={onHeaderSync}
          syncDisabled={!header.enabled}
          syncTitle={header.enabled ? undefined : header.reason}
        />

        {notice ? (
          <div
            className={`flex items-center gap-2 border-b px-6 py-2.5 text-[11px] font-bold ${
              hasNoticeError
                ? "border-line bg-danger-soft text-danger"
                : "border-line bg-ok-soft text-ok"
            }`}
          >
            {hasNoticeError ? "⚠" : "✓"} {notice}
          </div>
        ) : null}

        <main className="flex flex-1 flex-col gap-5 px-6 py-6">
          <SyncPanel job={job} signedIn={!!userId} sources={sources} syncState={syncState} filter={filter}
            onAccounts={() => setView("accounts")} onSync={() => void onSync(filter === "ikyu" ? "ikyu" : "tabelog")} />
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
          ) : (
            <CredentialsPanel key={userId ?? "guest"} sources={sources} onChanged={refreshAll} />
          )}
        </main>
      </div>
    </div>
  );
}
