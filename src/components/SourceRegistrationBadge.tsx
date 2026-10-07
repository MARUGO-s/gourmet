export type RegistrationState = "loading" | "ready" | "error";

// 選択中（青）と登録状態（控えめな緑）を別の視覚表現にする。
export default function SourceRegistrationBadge({ registered, state = "ready" }: { registered: boolean; state?: RegistrationState }) {
  if (state !== "ready") return <span className="whitespace-nowrap text-[10px] font-medium text-faint">{state === "loading" ? "確認中…" : "確認できません"}</span>;
  return registered
    ? <span className="inline-flex items-center gap-0.5 whitespace-nowrap rounded bg-ok-soft px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"><span aria-hidden="true">✓</span> 登録済み</span>
    : <span className="whitespace-nowrap text-[10px] font-medium text-faint">未登録</span>;
}
