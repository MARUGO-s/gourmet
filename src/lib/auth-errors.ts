// Only display fixed Japanese guidance, never raw provider messages or passwords.
export function authErrorMessage(error: unknown): string {
  const value = error && typeof error === "object" ? error as { code?: unknown; reasons?: unknown } : {};
  const reasons = Array.isArray(value.reasons) ? value.reasons : [];
  if (value.code === "weak_password") {
    if (reasons.includes("pwned")) return "このパスワードは流出したパスワードと一致するため使えません。ほかのサービスで使っていない、長くランダムなパスワードに変更してください。";
    if (reasons.includes("length")) return "パスワードが短すぎます。8文字以上の、ほかのサービスで使っていない長いパスワードに変更してください。";
    if (reasons.includes("characters")) return "パスワードに必要な種類の文字が足りません。英大文字・英小文字・数字・記号を組み合わせて変更してください。";
    return "パスワードが推測されやすいため使えません。8文字以上でも、よく使われる文字列は拒否されます。ほかのサービスで使っていない、長くランダムなパスワードに変更してください。";
  }
  switch (value.code) {
    case "invalid_credentials": return "メールアドレスまたはパスワードが違います。入力内容を確認してください。Googleで登録した方は「Googleで続ける」を選んでください。";
    case "email_not_confirmed": return "メールアドレスの確認がまだ完了していません。受信した確認メールのリンクを開いてから、ログインしてください。";
    case "user_already_exists":
    case "email_exists": return "このメールアドレスは登録済みです。「ログインに戻る」からログインしてください。パスワードが分からない場合は「パスワードを忘れた方」を選んでください。";
    case "over_email_send_rate_limit": return "短時間にメール送信が集中したため、送信できませんでした。しばらく待ってから、もう一度お試しください。";
    case "over_request_rate_limit": return "短時間に操作が集中したため、一時的に制限されています。しばらく待ってから、もう一度お試しください。";
    case "email_address_invalid": return "メールアドレスの形式が正しくありません。入力したメールアドレスを確認してください。";
    case "signup_disabled": return "現在、新規登録の受付が停止されています。管理者へお問い合わせください。";
    default: return "手続きを完了できませんでした。通信状態を確認し、時間をおいてもう一度お試しください。繰り返し表示される場合は管理者へお問い合わせください。";
  }
}
