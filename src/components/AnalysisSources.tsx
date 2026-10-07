import type { SourceMeta } from "../types";
import SourceRegistrationBadge, { type RegistrationState } from "./SourceRegistrationBadge";

export default function AnalysisSources({ sources, state, selected, onChange }: {
  sources: SourceMeta[]; state: RegistrationState; selected: string[] | null; onChange: (value: string[] | null) => void;
}) {
  const all = selected === null;
  const count = sources.filter(s => s.hasCredential).length;
  const summary = all ? "全サイト（取り込み済みデータのみ）" : sources.filter(s => selected.includes(s.id)).map(s => s.name).join("・");
  return <div className="no-print rounded-md border border-line bg-card px-5 py-3.5">
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="text-[12px] font-bold">分析するサイト</h2>
      <label className="ml-auto flex items-center gap-2 text-[11px] text-subtle">対象の選び方
        <select aria-label="分析サイトの選び方" value={all ? "all" : "specific"} onChange={e => onChange(e.target.value === "all" ? null : sources.filter(s => s.hasCredential).map(s => s.id))}
          className="rounded border border-line bg-card px-2 py-1.5 text-[12px] font-semibold focus:outline-brand">
          <option value="all">全サイトのデータを使う</option><option value="specific">サイトを指定する</option>
        </select>
      </label>
    </div>
    <fieldset className="mt-3 flex flex-wrap gap-2">
      <legend className="sr-only">分析対象サイトと登録状態</legend>
      {sources.map(s => {
        const active = all || selected.includes(s.id);
        const content = <><span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.color }} /><span>{s.name}</span><SourceRegistrationBadge registered={s.hasCredential} state={state} /></>;
        const cls = `inline-flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-[11px] font-semibold ${!all && active ? "border-brand/30 bg-brand-soft/50 text-ink" : "border-line text-subtle"}`;
        return all ? <span key={s.id} className={cls}>{content}</span> : <label key={s.id} className={`${cls} cursor-pointer`}>
          <input type="checkbox" aria-label={`${s.name}を分析対象にする`} checked={active} onChange={e => onChange(e.target.checked ? [...selected, s.id] : selected.filter(id => id !== s.id))} className="accent-brand" />{content}
        </label>;
      })}
    </fieldset>
    <p className={`mt-2.5 text-[11px] ${summary ? "text-subtle" : "text-danger"}`} aria-live="polite">分析対象：{summary || "サイトを1つ以上選択してください"}</p>
    <p className="mt-1 text-[10px] leading-relaxed text-faint">{state === "ready" ? `取得用アカウント：${count}サイト登録済み。` : state === "loading" ? "取得用アカウントの登録状態を確認しています。" : "登録状態を確認できませんでした。画面を再読み込みしてください。"} 登録状態とデータの有無は別です。未登録でも取り込み済みデータがあれば使い、データがないサイトは分析できません。</p>
  </div>;
}
