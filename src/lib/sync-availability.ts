export type SourceCred = { id: string; name: string; hasCredential: boolean };

export type HeaderSync =
  | { enabled: false; reason: string }
  | { enabled: true; mode: "tabelog" }
  | { enabled: true; mode: "ikyu" }
  | { enabled: true; mode: "unconnected"; name: string; hasCredential: boolean };

const CONNECTED = new Set(["all", "tabelog"]);

export function headerSync(signedIn: boolean, filter: string, sources: SourceCred[]): HeaderSync {
  if (!signedIn) return { enabled: false, reason: "アプリにログインしてください" };
  if (CONNECTED.has(filter)) {
    const ready = sources.some((s) => s.id === "tabelog" && s.hasCredential);
    return ready
      ? { enabled: true, mode: "tabelog" }
      : { enabled: false, reason: "食べログのアカウントを登録してください" };
  }
  if (filter === "ikyu") {
    const ready = sources.some((s) => s.id === "ikyu" && s.hasCredential);
    return ready
      ? { enabled: true, mode: "ikyu" }
      : { enabled: false, reason: "一休.comレストランのアカウントを登録してください" };
  }
  const site = sources.find((s) => s.id === filter);
  return {
    enabled: true,
    mode: "unconnected",
    name: site?.name ?? "このサイト",
    hasCredential: !!site?.hasCredential,
  };
}

export function unconnectedSyncMessage(name: string, hasCredential: boolean) {
  return hasCredential
    ? `${name}のアカウントは保存済みです。自動取得はまだ接続していないため、同期は開始していません。`
    : `${name}のアカウントを登録してください。`;
}
