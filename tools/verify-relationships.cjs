// Isolated Chromium extension fixture: all network is intercepted; no user profile is used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.SPACECAST_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');
const evidence = path.resolve(process.env.SPACECAST_RELATIONSHIP_EVIDENCE || path.join(os.tmpdir(), `spacecast-relationships-${Date.now()}`));
fs.mkdirSync(evidence, { recursive: true });
const stage = fs.mkdtempSync(path.join(evidence, 'fixture-extension-'));
const files = ['js/RelationshipLoader.js', 'js/RelationshipReader.js', 'js/RelationshipBadges.js', 'js/AppearanceSettings.js', 'css/spacecast.css'];
const hashes = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const sourceHashes = hashes();
const harnessHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
for (const file of files) { fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true }); fs.copyFileSync(path.join(root, file), path.join(stage, file)); }
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'SpaceCast relationship verification', version: '1.0.0', permissions: ['storage'],
  content_scripts: [manifest.content_scripts.find(item => item.world === 'MAIN'), { matches: ['https://x.com/*'], js: ['js/AppearanceSettings.js', 'js/RelationshipBadges.js', 'fixture-bootstrap.js'], css: ['css/spacecast.css'], run_at: 'document_idle' }] }));
fs.writeFileSync(path.join(stage, 'fixture-bootstrap.js'), `const relations = SpaceCastRelationships.create(document.querySelector('[data-testid="sheetDialog"]'), 'room1');
document.addEventListener('fixture:refresh',()=>relations.refresh());
document.addEventListener('fixture:disable',()=>relations.configure(false));
document.addEventListener('fixture:enable',()=>relations.configure(true));
document.addEventListener('fixture:dispose',()=>relations.dispose());`);
const fixture = `<!doctype html><meta charset="utf-8"><style>body{background:#080710;color:#eee;font-family:system-ui;padding:12px}.ss-sheet{position:relative!important;width:800px!important;max-width:calc(100vw - 48px)!important;max-height:none!important;left:0!important;top:0!important;padding:16px!important;box-sizing:border-box!important}.ss-people{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(94px,1fr))!important;gap:20px 8px!important}.ss-person-avatar{background:linear-gradient(135deg,#8b66b6,#2e4055)}.ss-person-avatar a{display:block}.ss-person{min-width:0}button{padding:10px;margin-top:16px}</style>
<div data-testid="sheetDialog" class="ss-sheet"><h2>Account relationships</h2><p>Relative to your signed-in X account</p><div class="ss-people"></div><button id="native-join">Native test action</button></div>
<script>
const defaults={following:false,followed_by:false,blocking:false,blocked_by:false,muting:false,follow_request_sent:false};
const states=[{following:true,followed_by:true},{following:true},{followed_by:true},{blocking:true},{blocked_by:true},{muting:true},{follow_request_sent:true},{},null,{},null];
const state={entities:{users:{entities:{}}}},roster=[];
for(let n=0;n<states.length;n++){const id=String(100+n),name='person'+n;roster.push({user_id:id,twitter_screen_name:name,periscope_user_id:'native'+n});if(states[n])state.entities.users.entities[id]={id_str:id,screen_name:name,...defaults,...states[n]};}
const nativeRequests=[];let hovers=0;const native={viewerUserId:'109',store:{getState:()=>state,dispatch:thunk=>thunk(()=>{},()=>state,{api:{withEndpoint:callback=>callback({apiClient:{graphQL:(operation,variables)=>{nativeRequests.push({operation,variables,at:performance.now()});return new Promise(resolve=>setTimeout(()=>resolve({users:variables.userIds.filter(id=>id==='110').map(id=>({result:{__typename:'User',rest_id:id,core:{screen_name:'person10'},relationship_perspectives:{following:true,followed_by:true,blocking:false,blocked_by:false,muting:false},follow_request_sent:false}}))}),60));}}})}})}},props={audioSpaceId:'room1',host:roster[0],cohosts:[],participants:{admins:[roster[0]],speakers:roster.slice(1),listeners:[]}};
const cards=[];
for(let n=0;n<roster.length;n++){const card=document.createElement('div');card.className='ss-person';card.innerHTML='<div class="ss-person-avatar"><a href="/person'+n+'" aria-label="Open profile"></a></div><div class="ss-person-name">Person '+n+'</div><div class="ss-person-role">Speaker</div>';document.querySelector('.ss-people').append(card);cards.push(card);card.addEventListener('mouseenter',()=>hovers++);
 const chain=Array.from({length:214},()=>({memoizedProps:{}}));for(let i=0;i<213;i++){chain[i].return=chain[i+1];chain[i+1].child=chain[i];}chain[0].stateNode=card;chain[2].memoizedProps={screenName:'person'+n};chain[7].memoizedProps=props;let deps={memoizedValue:native};for(let j=0;j<31;j++)deps={memoizedValue:{unused:j},next:deps};chain[8].dependencies={firstContext:deps};chain[213].tag=3;chain[213].stateNode={current:chain[213]};card.__reactFiber$fixture=chain[0];}
window.fixture={state,cards,props,native,nativeRequests,get hovers(){return hovers},clicks:0};document.querySelector('#native-join').onclick=()=>fixture.clicks++;
</script>`;
const errors = [], unexpected = [], results = [];
let context;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(evidence, 'profile-')), { headless: true, channel: 'chromium', viewport: { width: 1200, height: 1000 }, args: [`--disable-extensions-except=${stage}`, `--load-extension=${stage}`] });
  await context.route('**/*', route => {
    if (route.request().url().startsWith('chrome-extension:')) return route.continue();
    if (route.request().isNavigationRequest() && route.request().url() === 'https://x.com/home') return route.fulfill({ contentType: 'text/html', body: fixture });
    unexpected.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://x.com/home');
  await page.waitForFunction(() => document.querySelector('[data-ss-relationship="mutual"]'), { timeout: 8000 });
  await page.waitForFunction(() => fixture.cards[10].querySelector('[data-ss-relationship="mutual"]'), { timeout: 3000 });
  const loaded = await page.evaluate(() => ({ hovers:fixture.hovers,requests:fixture.nativeRequests,cache:fixture.state.entities.users.entities['110'],elapsed:performance.now()-fixture.nativeRequests[0].at }));
  assert.equal(loaded.hovers, 0); assert.equal(loaded.cache, undefined); assert.equal(loaded.requests.length, 1);
  assert.deepEqual([...loaded.requests[0].variables.userIds].sort(), ['108','110']);
  assert.equal(loaded.requests[0].operation.operationName, 'UsersByRestIds');
  assert.ok(loaded.elapsed < 1200, `Native preload rendered promptly: ${loaded.elapsed}ms`);
  results.push('Missing participant relationships autoload through one native X batch before any avatar hover');
  assert.deepEqual(await page.locator('.ss-relationship').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-ss-relationship'))), ['mutual','following','follower','blocked','blockedBy','muted','requested','none','unknown','self','mutual']);
  results.push('All ten relationship labels cross the real MAIN/isolated extension boundary');
  assert.deepEqual(await page.locator('.ss-person-role').allTextContents(), Array(11).fill('Speaker'));
  await page.getByRole('button', { name: 'Native test action' }).click();
  assert.equal(await page.evaluate(() => fixture.clicks), 1);
  results.push('Native role text, identity, and click handler remain intact');
  for (const width of [350, 440, 820]) {
    await page.setViewportSize({ width: width + 48, height: 1200 });
    await page.locator('.ss-sheet').evaluate((node, width) => node.style.setProperty('width', width + 'px', 'important'), width);
    await wait(100);
    const clipped = await page.locator('.ss-relationship').evaluateAll(nodes => nodes.filter(node => { const a=node.getBoundingClientRect(),b=node.parentElement.getBoundingClientRect();return a.x<b.x-1||a.right>b.right+1||a.y<b.y-1||a.bottom>b.bottom+1||a.height<16; }).length);
    assert.equal(clipped, 0, `Chips fit ${width}px window`);
    await page.locator('.ss-sheet').screenshot({ path: path.join(evidence, `relationships-${width}.png`) });
  }
  results.push('Relationship chips fit 350, 440 and 820 pixel windows');
  await page.evaluate(() => { window.changes=0;window.observer=new MutationObserver(records=>window.changes+=records.length);observer.observe(document.querySelector('.ss-people'),{subtree:true,childList:true,attributes:true}); });
  await wait(3300);
  assert.equal(await page.evaluate(() => window.changes), 0);
  results.push('Two native-cache polls cause zero idle participant mutations');
  await page.evaluate(() => { fixture.state.entities.users.entities['101'].followed_by=true; });
  await page.waitForFunction(() => fixture.cards[1].querySelector('[data-ss-relationship="mutual"]'));
  await page.evaluate(() => { fixture.native.viewerUserId='987';delete fixture.state.entities.users.entities['101']; });
  await page.waitForFunction(() => fixture.cards[1].querySelector('[data-ss-relationship="unknown"]'));
  results.push('Loaded cache updates and missing records change labels without network requests');
  await page.evaluate(() => fixture.cards[0].querySelector('a').setAttribute('href', '/replacement'));
  await page.waitForFunction(() => fixture.cards[0].querySelector('[data-ss-relationship="unknown"]'));
  assert.equal(await page.locator('.ss-person').first().locator('[data-ss-relationship="mutual"]').count(), 0);
  await page.evaluate(() => {
    fixture.cards[0].__reactFiber$fixture.return.return.memoizedProps.screenName='replacement';
    fixture.props.host={user_id:'999',twitter_screen_name:'replacement'};
    fixture.props.participants.admins=[fixture.props.host];
    fixture.state.entities.users.entities['999']={id_str:'999',screen_name:'replacement',following:false,followed_by:true,blocking:false,blocked_by:false,muting:false,follow_request_sent:false};
  });
  await page.waitForFunction(() => fixture.cards[0].querySelector('[data-ss-relationship="follower"]'));
  results.push('Href-only card reuse immediately clears old relationship and resolves the replacement');
  await page.evaluate(() => document.dispatchEvent(new Event('fixture:disable')));
  assert.equal(await page.locator('.ss-relationship').count(), 0);
  await page.evaluate(() => document.dispatchEvent(new Event('fixture:enable')));
  await page.waitForFunction(() => document.querySelector('[data-ss-relationship="follower"]'));
  await page.evaluate(() => document.dispatchEvent(new Event('fixture:dispose')));
  assert.equal(await page.locator('.ss-relationship,[data-ss-relation-key],[data-ss-relation-sheet],[data-ss-relation-enabled]').count(), 0);
  results.push('Settings disable and cleanup remove every owned chip and token');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(hashes(), sourceHashes);
}
run().then(() => console.log('PASS ' + results.length + ' browser checks')).catch(error => { errors.push(error.stack); process.exitCode=1; console.error(error.stack); }).finally(async () => {
  await context?.close();
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({ passed:!errors.length, results, errors, unexpected, sourceHashes, harnessHash },null,2));
});
