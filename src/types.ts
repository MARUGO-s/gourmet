export type SourceMeta = {
  id: string;
  name: string;
  nameEn: string;
  color: string;
  loginUrl: string;
  hasCredential: boolean;
};

export type Snapshot = {
  source: string;
  date: string;
  rating: number;
  reviews: number;
  pv: number;
  visits: number;
  reservations: number;
};

export type Review = {
  id: string;
  source: string;
  rating: number;
  text: string;
  author: string;
  sentiment: "positive" | "neutral" | "negative";
  date: string;
};

export type Kpi = { value: number; delta: number };

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
};

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
      deviceDaily: Record<string, Record<DeviceKey, number | null>>;
    };

export type CredentialRow = {
  id: string;
  source: string;
  label: string;
  username: string;
  updatedAt: string;
};

export type SyncResult = {
  ok: boolean;
  results: { source: string; status: string; message?: string; warning?: string }[];
};

export type SyncJob = {
  id: string;
  sources: string[];
  source?: string;
  status: "running" | "completed" | "error";
  step: string;
  message: string;
  startedAt: string;
  finishedAt: string | null;
  results: {
    source: string;
    status: "ok" | "error";
    step?: string;
    message?: string;
    warning?: string;
    summary?: { rating: number | null; reviews: number | null; dailyDays: number; monthlyMonths: number; latestPvDate: string | null };
  }[];
};
