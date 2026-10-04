# Googleログイン

- 接続先は既存gourmet `ycsqfajidusuibqljjwr`。所有者がGoogleプロバイダーを設定済み。
- Pagesビルドで `VITE_GOOGLE_AUTH_ENABLED=true` を指定。未指定環境では非表示。
- Callbackは `https://ycsqfajidusuibqljjwr.supabase.co/auth/v1/callback`、アプリへ戻るURLは `https://marugo-s.github.io/gourmet/`。
- 秘密鍵はSupabaseだけで保持。Client SecretをVite環境変数やGitへ保存しない。
- メール認証・パスワード再設定・PASSWORD_RECOVERY・既存データのUID所有者判定を維持。未ログイン時は従来のデモ。GoogleにGmailやDriveの権限は要求しない。
- 取消・認証エラーは固定の日本語メッセージ。認証失敗パラメーターだけをURLから除去し、成功時のAuth／recoveryパラメーターはSupabaseに処理させる。
- 既存利用者のUID・所有データ継続は本人の実Googleログイン後に確認する。別Googleメールを既存アカウントへ勝手に統合しない。

検証: 210 Nodeテスト中206成功・4つの既存任意fixtureテストはスキップ、型検査、ビルド、3 Edge FunctionのDeno型検査成功。DB・RLS・Functionsは変更していない。

Chromeのローカル画面でGoogleボタンとメール認証の併存、390px幅でのダイアログ収まり、取消時の日本語表示・エラーパラメーター除去を確認。ローカルからのデータ取得は失敗したため、業務データの動作確認としては扱わない。
