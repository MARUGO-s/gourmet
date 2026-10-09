// Isolated browser fixtures: no real login, account mutation, or Supabase traffic.
// Starts an isolated Vite test server: node scripts/test-user-management-ui.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const base = process.env.GOURMET_UI_TEST_URL || 'http://127.0.0.1:5178/gourmet/';
const server = process.env.GOURMET_UI_TEST_URL ? null : spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5178', '--strictPort'], { stdio: 'ignore' });
if (server) {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = (await fetch(base)).ok; } catch { /* wait for test server */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) { server.kill(); throw new Error('Test Vite server did not start'); }
}
const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const viewerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sources = [['tabelog', '食べログ', '#dc8500'], ['hotpepper', 'ホットペッパーグルメ', '#ef4088'], ['google', 'Google マップ', '#3980ee'], ['toreta', 'トレタ', '#13a6c0'], ['ikyu', '一休.comレストラン', '#8e793e'], ['retty', 'Retty', '#ec4242']].map(([id, name, color]) => ({ id, name, color, hasCredential: ['tabelog', 'ikyu'].includes(id) }));
const credentials = ['tabelog', 'ikyu'].map(source => ({ id: `fixture-${source}`, source, label: 'テスト店舗A', storeKey: source === 'ikyu' ? '112789' : '13245351', credentialsVersion: 1, canDelete: false }));
const stores = [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'テスト店舗A', sites: credentials.map(c => ({ id: c.id, storeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', source: c.source, siteStoreKey: c.storeKey })), sortOrder: 0 },
  { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'テスト店舗B', sites: [], sortOrder: 1 }];
const browser = await chromium.launch({ headless: true }).catch(e => { server?.kill(); throw e; });

async function fixture(mode, width = 1280, path = '') {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const isAdmin = mode === 'admin';
  const id = isAdmin ? adminId : viewerId;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, exp, role: 'authenticated' })).toString('base64url')}.fixture-signature`;
  if (mode !== 'auth') await context.addInitScript(({ id, token, exp, restoreAll }) => {
    localStorage.setItem('sb-ycsqfajidusuibqljjwr-auth-token', JSON.stringify({ access_token: token, refresh_token: 'fixture-only', token_type: 'bearer', expires_at: exp, expires_in: 3600, user: { id, email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-07T00:00:00Z' } }));
    if (restoreAll) localStorage.setItem(`gourmet.selectedStore.${id}`, 'all');
  }, { id, token, exp, restoreAll: path === '?view=users' });
  const calls = [], mutations = [], errors = [];
  const authReply = { code: 'weak_password', msg: 'Password is known to be weak and easy to guess, please choose a different one.' };
  let users = [{ id: adminId, email: 'admin@example.invalid', isAdmin: true, accessStatus: 'approved', confirmed: true, storeIds: [], storeCount: 2, deletable: false },
    { id: viewerId, email: 'viewer@example.invalid', isAdmin: false, accessStatus: 'pending', confirmed: true, storeIds: [], storeCount: 0, deletable: true }]
    .map(u => ({ ...u, createdAt: '2026-10-07T00:00:00Z', lastSignInAt: null, grantedAt: null }));
  await context.route('https://ycsqfajidusuibqljjwr.supabase.co/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/functions\/v1\/(review-api|ai-analyst)/, '');
    calls.push(path);
    if (req.method() === 'OPTIONS') {
      await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': req.headers()['access-control-request-headers'] || '*' } });
      return;
    }
    if (mode === 'auth' && (path === '/auth/v1/signup' || path === '/auth/v1/token')) {
      await route.fulfill({ status: 422, headers: { 'x-supabase-api-version': '2024-01-01', 'access-control-expose-headers': 'X-Supabase-Api-Version' }, contentType: 'application/json', body: JSON.stringify(authReply) });
      return;
    }
    let data;
    if (path === '/me') data = { isAdmin, canView: mode !== 'pending', status: mode === 'pending' ? 'pending' : 'approved', revision: mode };
    else if (path === '/sources') data = sources;
    else if (path === '/credentials') data = credentials;
    else if (path === '/status') data = { configured: true, model: 'fixture-model', limits: {} };
    else if (path === '/ask') { mutations.push({ path, input: req.postDataJSON() }); data = { answer: 'テスト回答です。', calls: [], period: { from: '2026-07-09', to: '2026-10-06' } }; }
    else if (path === '/reports' && req.method() === 'GET') data = { reports: [] };
    else if (path === '/reports' && req.method() === 'POST') {
      const input = req.postDataJSON(); mutations.push({ path, input });
      data = { report: { id: 'fixture-report', title: '対象サイト確認', storeId: input.storeId, storeName: 'テスト店舗A', from: input.from, to: input.to, model: 'fixture-model', createdAt: new Date().toISOString(), markdown: '# 対象サイト確認\n食べログのテストレポート', content: {} } };
    } else if (path === '/shares') data = { shares: [] };
    else if (path === '/requests') data = { requests: [] };
    else if (path === '/stores') data = { stores: isAdmin ? stores : stores.slice(0, 1) };
    else if (path === '/users') data = { users, total: users.length, stores, page: 1 };
    else if (path.startsWith('/users/') && req.method() === 'POST') {
      const input = req.postDataJSON();
      mutations.push({ path, input });
      users = users.flatMap(u => u.id !== input.userId ? [u] : path === '/users/delete' ? [] : [{ ...u,
        ...(path === '/users/access' ? { accessStatus: input.status, storeIds: input.storeIds } : { isAdmin: input.enabled }) }]);
      data = { ok: true };
    } else if (path === '/dashboard') data = { kpis: Object.fromEntries(['rating', 'reviews', 'pv', 'reservations'].map(k => [k, { value: null, delta: null, month: null }])), series: [], reviews: [], lastSync: null, demo: false, details: null };
    else { await route.abort(); return; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + path);
  return { page, context, calls, mutations, errors, authReply };
}

try {
  for (const width of [1280, 375]) {
    const f = await fixture('admin', width);
    await f.page.getByRole('heading', { name: '店舗の選択', exact: true }).waitFor();
    await f.page.getByRole('button').filter({ hasText: 'テスト店舗A' }).click();
    const registeredTab = f.page.getByRole('button', { name: /食べログ.*登録済み/ });
    await registeredTab.waitFor({ timeout: 10000 }).catch(async error => { console.error('Source fixture diagnostic:', { calls: f.calls, errors: f.errors, text: await f.page.locator('body').innerText() }); throw error; });
    assert.equal(await f.page.getByRole('button', { name: /一休.comレストラン.*登録済み/ }).count(), 1);
    assert.equal(await f.page.getByRole('button', { name: /Retty.*未登録/ }).count(), 1);
    if (process.env.GOURMET_UI_PROOF_DIR) { await mkdir(process.env.GOURMET_UI_PROOF_DIR, { recursive: true }); await f.page.screenshot({ path: join(process.env.GOURMET_UI_PROOF_DIR, `site-status-${width}.png`) }); }
    if (width === 375) await f.page.getByRole('button', { name: 'メニュー', exact: true }).click();
    await f.page.getByRole('button', { name: 'AI分析', exact: true }).click();
    await f.page.getByText('分析対象：全サイト（取り込み済みデータのみ）', { exact: true }).waitFor();
    await f.page.getByText(/取得用アカウント：2サイト登録済み/).waitFor();
    const mode = f.page.getByLabel('分析サイトの選び方');
    await mode.selectOption('specific');
    assert.equal(await f.page.getByLabel('食べログを分析対象にする', { exact: true }).isChecked(), true);
    await f.page.getByLabel('一休.comレストランを分析対象にする', { exact: true }).uncheck();
    await f.page.getByText('分析対象：食べログ', { exact: true }).waitFor();
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'AI source panel mobile overflow');
    if (process.env.GOURMET_UI_PROOF_DIR) await f.page.screenshot({ path: join(process.env.GOURMET_UI_PROOF_DIR, `analysis-sites-${width}.png`) });
    const question = f.page.getByPlaceholder(/例: 先月と比べてPV/);
    await question.fill('選択サイトのPVを教えて');
    await f.page.getByRole('button', { name: '送信', exact: true }).click();
    await f.page.getByText('テスト回答です。', { exact: true }).waitFor();
    assert.deepEqual(f.mutations.at(-1).input.sources, ['tabelog']);
    await f.page.getByRole('button', { name: 'レポート作成', exact: true }).click();
    await f.page.getByRole('button', { name: 'レポートを作成', exact: true }).click();
    await f.page.getByText(/レポートを作成して保存しました/).waitFor();
    assert.deepEqual(f.mutations.find(m => m.path === '/reports').input.sources, ['tabelog']);
    await f.page.getByRole('button', { name: '質問する', exact: true }).click();
    await f.page.getByLabel('食べログを分析対象にする', { exact: true }).uncheck();
    assert.equal(await f.page.getByRole('button', { name: '送信', exact: true }).isDisabled(), true);
    await f.page.getByText('分析対象：サイトを1つ以上選択してください', { exact: true }).waitFor();
    await mode.selectOption('all');
    assert.equal(await f.page.getByText('テスト回答です。', { exact: true }).count(), 0, 'different source scope must not share chat');
    await question.fill('全サイトのPVを教えて');
    await f.page.getByRole('button', { name: '送信', exact: true }).click();
    await f.page.getByText('テスト回答です。', { exact: true }).waitFor();
    assert.equal('sources' in f.mutations.at(-1).input, false);
    await f.page.getByLabel('分析する店舗', { exact: true }).selectOption(stores[1].id);
    await f.page.getByText(/取得用アカウント：0サイト登録済み/).waitFor();
    assert.deepEqual(f.errors, []);
    await f.context.close();
  }
  for (const width of [1280, 375]) {
    const auth = await fixture('auth', width);
    await auth.page.getByRole('button', { name: 'ログイン', exact: true }).click();
    const dialog = auth.page.getByRole('dialog');
    await dialog.getByRole('button', { name: '新規登録', exact: true }).click();
    await dialog.getByLabel('メールアドレス', { exact: true }).fill('signup-fixture@example.invalid');
    await dialog.getByLabel('パスワード', { exact: true }).fill('fixture-only-password');
    await dialog.getByRole('button', { name: '新規登録', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '8文字以上でも' }).waitFor({ timeout: 10000 }).catch(async error => {
      console.error('Auth fixture diagnostic:', { calls: auth.calls, errors: auth.errors, dialogText: await dialog.innerText() });
      throw error;
    });
    assert.match(await dialog.getByRole('alert').innerText(), /登録できませんでした/);
    assert.match(await dialog.getByRole('alert').innerText(), /推測されやすい/);
    assert.match(await dialog.getByRole('alert').innerText(), /変更してください/);
    assert.equal(await dialog.getByRole('button', { name: '新規登録', exact: true }).isEnabled(), true);
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'auth dialog overflow');
    if (process.env.GOURMET_UI_PROOF_DIR) {
      await mkdir(process.env.GOURMET_UI_PROOF_DIR, { recursive: true });
      await auth.page.screenshot({ path: join(process.env.GOURMET_UI_PROOF_DIR, `auth-error-${width}.png`) });
    }
    auth.authReply.code = 'email_not_confirmed';
    await dialog.getByRole('button', { name: 'ログインに戻る', exact: true }).click();
    await dialog.getByRole('button', { name: 'ログイン', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '確認メール' }).waitFor();
    assert.doesNotMatch(await dialog.getByRole('alert').innerText(), /推測されやすい/);
    assert.deepEqual(auth.errors, []);
    await auth.context.close();
  }
  const admin = await fixture('admin');
  await admin.page.getByRole('button', { name: 'ユーザー管理', exact: true }).click();
  await admin.page.getByText('登録ユーザー 2人').waitFor();
  let row = admin.page.getByRole('row').filter({ hasText: 'viewer@example.invalid' });
  await row.getByRole('button', { name: '承認・店舗設定' }).click();
  const save = admin.page.getByRole('button', { name: '承認して保存' });
  assert.equal(await save.isDisabled(), true);
  await admin.page.getByLabel('テスト店舗A', { exact: true }).check();
  await save.click();
  await admin.page.getByRole('status').filter({ hasText: '承認し、閲覧店舗を保存しました' }).waitFor();
  assert.deepEqual(admin.mutations.at(-1), { path: '/users/access', input: { userId: viewerId, status: 'approved', storeIds: [stores[0].id] } });
  await row.getByRole('button', { name: '閲覧停止', exact: true }).click();
  await admin.page.getByRole('button', { name: '確定する', exact: true }).click();
  await admin.page.getByRole('status').filter({ hasText: '閲覧を停止しました' }).waitFor();
  assert.equal(admin.mutations.at(-1).input.status, 'revoked');
  await row.getByRole('button', { name: '管理者に任命', exact: true }).click();
  await admin.page.getByRole('button', { name: '確定する', exact: true }).click();
  await admin.page.getByRole('status').filter({ hasText: '管理者権限を設定しました' }).waitFor();
  assert.equal(admin.mutations.at(-1).input.enabled, true);
  await row.getByRole('button', { name: '管理者を解除', exact: true }).click();
  await admin.page.getByRole('button', { name: '確定する', exact: true }).click();
  await admin.page.getByRole('status').filter({ hasText: '管理者権限を解除しました' }).waitFor();
  await row.getByRole('button', { name: '削除', exact: true }).click();
  const remove = admin.page.getByRole('button', { name: '完全に削除する' });
  assert.equal(await remove.isDisabled(), true);
  await admin.page.getByLabel('確認のため対象のメールアドレスを入力').fill('wrong@example.invalid');
  assert.equal(await remove.isDisabled(), true);
  await admin.page.getByLabel('確認のため対象のメールアドレスを入力').fill('viewer@example.invalid');
  await remove.click();
  await admin.page.getByText('登録ユーザー 1人').waitFor();
  assert.deepEqual(admin.mutations.at(-1), { path: '/users/delete', input: { userId: viewerId, email: 'viewer@example.invalid' } });
  assert.equal(await admin.page.getByRole('row').filter({ hasText: 'admin@example.invalid' }).getByRole('button', { name: '管理者を解除' }).isDisabled(), true);
  assert.deepEqual(admin.errors, []);
  await admin.context.close();

  const linked = await fixture('admin', 1280, '?view=users');
  await linked.page.getByText('登録ユーザー 2人').waitFor();
  assert.equal(await linked.page.getByRole('link', { name: '全アプリのユーザー管理 ↗' }).getAttribute('href'), 'https://marugo-s.github.io/multiapp/?admin=users');
  assert.deepEqual(linked.errors, []);
  await linked.context.close();

  const mobile = await fixture('admin', 375);
  await mobile.page.getByRole('button', { name: 'メニュー', exact: true }).click();
  await mobile.page.getByRole('button', { name: 'ユーザー管理', exact: true }).click();
  await mobile.page.getByText('登録ユーザー 2人').waitFor();
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page overflow');
  await mobile.page.getByRole('button', { name: '承認・店舗設定' }).click();
  await mobile.page.getByLabel('テスト店舗A', { exact: true }).check();
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile confirmation overflow');
  assert.deepEqual(mobile.errors, []);
  await mobile.context.close();

  for (const mode of ['pending', 'viewer']) {
    const f = await fixture(mode);
    await f.page.getByRole('heading', { name: mode === 'pending' ? '管理者の承認待ちです' : '店舗の選択', exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'ユーザー管理', exact: true }).count(), 0);
    assert.equal(f.calls.includes('/users') || f.calls.includes('/requests'), false);
    if (mode === 'pending') {
      assert.equal(f.calls.includes('/credentials'), false);
      assert.equal(f.calls.includes('/stores'), false);
    } else {
      assert.equal(f.calls.includes('/credentials'), true);
      // The selection heading renders before the asynchronous store list arrives.
      await f.page.getByText('テスト店舗A', { exact: true }).waitFor();
      assert.equal(await f.page.getByText('テスト店舗A', { exact: true }).count(), 1);
      assert.equal(await f.page.getByText('テスト店舗B', { exact: true }).count(), 0);
    }
    assert.deepEqual(f.errors, []);
    await f.context.close();
  }
  console.log('PASS: desktop/mobile registration badges, scoped site selection, ask/report payloads, empty selection and isolated chat; actionable auth errors; admin approval, stop, promotion/demotion, deletion; pending/viewer restrictions');
} finally {
  await browser.close();
  server?.kill();
}
