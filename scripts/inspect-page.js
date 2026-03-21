const pw = require('playwright');

(async () => {
  const b = await pw.chromium.launch({ headless: true });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto(
    'https://www.creativeaward.ai/submission/e2efa077-c740-456d-89ef-915473b3961d',
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  await p.waitForTimeout(5000);
  await p.screenshot({ path: 'screenshots/submission-debug.png', fullPage: true });

  const buttons = await p.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map((b, i) => ({
      idx: i,
      text: b.textContent?.trim().slice(0, 80),
      type: b.type,
      ariaLabel: b.getAttribute('aria-label'),
      className: b.className.slice(0, 120),
      id: b.id,
      hasSvg: b.querySelector('svg') !== null,
      disabled: b.disabled,
      innerHTML: b.innerHTML.slice(0, 300),
    }))
  );
  console.log('=== BUTTONS ===');
  buttons.forEach(b => console.log(JSON.stringify(b)));

  const voteEls = await p.evaluate(() => {
    const sels = '[class*="vote"], [class*="like"], [class*="heart"], [class*="Sign"], [data-testid]';
    return Array.from(document.querySelectorAll(sels)).map(el => ({
      tag: el.tagName,
      className: el.className.toString().slice(0, 120),
      text: el.textContent?.trim().slice(0, 80),
    }));
  });
  console.log('=== VOTE/LIKE ELEMENTS ===');
  voteEls.forEach(e => console.log(JSON.stringify(e)));

  // Look for the vote count text
  const texts = await p.evaluate(() => {
    return Array.from(document.querySelectorAll('*')).filter(el => {
      const t = el.textContent?.trim() || '';
      return /^\d{2,4}$/.test(t) || t.toLowerCase().includes('sign in to vote');
    }).map(el => ({
      tag: el.tagName,
      className: el.className.toString().slice(0, 80),
      text: el.textContent?.trim().slice(0, 80),
    }));
  });
  console.log('=== VOTE COUNT / SIGN IN TEXT ===');
  texts.forEach(t => console.log(JSON.stringify(t)));

  await b.close();
})().catch(e => console.error(e));
