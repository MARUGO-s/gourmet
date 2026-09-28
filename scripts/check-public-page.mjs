// Public-only diagnostic. No account, cookies, raw HTML, or reviews in output.
import { chromium } from "playwright";
import { collectTabelogPublicData } from "../server/tabelog-public.js";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  const result = await collectTabelogPublicData(context, "https://tabelog.com/tokyo/A1309/A130903/13245351/");
  console.log(JSON.stringify({ rating: result.rating, reviews: result.reviews, diagnostics: result.diagnostics, issue: result.issue }));
  if (result.issue) process.exitCode = 1;
} finally { await browser.close(); }
