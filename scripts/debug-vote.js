const pw = require('playwright');

(async () => {
  const b = await pw.chromium.launch({ headless: true });
  const ctx = await b.newContext();
  const p = await ctx.newPage();

  // Log into a test account first
  console.log('=== Logging in ===');
  await p.goto('https://www.creativeaward.ai/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(3000);

  // Use a known test email (from previous successful signup)
  await p.locator('#email, input[type="email"]').first().fill('aaahelyr@guerrillamailblock.com');
  await p.locator('#password, input[type="password"]').first().fill('ta123#$55');
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(4000);
  console.log('After login URL:', p.url());

  // Navigate to submission page
  console.log('=== Going to submission ===');
  await p.goto(
    'https://www.creativeaward.ai/submission/e2efa077-c740-456d-89ef-915473b3961d',
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  await p.waitForTimeout(4000);

  // Intercept all network requests from this point
  const requests = [];
  p.on('request', req => {
    if (req.url().includes('creativeaward') && req.method() !== 'GET') {
      requests.push({ method: req.method(), url: req.url(), postData: req.postData()?.slice(0, 500) });
    }
  });
  p.on('response', async resp => {
    if (resp.url().includes('creativeaward') && resp.request().method() !== 'GET') {
      const body = await resp.text().catch(() => '');
      console.log(`RESPONSE: ${resp.status()} ${resp.url()} body=${body.slice(0, 300)}`);
    }
  });

  // Check the vote button
  const btn = await p.locator('button:has(span.font-mono)').first();
  const isDisabled = await btn.isDisabled();
  const cls = await btn.getAttribute('class');
  const count = await btn.locator('span.font-mono').textContent();
  console.log(`Button: disabled=${isDisabled} count=${count}`);
  console.log(`Button class: ${cls}`);

  // Click it
  console.log('=== Clicking vote ===');
  await btn.click();
  await p.waitForTimeout(5000);

  // Check what network calls were made
  console.log('=== Network requests after click ===');
  requests.forEach(r => console.log(JSON.stringify(r)));

  // Check the page state after click
  const countAfter = await p.locator('button:has(span.font-mono) span.font-mono').first().textContent().catch(() => '?');
  const clsAfter = await p.locator('button:has(span.font-mono)').first().getAttribute('class');
  console.log(`After click: count=${countAfter}`);
  console.log(`After click class: ${clsAfter}`);

  await p.screenshot({ path: 'screenshots/debug-vote-click.png', fullPage: true });

  // Also check console errors
  p.on('console', msg => {
    if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text());
  });

  await b.close();
})().catch(e => console.error(e));
