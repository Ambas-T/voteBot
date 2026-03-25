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
 * Wait for the Vercel Security Checkpoint to clear, with retry.
 * Returns true if the expected selector appeared, false if stuck/blocked.
 */
async function waitForCheckpoint(
  page: Page,
  log: (m: string) => void,
  waitForSelector: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = (await page.innerText('body').catch(() => '')).toLowerCase();

    if (body.includes('failed to verify your browser')) {
      log('Checkpoint blocked — retrying…');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }

    if (body.includes('verifying your browser') || body.includes('security checkpoint')) {
      log('Vercel security checkpoint detected — waiting…');
    }

    try {
      await page.waitForSelector(waitForSelector, { state: 'visible', timeout: timeoutMs });
      return true;
    } catch {
      if (attempt === 0) {
        log('Checkpoint did not clear — retrying…');
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    }
  }

  await snap(page, 'checkpoint-blocked');
  log('Checkpoint blocked after retries');
  return false;
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
  await page.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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

    await page.waitForTimeout(200);
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    // Wait for navigation or body change instead of fixed delay
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);

    const url  = page.url();
    const body = (await page.innerText('body').catch(() => '')).toLowerCase();

    // Check for verification FIRST — the signup page may include text like
    // "Already have an account?" which would falsely match a naive "already" check.
    if (
      body.includes('check your email') || body.includes('check_your_email') ||
      body.includes('check your inbox') || body.includes('verification link') ||
      body.includes('sent a verification') || body.includes('sent to') ||
      body.includes('activate your account') || body.includes('confirm your email') ||
      url.includes('verify') || url.includes('check-email')
    ) {
      log('Email verification required — will check inbox');
      return 'verify-needed';
    }

    if (
      body.includes('already registered') || body.includes('already exists') ||
      body.includes('already in use') || body.includes('email exists') ||
      body.includes('account exists') || body.includes('email already')
    ) {
      await snap(page, 'signup-already');
      log(`Already registered — body snippet: ${body.slice(0, 200)}`);
      return 'already';
    }

    if (
      body.includes('signup failed') || body.includes('registration failed') ||
      body.includes('try again later') || body.includes('too many')
    ) {
      log('Signup rate-limited by server — circuit rotation needed');
      return 'fail';
    }

    if (!url.includes('/signup')) {
      log(`Signup OK → ${url}`);
      return 'ok';
    }

    await snap(page, 'signup-fail');
    log(`Signup may have failed — URL: ${url} — body: ${body.slice(0, 200)}`);
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
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (!await waitForCheckpoint(page, log, '#email, input[type="email"]')) return false;

  try {
    await page.locator('#email, input[type="email"]').first().fill(email);
    await page.locator('#password, input[type="password"]').first().fill(PASSWORD);
    await page.waitForTimeout(200);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2000);

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

const SUBMISSION_ID = 'e2efa077-c740-456d-89ef-915473b3961d';

async function vote(page: Page, log: (m: string) => void): Promise<boolean> {
  // Fast path: call the vote API directly via fetch inside the browser context.
  // The page already has session cookies from signup/verification — no need to
  // load the heavy Next.js submission page (saves 8-15s through Tor).
  log('Voting via API…');
  try {
    const apiResult = await page.evaluate(async (subId: string) => {
      const payloads = [
        { submissionId: subId },
        { id: subId },
        { submission_id: subId },
      ];
      for (const body of payloads) {
        try {
          const res = await fetch('/api/vote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const json = await res.json().catch(() => null);
          if (json && json.success) return { ok: true, count: json.voteCount ?? null };
          if (res.status === 401 || res.status === 403) return { ok: false, count: null, reason: 'unauthorized' };
          if (json && !json.success) return { ok: false, count: null, reason: `rejected: ${JSON.stringify(json).slice(0, 80)}` };
        } catch { /* try next payload */ }
      }
      return { ok: false, count: null, reason: 'all-payloads-failed' };
    }, SUBMISSION_ID);

    if (apiResult.ok) {
      log(`Vote registered ✓ (API, count: ${apiResult.count ?? '?'})`);
      return true;
    }
    log(`API vote failed (${(apiResult as any).reason}) — falling back to UI…`);
  } catch (err) {
    log(`API vote error: ${err} — falling back to UI…`);
  }

  // Fallback: load the full submission page and click the button
  log('Loading submission page (fallback)…');
  await page.goto(SUBMISSION_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (!await waitForCheckpoint(page, log, 'main, button')) return false;

  try {
    const voteBtn = page.locator('button:has(span.font-mono)').first();
    if (!await voteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      log('Vote button not found');
      return false;
    }

    if (await voteBtn.isDisabled()) {
      log('Vote button disabled — not logged in');
      return false;
    }

    let apiSuccess = false;
    let apiCount: number | null = null;
    const responsePromise = page.waitForResponse(
      r => r.url().includes('/api/vote') && r.request().method() === 'POST',
      { timeout: 10_000 },
    ).then(async r => {
      const json = await r.json().catch(() => null) as { success?: boolean; voteCount?: number } | null;
      if (json) { apiSuccess = !!json.success; apiCount = json.voteCount ?? null; }
    }).catch(() => {});

    await voteBtn.scrollIntoViewIfNeeded();
    await voteBtn.click();
    log('Clicked vote button…');
    await responsePromise;

    if (apiSuccess) {
      log(`Vote registered ✓ (UI fallback, count: ${apiCount ?? '?'})`);
      return true;
    }

    const classAfter = await voteBtn.getAttribute('class') ?? '';
    if (classAfter.includes('accent-red') || classAfter.includes('text-red')) {
      log('Vote accepted ✓ (button turned red)');
      return true;
    }

    log('Vote may not have registered');
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
    // 0. Clear previous session so signup page renders fresh each vote
    await context.clearCookies();

    // 1+2. Get email and generate name in parallel — both are server-side, no proxy involved
    let mailbox: Awaited<ReturnType<typeof getTempMailbox>>;
    let firstName: string, lastName: string;
    try {
      [mailbox, { firstName, lastName }] = await Promise.all([
        getTempMailbox(log),
        generateEthiopianName(log),
      ]);
    } catch (err) {
      log(`Failed to get temp email or name: ${err}`);
      return { result: 'fail-email', email: '' };
    }
    const email = mailbox.address;

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
      await mainPage.waitForTimeout(1500);

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

    // 6. Ensure we're on creativeaward.ai before voting (needed for API fetch)
    if (!mainPage.url().includes('creativeaward.ai')) {
      await mainPage.goto('https://www.creativeaward.ai/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    }

    // 7. Vote via API (fast) or UI fallback
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
