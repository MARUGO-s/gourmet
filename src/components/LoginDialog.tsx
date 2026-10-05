import { useEffect, useRef, useState } from "react";
import { supabase, authRedirect, googleAuthEnabled } from "../lib/supabase";
import { googleIdentityEmails, googleLinkErrorMessage, googleLinkOptions, googleLoginOptions, readGoogleCallbackError } from "../lib/google-auth";

export default function LoginDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const linkDialog = useRef<HTMLDialogElement>(null);
  const [googleEmails, setGoogleEmails] = useState<string[] | null>(null);
  const [linkMessage, setLinkMessage] = useState("");
  const [mode, setMode] = useState<"login" | "signup" | "reset" | "password">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  useEffect(() => {
    const callbackError = readGoogleCallbackError(window.location.href);
    if (callbackError) window.history.replaceState(null, "", callbackError.cleanUrl);
    void supabase.auth.getSession().then(({ data }) => {
      setSignedInEmail(data.session?.user.email ?? null);
      if (!callbackError) return;
      // ログイン中ならGoogleの連携から戻ってきた失敗（すでに別のアカウントで使われている など）
      if (data.session) { setLinkMessage(callbackError.message); void openLink(); }
      else { setMessage(callbackError.message); if (!dialog.current?.open) dialog.current?.showModal(); }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSignedInEmail(session?.user.email ?? null);
      if (event === "PASSWORD_RECOVERY") { setMode("password"); dialog.current?.showModal(); }
    });
    return () => subscription.unsubscribe();
  }, []);
  const title = { login: "ログイン", signup: "新規登録", reset: "パスワード再設定", password: "新しいパスワード" }[mode];
  const googleLogin = async () => {
    if (busy || !googleAuthEnabled) return;
    setBusy(true); setMessage("");
    try {
      const { data, error } = await supabase.auth.signInWithOAuth(googleLoginOptions(authRedirect()));
      if (error || !data.url) throw new Error("oauth_start_failed");
      window.location.assign(data.url);
    } catch {
      setMessage("Googleログインを開始できませんでした。時間をおいてもう一度お試しください。");
      setBusy(false);
    }
  };
  // ログイン中のアカウントに別のGoogleアカウントを連携する（連携後はそのGoogleでもこのアカウントに入れる。データの持ち主は変わらない）
  async function openLink() {
    setGoogleEmails(null);
    if (!linkDialog.current?.open) linkDialog.current?.showModal();
    const { data, error } = await supabase.auth.getUserIdentities();
    setGoogleEmails(error ? [] : googleIdentityEmails(data?.identities ?? []));
  }
  const linkGoogle = async () => {
    if (busy || !googleAuthEnabled) return;
    setBusy(true); setLinkMessage("");
    try {
      const { data, error } = await supabase.auth.linkIdentity(googleLinkOptions(authRedirect()));
      if (error) throw error;
      if (!data.url) throw new Error("oauth_start_failed");
      window.location.assign(data.url);
    } catch (error) {
      setLinkMessage(googleLinkErrorMessage((error as { code?: string }).code));
      setBusy(false);
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        dialog.current?.close(); setPassword("");
      } else if (mode === "signup") {
        const { error, data } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: authRedirect() } });
        if (error) throw error;
        if (data.session) dialog.current?.close();
        else setMessage("確認メールを送信しました。メール内のリンクを開いて登録を完了してください。");
        setPassword("");
      } else if (mode === "reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: authRedirect() });
        if (error) throw error;
        setMessage("再設定用のメールをご確認ください。");
      } else {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        dialog.current?.close(); setPassword("");
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      setMessage(code === "invalid_credentials" ? "メールアドレスまたはパスワードを確認してください。"
        : code === "email_not_confirmed" ? "確認メールのリンクから登録を完了してください。"
        : code === "over_email_send_rate_limit" ? "メール送信が混み合っています。しばらく待ってからお試しください。"
        : "認証できませんでした。入力内容・メールの受信設定をご確認ください。解決しない場合は管理者へお問い合わせください。");
    } finally { setBusy(false); }
  };
  return <>
    {signedInEmail ? <div className="flex items-center gap-2"><span className="hidden max-w-[160px] truncate text-xs text-subtle md:inline">{signedInEmail}</span>{googleAuthEnabled && <button onClick={() => { setLinkMessage(""); void openLink(); }} className="rounded-md border border-line bg-card px-3.5 py-2 text-[12px] font-bold">Google連携</button>}<button onClick={() => void supabase.auth.signOut()} className="rounded-md border border-line bg-card px-3.5 py-2 text-[12px] font-bold">ログアウト</button></div> : <button onClick={() => { setMode("login"); setMessage(""); dialog.current?.showModal(); }} className="rounded-md border border-line bg-card px-3.5 py-2 text-[12px] font-bold">ログイン</button>}
    <dialog ref={dialog} className="m-auto w-[min(92vw,420px)] rounded-lg border border-line bg-card p-6 text-ink backdrop:bg-black/40">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex justify-between"><h2 className="font-bold">{title}</h2><button type="button" aria-label="閉じる" onClick={() => dialog.current?.close()}>×</button></div>
        <p className="text-xs leading-relaxed text-subtle">gourmet専用アカウントです。旧サービスのログインは引き継がれません。食べログのIDは、ログイン後の「アカウント設定」に登録します。</p>
        {googleAuthEnabled && (mode === "login" || mode === "signup") && <>
          <button type="button" disabled={busy} onClick={() => void googleLogin()} className="rounded border border-line bg-surface p-2 font-bold disabled:opacity-50">Googleで続ける</button>
          <p className="text-center text-xs text-subtle">またはメールアドレスで続ける</p>
        </>}
        {mode !== "password" && <label className="text-sm">メールアドレス<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface p-2" /></label>}
        {mode !== "reset" && <label className="text-sm">パスワード<input type="password" minLength={mode === "login" ? 1 : 8} maxLength={128} autoComplete={mode === "login" ? "current-password" : "new-password"} required value={password} onChange={e => setPassword(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface p-2" /><span className="text-xs text-faint">新規登録・再設定は8文字以上</span></label>}
        {message && <p role="status" className="text-sm leading-relaxed">{message}</p>}
        <button disabled={busy} className="rounded bg-brand p-2 font-bold text-white disabled:opacity-50">{busy ? "処理中…" : title}</button>
        <div className="flex flex-wrap gap-4 text-xs text-brand">{(["login", "signup", "reset"] as const).filter(m => m !== mode).map(m => <button key={m} type="button" onClick={() => { setMode(m); setMessage(""); }}>{ { login: "ログインに戻る", signup: "新規登録", reset: "パスワードを忘れた方" }[m]}</button>)}</div>
      </form>
    </dialog>
    <dialog ref={linkDialog} className="m-auto w-[min(92vw,420px)] rounded-lg border border-line bg-card p-6 text-ink backdrop:bg-black/40">
      <div className="flex flex-col gap-4">
        <div className="flex justify-between"><h2 className="font-bold">Googleアカウントの連携</h2><button type="button" aria-label="閉じる" onClick={() => linkDialog.current?.close()}>×</button></div>
        <p className="text-xs leading-relaxed text-subtle">連携したGoogleアカウントで「Googleで続ける」を押すと、このアカウント（{signedInEmail}）の店舗・データが表示されます。連携するGoogleアカウントで、別のアカウントを作っていないことが必要です。</p>
        <div className="text-sm">
          <p className="font-bold">連携済みのGoogleアカウント</p>
          {googleEmails == null ? <p className="text-subtle">読み込み中…</p>
            : googleEmails.length ? <ul className="mt-1 list-disc pl-5">{googleEmails.map(e => <li key={e}>{e}</li>)}</ul>
            : <p className="text-subtle">まだありません</p>}
        </div>
        {linkMessage && <p role="status" className="text-sm leading-relaxed">{linkMessage}</p>}
        <button type="button" disabled={busy} onClick={() => void linkGoogle()} className="rounded bg-brand p-2 font-bold text-white disabled:opacity-50">{busy ? "処理中…" : "Googleアカウントを連携する"}</button>
      </div>
    </dialog>
  </>;
}
