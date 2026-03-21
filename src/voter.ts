/**
 * Core vote logic.
 *
 * Flow per session:
 *   1. Call 10minutemail API (server-side, bypasses Tor proxy) → fresh temp email
 *   2. Generate an Ethiopian name via Groq (or local pool)
 *   3. Sign up on creativeaward.ai with that email  (through Tor)
 *   4. Poll 10minutemail inbox for the verification email, navigate to the link  (through Tor)
 *   5. Log in (if not already logged in after verification)  (through Tor)
 *   6. Vote on the submission page  (through Tor)
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import type { BrowserContext, Page } from 'playwright-core';
import { generateEthiopianName } from './names';
import { getTempMailbox, waitForVerificationLink } from './tenminute';

export const SUBMISSION_URL =
  'https://www.creativeaward.ai/submission/e2efa077-c740-456d-89ef-915473b3961d';

const SIGNUP_URL = 'https://www.creativeaward.ai/signup?callbackUrl=%2Fmy-submissions';
const LOGIN_URL  = 'https://www.creativeaward.ai/login?callbackUrl=%2Fmy-submissions';

const PASSWORD = process.env.ACCOUNT_PASSWORD?.replace(/^"|"$/g, '') ?? 'ta123#$55';

/**
 * Detect when the page HTML loaded but React/Next.js never hydrated.
 * The body text will be the inline theme-script blob rather than real content.
 */
function isUnhydratedPage(body: string): boolean {
  const stripped = body.trim();
  if (stripped.length === 0) return true;
  if (stripped.length < 300 && /^\(/.test(stripped)) return true;
  if (/^[\s(]*\(?\s*function|\(\s*\(?\s*[a-z],/i.test(stripped)) return true;
  return false;
}

/**
 * Wait for a Next.js page to hydrate and the expected element to appear.
 * The page HTML loads instantly (SSR shell) but React bundles take several
 * seconds to download + execute. Wait for the target selector first; only
 * diagnose blocks if it never appears.
 */
async function waitForCheckpoint(
  page: Page,
  log: (m: string) => void,
  waitForSelector: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  // Give React time to hydrate — wait for the target element directly.
  try {
    await page.waitForSelector(waitForSelector, { state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    // Selector didn't appear — diagnose the failure
    const body = (await page.innerText('body').catch(() => '')).toLowerCase();
    await snap(page, 'checkpoint-timeout');

    if (body.includes('failed to verify') || body.includes('security checkpoint') || body.includes('code 21')) {
      log('Vercel checkpoint blocked this IP');
      return false;
    }
    if (body.includes('verifying your browser')) {
      log('Checkpoint still verifying — waiting 8s more…');
      await page.waitForTimeout(8000);
      try {
        await page.waitForSelector(waitForSelector, { state: 'visible', timeout: 10_000 });
        return true;
      } catch {
        log('Still not visible after extended wait');
        return false;
      }
    }

    log(`Page did not render target element — body(100): "${body.slice(0, 100).replace(/\n/g, ' ')}"`);
    return false;
  }
}

// ── Screenshot helper ────────────────────────────────────────────────────────

function resolveShotDir(): string {
  const candidates = process.env.VERCEL
    ? [path.join(os.tmpdir(), 'votebot-screenshots')]
    : [path.join(process.cwd(), 'screenshots'), path.join(os.tmpdir(), 'votebot-screenshots')];
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch { /* try next */ }
  }
  return os.tmpdir();
}

const SHOT_DIR = resolveShotDir();

async function snap(page: Page, label: string) {
  try {
    await page.screenshot({ path: path.join(SHOT_DIR, `${Date.now()}-${label}.png`) });
  } catch { /* ignore */ }
}

// ── Sign up ──────────────────────────────────────────────────────────────────

type SignupResult = 'ok' | 'already' | 'verify-needed' | 'fail';

async function signup(
  page: Page,
  email: string,
  firstName: string,
  lastName: string,
  log: (m: string) => void,
): Promise<SignupResult> {
  log(`Signing up: ${email} (${firstName} ${lastName})`);
  await page.goto(SIGNUP_URL, { waitUntil: 'load', timeout: 30_000 });
  if (!await waitForCheckpoint(page, log, '#name, input[type="email"]')) return 'fail';

  try {
    const fullName = `${firstName} ${lastName}`.trim();

    // creativeaward.ai uses id-based fields: #name, #email, #password
    const nameEl = page.locator('#name, input[name="name"], input[placeholder*="name" i]').first();
    if (await nameEl.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nameEl.fill(fullName);
    } else {
      // Try split first/last name fields as fallback
      const firstEl = page.locator('#firstName, input[name="firstName"], input[placeholder*="first" i]').first();
      if (await firstEl.isVisible({ timeout: 1500 }).catch(() => false)) {
        await firstEl.fill(firstName);
        const lastEl = page.locator('#lastName, input[name="lastName"], input[placeholder*="last" i]').first();
        if (await lastEl.isVisible({ timeout: 1000 }).catch(() => false)) await lastEl.fill(lastName);
      } else {
        await snap(page, 'signup-no-name');
        log('Name field not found — screenshot saved');
        return 'fail';
      }
    }

    await page.locator('#email, input[type="email"]').first().fill(email);
    await page.locator('#password, input[type="password"]').first().fill(PASSWORD);

    // Confirm password — only if visible
    const confirm = page.locator('#confirmPassword, input[placeholder*="confirm" i]').first();
    if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) await confirm.fill(PASSWORD);

    await page.waitForTimeout(400);
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.waitForTimeout(4000);

    const url  = page.url();
    const body = (await page.innerText('body').catch(() => '')).toLowerCase();
    log(`[signup-debug] url=${url}  body(100)="${body.slice(0, 100).replace(/\n/g, ' ')}"`);

    if (isUnhydratedPage(body)) {
      await snap(page, 'signup-blocked');
      log('Signup response blocked — page did not hydrate (Vercel checkpoint)');
      return 'fail';
    }

    // Match the actual creativeaward.ai "Check Your Email" page (most common success)
    if (
      body.includes('check your email') || body.includes('check_your_email') ||
      body.includes('check your inbox') || body.includes('verification link') ||
      body.includes('sent a verification') || body.includes('sent to') ||
      body.includes('activate your account') || body.includes('confirm your email') ||
      body.includes('we sent') ||
      url.includes('verify') || url.includes('check-email')
    ) {
      log('Email verification required — will check inbox');
      return 'verify-needed';
    }

    // Only flag "already registered" for very specific server-error patterns.
    // Must NOT match generic page chrome like "Already have an account? Sign in"
    const alreadyPatterns = [
      'already registered', 'already exists', 'already in use',
      'email exists', 'account exists', 'email already',
      'already been registered', 'email is taken',
    ];
    if (alreadyPatterns.some(p => body.includes(p))) {
      await snap(page, 'signup-already');
      log(`Already registered — body: ${body.slice(0, 300)}`);
      return 'already';
    }

    if (body.includes('signup failed') || body.includes('registration failed') || body.includes('try again later')) {
      await snap(page, 'signup-rejected');
      log('Signup rejected by server (likely rate-limited)');
      return 'fail';
    }

    if (!url.includes('/signup')) {
      log(`Signup OK → ${url}`);
      return 'ok';
    }

    await snap(page, 'signup-fail');
    log(`Signup may have failed — URL: ${url} — body: ${body.slice(0, 300)}`);
    return 'fail';
  } catch (err) {
    log(`Signup error: ${err}`);
    return 'fail';
  }
}

// ── Log in ───────────────────────────────────────────────────────────────────

async function login(page: Page, email: string, log: (m: string) => void): Promise<boolean> {
  const url = page.url();
  if (!url.includes('/login') && !url.includes('/signup') && !url.includes('verify')) {
    log('Already logged in ✓');
    return true;
  }

  log(`Logging in: ${email}`);
  await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 30_000 });
  if (!await waitForCheckpoint(page, log, '#email, input[type="email"]')) return false;

  try {
    await page.locator('#email, input[type="email"]').first().fill(email);
    await page.locator('#password, input[type="password"]').first().fill(PASSWORD);
    await page.waitForTimeout(300);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(4000);

    if (page.url().includes('/login')) {
      await snap(page, 'login-fail');
      log('Login failed — still on login page');
      return false;
    }
    log('Logged in ✓');
    return true;
  } catch (err) {
    log(`Login error: ${err}`);
    return false;
  }
}

// ── Vote ─────────────────────────────────────────────────────────────────────

async function vote(page: Page, log: (m: string) => void): Promise<boolean> {
  log('Navigating to submission…');
  await page.goto(SUBMISSION_URL, { waitUntil: 'load', timeout: 30_000 });
  if (!await waitForCheckpoint(page, log, 'main, button')) return false;
  await page.waitForTimeout(2000);

  try {
    // The vote button: rounded pill with heart SVG + <span class="font-mono font-bold">count</span>
    // Disabled + "Sign in to vote" when logged out; enabled when logged in.
    // After clicking, the heart turns red/filled — the count may not update in
    // the DOM immediately, so we detect success by class/style change on the button.
    const voteBtn = page.locator('button:has(span.font-mono)').first();

    if (await voteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      const isDisabled = await voteBtn.isDisabled();
      const btnClass = await voteBtn.getAttribute('class') ?? '';
      const countBefore = await voteBtn.locator('span.font-mono').textContent().catch(() => '?');
      log(`Vote button: count=${countBefore} disabled=${isDisabled}`);

      if (isDisabled) {
        log('Vote button is disabled — not logged in');
        await snap(page, 'vote-not-logged-in');
        return false;
      }

      // Intercept the vote API response
      let apiSuccess = false;
      let apiCount: number | null = null;
      const voteResponsePromise = page.waitForResponse(
        resp => resp.url().includes('/api/vote') && resp.request().method() === 'POST',
        { timeout: 10_000 },
      ).then(async resp => {
        try {
          const json = await resp.json() as { success?: boolean; voteCount?: number };
          apiSuccess = !!json.success;
          apiCount   = json.voteCount ?? null;
          log(`Vote API: success=${json.success} voteCount=${json.voteCount}`);
        } catch { /* ignore */ }
      }).catch(() => {
        log('Vote API response not captured (may still have worked)');
      });

      await voteBtn.scrollIntoViewIfNeeded();
      await voteBtn.click();
      log('Clicked vote button…');
      await voteResponsePromise;

      if (apiSuccess) {
        log(`Vote registered ✓ (count: ${countBefore} → ${apiCount ?? '?'})`);
        return true;
      }

      // Fallback: read the DOM count after click
      await page.waitForTimeout(2000);
      const countAfter = await voteBtn.locator('span.font-mono').textContent().catch(() => '?');
      const classAfter = await voteBtn.getAttribute('class') ?? '';

      if (countBefore !== countAfter) {
        log(`Vote registered ✓ (DOM count: ${countBefore} → ${countAfter})`);
        return true;
      }
      if (classAfter.includes('accent-red') || classAfter.includes('text-red')) {
        log('Vote accepted ✓ (button switched to active/red state)');
        return true;
      }

      await snap(page, 'vote-uncertain');
      log(`Vote uncertain — count ${countAfter}, class=${classAfter.slice(0, 60)}`);
      return false;
    }

    await snap(page, 'vote-fail');
    const btns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b =>
        `"${b.textContent?.trim().slice(0, 30)}" disabled=${b.disabled} class="${b.className.slice(0, 50)}"`
      )
    );
    log(`Vote button not found. Buttons: ${btns.slice(0, 6).join(' | ')}`);
    return false;
  } catch (err) {
    log(`Vote error: ${err}`);
    return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export type VoteResult =
  | 'success'
  | 'fail-email'
  | 'fail-signup'
  | 'fail-verify'
  | 'fail-login'
  | 'fail-vote'
  | 'error';

/**
 * Run a full vote session.
 * Creates its own pages inside `context` and closes them when done.
 * Returns the email used (or empty string on early failure) alongside the result.
 */
export async function runVoteSession(
  context: BrowserContext,
  log: (m: string) => void,
): Promise<{ result: VoteResult; email: string }> {
  const pages: Page[] = [];

  async function newPage() {
    const p = await context.newPage();
    pages.push(p);
    return p;
  }

  try {
    // 1. Get temp mailbox via mail.tm API — server-side, never touches the Tor proxy
    let mailbox: Awaited<ReturnType<typeof getTempMailbox>>;
    try {
      mailbox = await getTempMailbox(log);
    } catch (err) {
      log(`Failed to get temp email: ${err}`);
      return { result: 'fail-email', email: '' };
    }
    const email = mailbox.address;

    // 2. Generate Ethiopian name
    const { firstName, lastName } = await generateEthiopianName(log);

    // 3. Sign up on creativeaward.ai  (goes through Tor when TOR_ENABLED=true)
    const mainPage = await newPage();
    const signupResult = await signup(mainPage, email, firstName, lastName, log);
    if (signupResult === 'fail') return { result: 'fail-signup', email };

    // 4. Poll 10minutemail inbox for verification link — server-side, no Tor proxy involved
    if (signupResult === 'verify-needed') {
      log('Polling 10minutemail inbox for verification link…');
      const verifyLink = await waitForVerificationLink(mailbox, log);
      if (!verifyLink) {
        log('No verification link received — aborting');
        return { result: 'fail-verify', email };
      }
      log('Navigating to verification link…');
      await mainPage.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await mainPage.waitForTimeout(3000);

      // The verification redirect may pass through resend-links.com → creativeaward.ai
      // Wait for the final destination to load
      const verifyUrl = mainPage.url();
      log(`After verification → ${verifyUrl}`);

      // Check if we landed on a page that requires further action
      const verifyBody = (await mainPage.innerText('body').catch(() => '')).toLowerCase();
      if (verifyBody.includes('verified') || verifyBody.includes('success') || verifyBody.includes('confirmed')) {
        log('Email verified ✓');
      } else {
        log('Verification page loaded — proceeding');
      }
    }

    // 5. Log in explicitly — even if verification redirected us, we need a
    //    proper session. The vote button is disabled without auth.
    const loggedIn = await login(mainPage, email, log);
    if (!loggedIn) {
      log('Login failed — trying to vote anyway in case we have a session…');
    }

    // 6. Vote
    const voted = await vote(mainPage, log);
    if (voted) return { result: 'success', email };

    return { result: 'fail-vote', email };
  } catch (err) {
    log(`Unhandled error: ${err}`);
    return { result: 'error', email: '' };
  } finally {
    for (const p of pages) await p.close().catch(() => undefined);
  }
}
