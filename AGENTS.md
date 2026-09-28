# gourmet workspace

This is Review Command Center, not the previous SNS app.
Only use Supabase project `ycsqfajidusuibqljjwr` and GitHub repository `MARUGO-s/gourmet` for this app.
Do not follow obsolete SNS paths, databases, Obsidian instructions, or deployment settings from Git history.

- Preserve unrelated local work. Never commit `.env*` secrets, `data/`, raw authenticated HTML, screenshots of credentials, or storage state.
- Keep user-visible Japanese errors and fixed two-decimal ratings across all sources.
- Only Tabelog is implemented for automated collection. Do not present placeholder sources as verified integrations.
- Reuse pure modules under `supabase/functions/_shared/` in Node and Edge runtimes.
- Never relax JWT verification, ownership filters, RLS, worker authentication, or lease checks to make a test pass.
- Run `npm test`, `npm run typecheck`, `npm run build`, `deno check supabase/functions/review-api/index.ts supabase/functions/review-worker/index.ts`, and `git diff --check`.
- Use a PR and verify Actions/Pages after merging. Deploy changed Edge functions separately.
- Apply only intended migrations to the verified target project; never blanket-reset a shared DB.
- Keep README operating instructions accurate when changing sync behavior.
