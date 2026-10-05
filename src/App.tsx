import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createRequest, getCredentials, getDashboard, getRequests, getSources, getStores } from "./api";
import type { AgentRequest, AgentRequestAction, CredentialRow, DashboardData, SourceMeta, Store } from "./types";
import { ALL_STORES, filterByStore, keysForStore } from "../supabase/functions/_shared/stores.js";
import { loadSelection, saveSelection } from "./lib/store-selection";
import StoreSelect from "./components/StoreSelect";
import StoreSwitcher from "./components/StoreSwitcher";
import StoreManager from "./components/StoreManager";
import OverviewPage from "./components/OverviewPage";
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
import AlertsPanel from "./components/AlertsPanel";
import { DEEP_LINK_PARAMS, parseDeepLink } from "../supabase/functions/_shared/login-help.js";
// 一休の詳細分析は選択時だけ読み込む（初期バンドルを小さく保つ）
const IkyuDetails = lazy(() => import("./components/IkyuDetails"));
// AI分析も選択時だけ読み込む
const AiAnalystPage = lazy(() => import("./components/AiAnalystPage"));

export type View = "overview" | "dashboard" | "ai" | "requests" | "schedules" | "alerts" | "accounts" | "stores";
const VIEW_TITLES: Record<View, [string, string | null]> = {
  overview: ["全店舗の比較", "店舗×サイトの月別PV・前月比・予約・評価・口コミ・未返信"], stores: ["店舗管理", "店舗の追加・並び替えと、各サイトの店舗ID"],
  dashboard: ["ダッシュボード", null], ai: ["AI分析", "AIによる質問への回答と分析レポート（OpenAI）"], requests: ["取得依頼", "Grok Botへの取得依頼と履歴"], schedules: ["自動取得の設定", "店舗×サイトごとの自動取得の周期と、店舗ごとの週報の配信（日本時間）"], alerts: ["口コミ通知", "新着口コミ・食べログ総合点の変化を M-talk の店舗Botからルームへ"], accounts: ["アカウント管理", "口コミサイトのアカウント（店舗×サイト）"],
};

// M-talk の「ログイン情報を更新」から開いたときの画面（?view=accounts&source=…&store=…&retry=…）。使い終わったら URL から消す
type DeepLink = ReturnType<typeof parseDeepLink>;
const initialDeepLink: DeepLink = typeof window === "undefined" ? null : parseDeepLink(window.location.search);
function clearDeepLinkFromUrl() {
  const u = new URL(window.location.href);
  for (const k of DEEP_LINK_PARAMS) u.searchParams.delete(k);
  window.history.replaceState(null, "", `${u.pathname}${u.search}${u.hash}`);
}

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [deepLink, setDeepLink] = useState<DeepLink>(initialDeepLink);
  const [credPreset, setCredPreset] = useState<{ source: string; storeKey: string; retry: string | null } | null>(null);
  // スマートフォン幅のメニュー（ドロワー）の開閉
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
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
  // 店舗の選択（表示の絞り込みのみ）。null = 未選択（ログイン後は店舗の選択画面を表示）
  const [stores, setStores] = useState<Store[]>([]);
  const [storesLoaded, setStoresLoaded] = useState(false);
  const [storesError, setStoresError] = useState<string | null>(null);
  const [storesKey, setStoresKey] = useState(0);
  const [scope, setScope] = useState<string | null>(null);
  const refreshStores = useCallback(() => setStoresKey((k) => k + 1), []);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

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
    setStores([]);
    setStoresLoaded(false);
    setScope(null);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setStoresError(null);
    getStores()
      .then(({ stores: rows }) => {
        if (!alive) return;
        setStores(rows);
        // 保存済みの選択を復元（削除された店舗なら選択画面へ）。「全店舗」を復元したときは全店舗の比較を開く
        const cur = scopeRef.current;
        if (cur === ALL_STORES || (cur && rows.some((s) => s.id === cur))) return;
        const restored = loadSelection(userId, rows);
        setScope(restored);
        if (!cur && restored === ALL_STORES) setView("overview");
      })
      .catch((e) => { if (alive) setStoresError(e instanceof Error ? e.message : "店舗を読み込めませんでした"); })
      .finally(() => { if (alive) setStoresLoaded(true); });
    return () => { alive = false; };
  }, [userId, storesKey]);

  const selectScope = useCallback((next: string) => {
    setScope(next);
    if (userId) saveSelection(userId, next);
    // 「全店舗」は全店舗の比較を開く。店舗へ切り替えたときは表示中の画面（取得依頼など）をそのまま絞り込む
    setView((v) => (next === ALL_STORES && v !== "ai" && v !== "alerts" ? "overview" : v === "overview" || v === "stores" ? "dashboard" : v));
  }, [userId]);
  const reselect = useCallback(() => {
    setScope(null);
    if (userId) saveSelection(userId, null);
  }, [userId]);
  // 「ログイン情報を更新」のリンク: ログインして店舗を読み込んだら、その店舗のアカウント管理を開く（未ログインならログイン後に）
  useEffect(() => {
    if (!userId || !storesLoaded || deepLink?.kind !== "credentials") return;
    const st = stores.find((s) => s.sites.some((x) => x.source === deepLink.source && x.siteStoreKey === deepLink.storeKey));
    selectScope(st?.id ?? ALL_STORES);
    setView("accounts");
    setCredPreset({ source: deepLink.source, storeKey: deepLink.storeKey, retry: deepLink.retry });
    setDeepLink(null);
  }, [userId, storesLoaded, stores, deepLink, selectScope]);
  const currentStore = stores.find((s) => s.id === scope);
  const scopeKeys = useMemo(() => (scope && scope !== ALL_STORES ? keysForStore(scope, stores.flatMap((s) => s.sites)) : null), [scope, stores]);
  const defaultStoreId = currentStore?.id ?? "";
  const scopedCredentials = useMemo(() => filterByStore(credentials, scopeKeys), [credentials, scopeKeys]);
  const scopedRequests = useMemo(() => filterByStore(requests, scopeKeys, (r) => r.storeId), [requests, scopeKeys]);

  useEffect(() => {
    let alive = true;
    getSources().then((rows) => { if (alive) setSources(rows); }).catch(() => { if (alive) setSources([]); });
    if (userId) getCredentials().then((rows) => { if (alive) setCredentials(rows); }).catch(() => { if (alive) setCredentials([]); });
    return () => { alive = false; };
  }, [refreshKey, userId]);

  // 店舗の割り当てを変えたら表示中の店舗のデータも変わるため、storesKey でも読み直す
  useEffect(() => {
    if (userId && !scope) return;
    let alive = true;
    setLoading(true);
    getDashboard(filter, userId ? scope ?? ALL_STORES : ALL_STORES)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404 && userId) { reselect(); refreshStores(); }
        setNotice({ text: e instanceof Error ? e.message : "データの取得に失敗しました", error: true });
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [filter, refreshKey, userId, scope, storesKey, reselect, refreshStores]);

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
  const choosing = !!userId && !scope && view !== "stores";
  const [baseTitle, subtitle] = choosing ? ["店舗の選択", "表示する店舗を選んでください"] as const : VIEW_TITLES[view];
  const scopeName = !userId ? null : scope === ALL_STORES ? "全店舗" : currentStore?.name ?? null;
  const title = scopeName && !choosing && view !== "overview" && view !== "stores" && view !== "ai" && view !== "alerts" ? `${scopeName} · ${baseTitle}` : baseTitle;
  const openCount = scopedRequests.filter((r) => r.status === "queued" || r.status === "claimed").length;
  const onView = (v: View) => {
    if (v === "overview") { selectScope(ALL_STORES); return; }
    setView(v);
  };
  const signInFirst = <div className="rounded-md border border-line bg-card px-6 py-12 text-center text-[12px] font-semibold text-faint">右上の「ログイン」から開始してください</div>;

  return (
    <div className="flex min-h-screen">
      <Sidebar view={choosing ? null : view} onView={onView} signedIn={!!userId} storeName={scopeName}
        mobileOpen={menuOpen} onClose={closeMenu} onReselect={userId && scope ? reselect : undefined} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={title}
          subtitle={subtitle ?? filteredSrc}
          lastSync={data?.lastSync ?? null}
          demo={data?.demo ?? false}
          signedIn={!!userId}
          openRequests={openCount}
          onRequests={() => setView("requests")}
          onMenu={() => setMenuOpen(true)}
          menuOpen={menuOpen}
          switcher={userId && scope ? <StoreSwitcher stores={stores} scope={scope} onChange={selectScope} onReselect={reselect} /> : null}
        />

        {notice ? (
          <div
            className={`no-print flex items-center gap-2 border-b px-6 py-2.5 text-[11px] font-bold ${
              notice.error
                ? "border-line bg-danger-soft text-danger"
                : "border-line bg-ok-soft text-ok"
            }`}
          >
            {notice.error ? "⚠" : "✓"} {notice.text}
          </div>
        ) : null}

        <main className="flex flex-1 flex-col gap-5 px-4 py-5 md:px-6 md:py-6">
          {!userId && deepLink?.kind === "credentials" ? (
            <p className="rounded-md border border-line bg-warn-soft px-4 py-2.5 text-[12px] font-bold text-warn">右上の「ログイン」からログインすると、ログイン情報の更新画面を開きます。</p>
          ) : null}
          {choosing ? (
            <StoreSelect stores={stores} sources={sources} loading={!storesLoaded} error={storesError} onSelect={selectScope} onManage={() => setView("stores")} onRetry={refreshStores} />
          ) : view === "overview" ? (
            userId ? <OverviewPage key={`${userId}/${storesKey}`} sources={sources} onSelectStore={selectScope} onManage={() => setView("stores")} /> : signInFirst
          ) : view === "ai" ? (
            userId ? (
              <Suspense fallback={<div className="rounded-md border border-line bg-card px-6 py-8 text-center text-[12px] font-semibold text-faint">読み込み中…</div>}>
                <AiAnalystPage key={userId} userId={userId} stores={stores} scope={scope ?? ALL_STORES} />
              </Suspense>
            ) : signInFirst
          ) : view === "stores" ? (
            userId ? <StoreManager stores={stores} sources={sources} onChanged={refreshStores} /> : signInFirst
          ) : view === "dashboard" ? (
            <>
              <nav className="flex flex-wrap items-center gap-1.5" aria-label="表示するグルメサイト">
                <button
                  onClick={() => setFilter("all")}
                  aria-pressed={filter === "all"}
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
                    aria-pressed={filter === s.id}
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

              <IngestPanel filter={filter} signedIn={!!userId} sources={sources} credentials={scopedCredentials} requests={scopedRequests} busyKey={busyKey} stores={stores}
                onFilter={setFilter}
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
                stores={stores} scopeKeys={scopeKeys} defaultStoreId={defaultStoreId} onStoresChanged={refreshStores}
                onRequest={(source, storeId, action, params) => void onRequest(source, storeId, action, params)} onRefresh={() => void loadRequests()}
                onRelogin={(source, storeKey, retry) => { setCredPreset({ source, storeKey, retry }); setView("accounts"); }} />
            ) : (
              <div className="rounded-md border border-line bg-card px-6 py-12 text-center text-[12px] font-semibold text-faint">右上の「ログイン」から開始してください</div>
            )
          ) : view === "alerts" ? (
            userId ? <AlertsPanel key={`${userId}/${storesKey}`} sources={sources} /> : (
              <div className="rounded-md border border-line bg-card px-6 py-12 text-center text-[12px] font-semibold text-faint">右上の「ログイン」から開始してください</div>
            )
          ) : view === "schedules" ? (
            userId ? (
              <SchedulesPanel key={`${userId}/${scope}`} sources={sources} credentials={credentials} stores={stores} scopeKeys={scopeKeys} defaultStoreId={defaultStoreId} onStoresChanged={refreshStores} scope={scope} />
            ) : (
              <div className="rounded-md border border-line bg-card px-6 py-12 text-center text-[12px] font-semibold text-faint">右上の「ログイン」から開始してください</div>
            )
          ) : (
            <CredentialsPanel key={`${userId ?? "guest"}/${scope}`} sources={sources} onChanged={() => { refreshAll(); void loadRequests(); }} stores={stores} scopeKeys={scopeKeys} defaultStoreId={defaultStoreId} onStoresChanged={refreshStores}
              preset={userId ? credPreset : null} onPresetDone={() => { setCredPreset(null); clearDeepLinkFromUrl(); }} />
          )}
        </main>
      </div>
    </div>
  );
}
