# gourmet workspace

This is Review Command Center, not the previous SNS app.
Only use Supabase project `ycsqfajidusuibqljjwr` and GitHub repository `MARUGO-s/gourmet` for this app.
Do not follow obsolete SNS paths, databases, Obsidian instructions, or deployment settings from Git history.

- Preserve unrelated local work. Never commit `.env*` secrets, `data/`, raw authenticated HTML, screenshots of credentials, or storage state.
- Keep user-visible Japanese errors and fixed two-decimal ratings across all sources.
- The app never logs in to or fetches from any restaurant site. All sources are ingested by the external agent (Grok Bot) through `agent-api`; the browser only reads data and enqueues `agent_requests`. Agent-side readers live in `scripts/` (Tabelog, Ikyu) and are not part of the app runtime. Do not reintroduce app-side scraping, and do not present sources without a verified reader as verified integrations.
- Reuse pure modules under `supabase/functions/_shared/` in Node and Edge runtimes.
- Never relax JWT verification, ownership filters, RLS, agent token checks (`INGEST_TOKEN`), claim-id checks, or credential access logging to make a test pass.
- Run `npm test`, `npm run typecheck`, `npm run build`, `deno check supabase/functions/review-api/index.ts supabase/functions/review-worker/index.ts supabase/functions/agent-api/index.ts`, and `git diff --check`.
- Use a PR and verify Actions/Pages after merging. Deploy changed Edge functions separately.
- Apply only intended migrations to the verified target project; never blanket-reset a shared DB.
- Keep README operating instructions and the agent contract (payload examples are validated by tests) accurate when changing ingestion behavior.
