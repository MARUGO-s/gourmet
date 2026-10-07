import type { CredentialRow, SourceMeta, Store } from "../types";
import { filterByStore, keysForStore } from "../../supabase/functions/_shared/stores.js";

export function scopedSourceRegistration(sources: SourceMeta[], credentials: CredentialRow[], stores: Store[], storeId: string) {
  const keys = storeId === "all" ? null : keysForStore(storeId, stores.flatMap(s => s.sites));
  const rows = filterByStore(credentials, keys);
  return sources.map(s => ({ ...s, hasCredential: rows.some(r => r.source === s.id) }));
}
