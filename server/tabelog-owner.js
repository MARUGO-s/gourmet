// Only authenticated owner-console pages. No public-page requests or fallback.
export function readOwnerReviews() {
  const txt = (el, selector) => el.querySelector(selector)?.textContent?.trim() ?? '';
  const body = (el, selector) => { const node = el.querySelector(selector); return (node?.innerText ?? node?.textContent ?? '').trim(); };
  const numeric = value => /^\d(?:\.\d+)?$/.test(value) && Number(value) <= 5 ? Number(value) : null;
  const month = value => { const m = value.match(/(?:'?(\d{2}|\d{4}))\/(\d{2})/); return m ? `${m[1].length === 2 ? '20' : ''}${m[1]}-${m[2]}` : null; };
  const scores = el => [...el.querySelectorAll('.total.c-rating-v2, .rvw-item__ratings-total')].map(n => ({
    label:txt(n,'.c-rating-v2__time').replace(/：$/, ''), value:numeric(txt(n,'.c-rating-v2__val')),
    breakdown:n.parentElement.querySelector('.ratings, .rvw-item__ratings-dtlscore')?.textContent.replace(/\s+/g,' ').trim() ?? null,
  }));
  const reply = document.querySelectorAll('.review-wrap').length > 0;
  const items = [...document.querySelectorAll(reply ? '.review-wrap' : '.rvw-item')].map(el => {
    const link = el.querySelector(reply ? '#review-title a' : '.rvw-item__title a');
    const url = link?.href ?? el.getAttribute('data-detail-url') ?? '';
    const groupId = url.match(/\/dtlrvwlst\/(B\d+)\//)?.[1];
    const visitId = url.match(/#(\d+)$/)?.[1];
    if (!groupId || (reply && !visitId)) throw new Error('管理画面の口コミ識別情報を確認できません');
    const entryDate = txt(el,'.entry-date > .date');
    const dateMatch = entryDate.match(/^'?(\d{2}|\d{4})\/(\d{2})\/(\d{2})$/);
    const date = dateMatch ? `${dateMatch[1].length === 2 ? '20' : ''}${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null;
    const visitText = reply ? txt(el,'.entry-date')?.match(/（(.*?)訪問/)?.[1] ?? '' : txt(el,'.js-rvw-item').match(/\d{4}\/\d{2}訪問/)?.[0] ?? '';
    const values = scores(el);
    const replyArea = el.querySelector('.owner-res');
    return {
      externalId:reply ? `${groupId}:${visitId}` : `${groupId}:excerpt`, groupId, date,
      title:link?.textContent.trim() ?? '', visitMonth:month(visitText),
      author:([...el.querySelectorAll(reply ? '.reviewer-name a' : '.rvw-item__rvwr-data a')].find(a=>a.textContent.trim())?.textContent ?? '').replace(/\s*[（(]\d+[)）]\s*$/, '').trim() || '匿名',
      rating:values.length === 1 ? values[0].value : null,
      text:body(el, reply ? '.review-contents > .comment' : '.rvw-item__rvw-comment'),
      details:{origin:reply ? 'owner_reply' : 'owner_pickup', textComplete:reply, scores:values,
        usedPrice:reply ? [...el.querySelectorAll('.reviewer-rating')].find(n=>n.textContent.includes('使った金額'))?.textContent.replace(/\s+/g,' ').trim() ?? null : txt(el,'.rvw-item__usedprice'),
        ownerReply:replyArea ? {text:body(replyArea,'.comment'),date:txt(replyArea,'.date'),status:txt(replyArea,'.owner-ttl').replace('[ 編集 ]','').trim()} : null},
    };
  });
  const totalText = document.querySelector('.page-count')?.textContent.replace(/\s+/g,'') ?? '';
  const total = totalText.match(/全([\d,]+)件/)?.[1];
  const next = [...document.querySelectorAll('a')].find(a=>/^次の\d+件$/.test(a.textContent.trim()))?.href ?? null;
  return {items,total:total == null ? null : Number(total.replaceAll(',','')),next};
}

export function mergeOwnerReviews(reply, pickup) {
  for (const list of [reply,pickup]) if (list.items.length !== list.total || new Set(list.items.map(r=>r.externalId)).size !== list.total) throw new Error('管理画面の口コミ件数が一致しません');
  const byId = new Map();
  for (const row of reply.items) {
    if (byId.has(row.externalId)) throw new Error('管理画面の口コミが重複しています');
    byId.set(row.externalId,row);
  }
  const fullGroups = new Set(reply.items.map(r=>r.groupId));
  for (const row of pickup.items) if (!fullGroups.has(row.groupId)) byId.set(row.externalId,row);
  const items = [...byId.values()];
  return {items,summary:{replyCount:reply.total,pickupCount:pickup.total,
    groups:new Set(items.map(r=>r.groupId)).size,entries:items.length,
    fullText:items.filter(r=>r.details.textComplete).length,excerpts:items.filter(r=>!r.details.textComplete&&r.text).length,
    scoreOnly:items.filter(r=>!r.text).length,
    source:'owner_console',officialRatingAvailable:false}};
}

export function readOwnerDailyTable() {
  const table = document.querySelector('#data-access-alldevice');
  if (!table) throw new Error('管理画面の日別PV表がありません');
  return [...table.rows].flatMap(tr=>{
    const date = tr.cells[0]?.textContent.match(/^\s*(\d{4}-\d{2}-\d{2})/)?.[1];
    if(!date) return [];
    const numbers=[...tr.cells].slice(1).map(c=>{const s=c.textContent.trim().replaceAll(',','');return /^\d+$/.test(s)?Number(s):null;});
    if(numbers.length!==4 || numbers.some(n=>n==null)) throw new Error('管理画面の日別PVを正しく取得できません');
    const unclassified=numbers[3]-numbers[0]-numbers[1]-numbers[2];
    if(unclassified<0)throw new Error('管理画面の日別PVの内訳が総合値を超えています');
    return [{date,pc:numbers[0],sp:numbers[1],app:numbers[2],pv:numbers[3],...(unclassified?{unclassified}:{})}];
  });
}

export function readOwnerPageTotals() {
  const table=document.querySelector('table[id^="dataex-page-"]');
  if(!table) throw new Error('管理画面のページ別PV表がありません');
  return [...table.rows].slice(1).flatMap(tr=>{
    const name=tr.cells[0]?.textContent.trim();
    const raw=tr.cells[1]?.textContent.trim().replaceAll(',','');
    return name && /^\d+$/.test(raw) ? [{name,pv:Number(raw)}] : [];
  });
}

const safeOwner = (url, path) => {const u=new URL(url);if(u.origin!=='https://owner.tabelog.com'||u.pathname.replace(/\/$/,'')!==path)throw new Error('管理画面の取得先が不正です');return u.href;};
export async function ownerGoto(page, url, assertAuthenticated) {
  if(new URL(url).origin!=='https://owner.tabelog.com') throw new Error('管理画面以外には接続しません');
  const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
  await assertAuthenticated(page);
  if(new URL(page.url()).origin!=='https://owner.tabelog.com'||response?.status()!==200) throw new Error('管理画面へのアクセスが拒否されました');
}

async function reviewList(page,path,assertAuthenticated) {
  await ownerGoto(page,`https://owner.tabelog.com${path}`,assertAuthenticated);
  await page.locator('.page-count').waitFor({state:'attached'});
  const select=page.locator('select[name="lc"]');
  if(await select.count() && await select.locator('option:checked').textContent()!=='100') {
    await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),select.selectOption({label:'100'})]);
    await assertAuthenticated(page);
  }
  const items=[],visited=new Set();let total=null;
  for(let i=0;i<50;i++) {
    const current=safeOwner(page.url(),path);
    if(visited.has(current)) throw new Error('口コミページが循環しています');
    visited.add(current);
    await page.locator('.page-count').waitFor({state:'attached'});
    const part=await page.evaluate(readOwnerReviews);
    if(part.total==null || (total!=null&&total!==part.total))throw new Error('管理画面の口コミ件数を確認できません');
    total=part.total;items.push(...part.items);
    if(!part.next) break;
    await ownerGoto(page,safeOwner(part.next,path),assertAuthenticated);
  }
  if(items.length!==total) throw new Error('管理画面の口コミを全件取得できませんでした');
  return {items,total};
}

export async function collectOwnerReviews(page,assertAuthenticated) {
  const reply=await reviewList(page,'/owner_rst/reply_top',assertAuthenticated);
  const pickup=await reviewList(page,'/owner_rst/rstupreview_entry',assertAuthenticated);
  return mergeOwnerReviews(reply,pickup);
}

export async function selectAllMonths(page,assertAuthenticated) {
  const select=page.locator('#report-month-first');
  await select.waitFor({state:'attached'});
  const months=await select.locator('option').evaluateAll(els=>els.map(e=>e.value));
  if(!months.length||months.length>240||months.some(m=>!/^\d{6}$/.test(m)))throw new Error('管理画面の期間を確認できません');
  const first=[...months].sort()[0],last=[...months].sort().at(-1);
  if(await select.inputValue()!==first) await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),select.selectOption(first)]);
  const end=page.locator('#report-month-last');
  if(await end.inputValue()!==last) await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),end.selectOption(last)]);
  await assertAuthenticated(page);
  if(await select.inputValue()!==first || await end.inputValue()!==last)throw new Error('管理画面の取得期間が一致しません');
  return {first,last};
}

export async function collectOwnerDaily(page,assertAuthenticated,onProgress,today) {
  await ownerGoto(page,'https://owner.tabelog.com/owner_rst/access_report_total',assertAuthenticated);
  await page.locator('#data-access-alldevice').waitFor({state:'attached'});
  const current=await page.evaluate(readOwnerDailyTable);
  const link=await page.getByRole('link',{name:'日別',exact:true}).getAttribute('href');
  await ownerGoto(page,safeOwner(new URL(link,page.url()).href,'/owner_rst/access_report_total'),assertAuthenticated);
  const months=await page.locator('#report-month option').evaluateAll(els=>els.map(e=>e.value));
  if(!months.length||months.length>120||months.some(m=>!/^\d{6}$/.test(m)))throw new Error('日別PVの全期間を確認できません');
  const all=new Map();
  for (const [index,month] of months.entries()) {
    onProgress('daily_pv',`日別・端末別PVの履歴を取得しています（${index+1}/${months.length}か月）`);
    if(await page.locator('#report-month').inputValue()!==month) {
      await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.locator('#report-month').selectOption(month)]);
      await assertAuthenticated(page);
    }
    await page.locator('#data-access-alldevice').waitFor({state:'attached'});
    const rows=await page.evaluate(readOwnerDailyTable);
    const expectedDays=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(4)),0)).getUTCDate();
    if(rows.length!==expectedDays||rows.some(r=>r.date.slice(0,7)!==`${month.slice(0,4)}-${month.slice(4)}`))throw new Error('日別PVの期間または日数が一致しません');
    rows.forEach(r=>all.set(r.date,r));
    await page.waitForTimeout(250);
  }
  current.forEach(r=>all.set(r.date,r));
  return {daily:[...all.values()].filter(r=>r.date<today).sort((a,b)=>a.date.localeCompare(b.date))};
}

export async function collectPageHistory(page,assertAuthenticated) {
  const devices={};let range;
  await ownerGoto(page,'https://owner.tabelog.com/owner_rst/access_report_page',assertAuthenticated);
  const links=await page.locator('a').evaluateAll(els=>els.filter(a=>['スマートフォン版','アプリ版'].includes(a.textContent.trim())).map(a=>({name:a.textContent.trim(),url:a.href})));
  for(const [key,url] of [['pc',page.url()],['sp',links.find(x=>x.name==='スマートフォン版')?.url],['app',links.find(x=>x.name==='アプリ版')?.url]]) {
    if(!url)throw new Error('端末別ページレポートがありません');
    if(key!=='pc')await ownerGoto(page,safeOwner(url,'/owner_rst/access_report_page'),assertAuthenticated);
    range=await selectAllMonths(page,assertAuthenticated);
    await page.locator('table[id^="dataex-page-"]').waitFor({state:'attached'});
    devices[key]=await page.evaluate(readOwnerPageTotals);
  }
  return {...range,devices};
}
