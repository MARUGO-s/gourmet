export type SourceMeta = {
  id: string;
  name: string;
  nameEn: string;
  color: string;
  loginUrl: string;
  hasCredential: boolean;
  // 登録済みの店舗数（店舗×サイトの資格情報）と、Grok Bot による最終取り込み日時
  storeCount?: number;
  lastUpdatedAt?: string | null;
};

export type Snapshot = {
  source: string;
  date: string;
  rating: number | null;
  reviews: number | null;
  pv: number | null;
  visits: number | null;
  reservations: number | null;
};

export type Review = {
  id: string;
  source: string;
  rating: number | null;
  text: string;
  author: string;
  sentiment: "positive" | "neutral" | "negative";
  date: string | null;
  external_id?: string | null;
  title?: string;
  visit_month?: string | null;
  details?: {
    textComplete?: boolean;
    scores?: { label: string; value: number | null; breakdown: string | null }[];
    usedPrice?: string | null;
    ownerReply?: { text: string; date: string; status: string } | null;
    // 一休（外部取り込み）
    origin?: string;
    storeId?: string;
    storeName?: string | null;
    reservationNo?: string;
    visitDate?: string | null;
    visitTime?: string | null;
    postedAt?: string | null;
    publishedAt?: string | null;
    publication?: string | null;
    processing?: string | null;
    needsReply?: boolean;
    listUrl?: string;
  };
};

export type Kpi = { value: number | null; delta: number | null; asOf?: string | null };

export type DashboardData = {
  kpis: {
    rating: Kpi;
    reviews: Kpi;
    pv: Kpi;
    reservations: Kpi & { month: string | null };
  };
  series: { date: string; pv: number }[];
  reviews: Review[];
  lastSync: string | null;
  demo: boolean;
  details: Details | null;
  ikyu?: IkyuDetails | null;
  // 表示中の店舗（'all' / 店舗ID / 'unassigned'）
  store?: string;
};

export type IkyuPv = {
  guideSp: number | null; guidePc: number | null; guide: number | null;
  planSp: number | null; planPc: number | null; plan: number | null;
  otherSp: number | null; otherPc: number | null; other: number | null;
  sp: number | null; pc: number | null; pv: number | null;
  reservations: number | null; amount: number | null;
};
export type IkyuDay = IkyuPv & { storeId: string; date: string };
export type IkyuMonth = IkyuPv & { storeId: string; month: string; complete: boolean; days: number };
export type IkyuStore = {
  storeId: string; name: string | null; label: string | null; credentialUpdatedAt: string | null;
  reviewTotal: number | null; pageviewsUpdatedAt: string | null; reviewsUpdatedAt: string | null;
  publicRating: number | null; publicReviewCount: number | null; publicUpdatedAt: string | null;
};
export type IkyuRun = {
  runKey: string; agent: string; capturedAt: string | null; receivedAt: string; status: "ok" | "partial";
  stores: number; days: number; months: number; reviews: number; newReviews: number; message: string;
};
export type IkyuDetails =
  | { unavailable: true }
  | { unavailable?: undefined; demo?: boolean; stores: IkyuStore[]; months: IkyuMonth[]; daily: IkyuDay[]; runs: IkyuRun[] };

export type DeviceKey = "app" | "pc" | "sp";

export type RankingEntry = { rank: number; name: string; pv: number | null; momPct: number | null };

export type MonthlyMetrics = {
  month: string;
  reservations: number | null;
  calls: number | null;
  mapPrints: number | null;
  pv: number | null;
  pc: number | null;
  sp: number | null;
  app: number | null;
  unclassified?: number;
};

export type Details =
  | { unavailable: true }
  | {
      unavailable?: undefined;
      ranking: {
        area: string | null;
        updatedAt: string | null;
        shopName: string | null;
        total: number;
        self: RankingEntry | null;
        entries: RankingEntry[];
      } | null;
      topPages: {
        month: string;
        devices: Record<DeviceKey, { total: number | null; pages: { name: string; pv: number }[] | null }>;
      } | null;
      monthly: MonthlyMetrics[];
      ownerReviews?: { groups: number; entries: number; fullText: number; excerpts: number; scoreOnly?: number } | null;
      pageHistory?: { first: string; last: string; devices: Record<DeviceKey, { name: string; pv: number }[]> } | null;
      deviceDaily: Record<string, Record<DeviceKey, number | null> & { unclassified?: number }>;
    };

// ログインID・パスワードはブラウザへ返らない（登録済み・更新日時のみ）
export type CredentialRow = {
  id: string;
  source: string;
  label: string;
  storeKey: string;
  credentialsVersion: number;
  updatedAt: string;
  canDelete: boolean;
};

// アプリ → Grok Bot の取得依頼（agent_requests）
export type AgentRequestAction = "sync_now" | "fetch_metrics" | "fetch_reviews" | "backfill";
export type AgentRequestStatus = "queued" | "claimed" | "done" | "failed";
export type AgentRequest = {
  id: string;
  source: string;
  storeId: string;
  action: AgentRequestAction;
  params: { fromMonth?: string; toMonth?: string; note?: string };
  status: AgentRequestStatus;
  requestedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  claimedBy: string | null;
  attempts: number;
  result: Record<string, unknown> | null;
  error: string | null;
  // 失敗の種類（needs_relogin = ログイン情報の更新が必要 / needs_human_check = 「私は人間です」の確認を求められた / other）。失敗以外は null
  failureKind?: "needs_relogin" | "needs_human_check" | "other" | null;
};

// ログイン情報の保存後の取り直し（review-api が自動で依頼する）
export type RefetchResult = { status: "queued" | "already_open" | "not_supported" | "failed"; requestId?: string; mtalk: boolean; message: string };

// 自動取得の設定（fetch_schedules）。型は共通モジュールの宣言を使う
export type { PublicSchedule as FetchSchedule, ScheduleInput, ScheduleMode } from "../supabase/functions/_shared/fetch-schedules.js";
// 週報の配信予定（weekly_delivery_schedules）
export type { PublicWeeklySchedule as WeeklySchedule, WeeklyScheduleInput, WeeklyStatus } from "../supabase/functions/_shared/weekly-schedules.js";

// 店舗マスタ（stores / store_sites）と全店舗の比較。型は共通モジュールの宣言を使う
export type { PublicStore as Store, PublicStoreSite as StoreSite, Overview, OverviewRow, OverviewSite, OverviewTotals, StoreKeys } from "../supabase/functions/_shared/stores.js";

// AI分析（ai-analyst）
export type AiChatMessage = { role: "user" | "assistant"; content: string; at: string; storeName?: string; period?: { from: string; to: string }; calls?: { name: string; args: Record<string, unknown> }[]; error?: boolean };
export type AiStatus = { configured: boolean; model: string; limits: { askPerHour: number; reportsPerHour: number } };
export type AiAskResult = { answer: string; model: string; calls: { name: string; args: Record<string, unknown> }[]; period: { from: string; to: string }; store: string };
export type AiReportSummary = { id: string; title: string; storeId: string; storeName: string; from: string; to: string; model: string; createdAt: string };
export type AiReport = AiReportSummary & { markdown: string; content: Record<string, unknown> };
export type MtalkRecipient = { id: string; username: string; stores: string[] };
export type AiReportShare = { id: string; reportId: string | null; reportTitle: string; recipientId: string; recipientName: string; status: "pending" | "sent" | "failed"; error: string | null; createdAt: string; sentAt: string | null };

// 口コミ通知（新着口コミ・食べログ総合点の変化 → M-talk の店舗Bot が参加しているルーム）。型は共通モジュールの宣言を使う
export type { AlertBot, AlertBotMode, AlertSetting, AlertSettingInput, AlertDelivery, AlertEvent, StoreBot, StoreBotRoom } from "../supabase/functions/_shared/review-alerts.js";
export type ManagedUser = {
  id: string; email: string; createdAt: string; lastSignInAt: string | null;
  confirmed: boolean; isAdmin: boolean; grantedAt: string | null; storeCount: number;
  accessStatus: "pending" | "approved" | "revoked";
  storeIds: string[]; deletable: boolean;
};
export type ManagedUsers = { users: ManagedUser[]; total: number; page: number; stores: { id: string; name: string }[] };
export type MyAccess = { isAdmin: boolean; canView: boolean; status: "pending" | "approved" | "revoked"; revision: string };
