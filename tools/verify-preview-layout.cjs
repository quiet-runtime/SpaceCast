// Isolated extension-enabled Chromium. Native actions are fixture-only counters.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.SPACECAST_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');
const evidence = path.resolve(process.env.SPACECAST_LAYOUT_EVIDENCE || path.join(os.tmpdir(), `spacecast-layout-${Date.now()}`));
fs.mkdirSync(evidence, { recursive: true });
const stage = fs.mkdtempSync(path.join(evidence, 'fixture-extension-'));
const files = ['js/SpacePreviewLayout.js', 'css/spacecast.css', 'css/appearance.css'];
const hashes = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const sourceHashes = hashes();
for (const file of files) {
  fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
  fs.copyFileSync(path.join(root, file), path.join(stage, file));
}
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'SpaceCast preview layout verification', version: '1.0.0', content_scripts: [{ matches: ['https://x.com/*'], js: ['js/SpacePreviewLayout.js', 'bootstrap.js'], css: ['css/spacecast.css', 'css/appearance.css'], run_at: 'document_idle' }] }));
fs.writeFileSync(path.join(stage, 'bootstrap.js'), `const layout = new SpacePreviewLayout(document.querySelector('.ss-sheet')); document.addEventListener('fixture:dispose', () => layout.dispose());`);
const fixture = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#080710;color:#eee;font-family:system-ui}.native-actions{background:linear-gradient(62deg,#2d42ff,#9c63fa);box-shadow:0 0 12px #548bff;border-radius:99px}.native-cta{position:relative;display:block;width:100%;border:0;border-radius:99px;padding:0;color:#fff;font-size:28px;line-height:40px;background:linear-gradient(62deg,#2d42ff,#9c63fa);box-shadow:0 0 9px #548bff}.native-art{padding:6px;color:white;font-size:28px;border-radius:99px;text-shadow:0 0 3px blue}.native-actions::before,.native-cta::before,.native-art::after{content:"";position:absolute;inset:-3px;border-radius:99px;box-shadow:0 0 9px blue;background:linear-gradient(62deg,#2d42ff,#9c63fa);pointer-events:none}.native-art span{position:relative;color:white;font-size:28px}
</style><div data-testid="sheetDialog" class="ss-sheet ss-appearance" data-ss-style="oled" style="left:20px!important;top:20px!important;width:600px!important;max-height:none!important;transform:none!important"><div><div><button aria-label="Close">Close</button><button aria-label="Share">Share</button></div><div><h2>Native Space preview controls</h2></div><div><div id="footer" class="native-actions"><p>Your mic will be off to start</p><div id="actions" class="native-actions"><div id="anonymous-wrap" class="native-actions"><button id="anonymous" class="native-cta" aria-label="Start listening anonymously"><div class="native-art" style="background-image:linear-gradient(61.63deg,rgb(45,66,255) -15.05%,rgb(156,99,250) 104.96%)"><span style="color:white;font-size:28px">Start listening anonymously</span></div></button></div><div id="speaker-wrap" class="native-actions"><button id="speaker" class="native-cta" aria-label="Start speaking"><div class="native-art"><span>Start speaking</span></div></button></div></div></div></div></div></div><script>
window.fixture={clicks:{anonymous:0,speaker:0},buttons:[document.querySelector('#anonymous'),document.querySelector('#speaker')]};document.querySelector('[data-testid=sheetDialog]').addEventListener('click',event=>{const button=event.target.closest('button');if(button&&button.id in fixture.clicks)fixture.clicks[button.id]++;});
</script>`;
const errors = [], unexpected = [], results = [];
let context;
async function run() {
  context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(evidence, 'profile-')), { headless: true, channel: 'chromium', viewport: { width: 1000, height: 800 }, args: [`--disable-extensions-except=${stage}`, `--load-extension=${stage}`] });
  await context.route('**/*', route => {
    if (route.request().url().startsWith('chrome-extension:')) return route.continue();
    if (route.request().isNavigationRequest() && route.request().url() === 'https://x.com/home') return route.fulfill({ contentType: 'text/html', body: fixture });
    unexpected.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://x.com/home');
  await page.waitForSelector('#anonymous.ss-native-listen');
  await page.evaluate(() => { window.paint = () => fixture.buttons.map(button => { const style=getComputedStyle(button);return {tagged:button.classList.contains('ss-native-listen'),radius:style.borderRadius,height:button.getBoundingClientRect().height,overflow:style.overflow,font:style.fontSize,descendants:[...button.querySelectorAll('*')].map(node=>({background:getComputedStyle(node).backgroundImage,font:getComputedStyle(node).fontSize,color:getComputedStyle(node).color})),paint:[button,...button.querySelectorAll('*'),button.parentElement,document.querySelector('#actions'),document.querySelector('#footer')].flatMap(node=>['::before','::after'].map(pseudo=>({background:getComputedStyle(node,pseudo).backgroundImage,shadow:getComputedStyle(node,pseudo).boxShadow}))) };}); });
  function checkPaint(paint) {
    for (const button of paint) {
      assert.equal(button.tagged, true); assert.equal(button.radius, '11px'); assert.equal(button.overflow, 'hidden'); assert.equal(button.font, '12px');
      assert.ok(button.height <= 54, `Compact action height: ${button.height}`);
      for (const child of button.descendants) assert.deepEqual(child, { background: 'none', font: '12px', color: 'rgb(36, 20, 51)' });
      for (const layer of button.paint) assert.deepEqual(layer, { background: 'none', shadow: 'none' });
    }
  }
  checkPaint(await page.evaluate(() => paint()));
  results.push('Native gradients, oversized labels, shadows and pseudo-element edge paint are cleared');
  for (const width of [350, 440, 800]) {
    await page.locator('.ss-sheet').evaluate((node, width) => node.style.setProperty('width', `${width}px`, 'important'), width);
    for (const theme of ['liquid', 'dracula', 'oled', 'solid']) {
      await page.locator('.ss-sheet').evaluate((node, theme) => node.setAttribute('data-ss-style', theme), theme);
      const firstFrame = await page.evaluate(() => new Promise(resolve => {
        for (const button of fixture.buttons) button.className='native-cta native-pressed';
        for (const id of ['footer','actions','anonymous-wrap','speaker-wrap']) document.getElementById(id).className='native-actions native-hover';
        requestAnimationFrame(() => resolve(paint()));
      }));
      checkPaint(firstFrame);
    }
    await page.locator('.ss-sheet').screenshot({ path: path.join(evidence, `native-actions-${width}.png`) });
  }
  results.push('Both actions retain themed paint in the first frame after React class replacement at three widths and four themes');
  await page.getByRole('button', { name: 'Start listening anonymously', exact: true }).click();
  await page.getByRole('button', { name: 'Start speaking', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => fixture.clicks), { anonymous: 1, speaker: 1 });
  assert.equal(await page.evaluate(() => fixture.buttons.every(button=>button===document.getElementById(button.id))), true);
  await page.locator('#speaker').evaluate(node => { node.disabled=true;node.setAttribute('aria-disabled','true'); });
  assert.equal(await page.locator('#speaker').isDisabled(), true);
  await page.locator('#speaker-wrap').evaluate(node => node.hidden=true);
  assert.equal(await page.locator('#speaker').isVisible(), false);
  results.push('Native node identities and pointer/keyboard handlers remain intact; disabled and hidden actions stay native');
  await page.evaluate(() => { window.mutations=0;window.idleObserver=new MutationObserver(records=>window.mutations+=records.length);idleObserver.observe(document.querySelector('.ss-sheet'),{attributes:true,childList:true,subtree:true}); });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.mutations), 0);
  results.push('The class repair observer causes zero idle DOM mutations');
  await page.evaluate(() => document.dispatchEvent(new Event('fixture:dispose')));
  assert.equal(await page.locator('.ss-native-listen').count(), 0);
  await page.locator('#anonymous').evaluate(node => node.className='native-cta');
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.ss-native-listen').count(), 0);
  results.push('Disposal removes owned tags and disconnects class repair');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(hashes(), sourceHashes);
  fs.writeFileSync(path.join(evidence, 'layout-results.json'), JSON.stringify({ results, errors, unexpected, sourceHashes }, null, 2));
  console.log(JSON.stringify({ checks: results.length, evidence, results }, null, 2));
}
run().catch(error => { fs.writeFileSync(path.join(evidence, 'layout-failure.json'), JSON.stringify({ message:error.message,stack:error.stack,results,errors,unexpected },null,2)); console.error(error);process.exitCode=1; }).finally(async()=>{await context?.close();});
