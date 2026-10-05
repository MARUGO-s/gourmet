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

## 別のGoogleアカウントの連携（2026-10-05）

- ログイン中に上部の「Google連携」→「Googleアカウントを連携する」で、別のメールアドレスのGoogleアカウントを今のアカウントへ連携する（`supabase.auth.linkIdentity`）。連携後はそのGoogleの「Googleで続ける」でも同じアカウント（同じUID・同じ店舗とデータ）に入る。RLS・所有者の判定は変えない。
- Supabase の Authentication で「Allow manual linking」（手動連携）を有効にしておく必要がある。無効なら「連携が有効になっていません」と表示する。
- 連携するGoogleで先にログインして別アカウントができていると連携できない（`identity_already_exists`）。そのアカウントにデータが無いことを確かめてから管理者が削除し、連携し直す。
