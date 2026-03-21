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
  await page.waitForTimeout(1000);

  try {
    const fullName = `${firstName} ${lastName}`.trim();

    // Name field — try single-field then split-field patterns
    const nameFilled = await (async () => {
      for (const sel of [
        'input[name="name"]', 'input[name="fullName"]', 'input[name="full_name"]',
        'input[id="name"]', 'input[placeholder*="full name" i]',
        'input[placeholder*="your name" i]', 'input[placeholder*="name" i]',
      ]) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
          await el.fill(fullName);
          return true;
        }
      }
      const firstEl = page.locator(
        'input[name="firstName"], input[name="first_name"], input[id="firstName"], input[placeholder*="first" i]'
      ).first();
      if (await firstEl.isVisible({ timeout: 1500 }).catch(() => false)) {
        await firstEl.fill(firstName);
        const lastEl = page.locator(
          'input[name="lastName"], input[name="last_name"], input[id="lastName"], input[placeholder*="last" i]'
        ).first();
        if (await lastEl.isVisible({ timeout: 1000 }).catch(() => false)) await lastEl.fill(lastName);
        return true;
      }
      return false;
    })();

    if (!nameFilled) {
      await snap(page, 'signup-no-name');
      log('Name field not found — screenshot saved');
      return 'fail';
    }

    await page.locator('input[type="email"], input[name="email"]').first().fill(email);
    await page.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD);

    const confirm = page.locator(
      'input[name="confirmPassword"], input[name="passwordConfirmation"], input[placeholder*="confirm" i]'
    ).first();
    if (await confirm.isVisible({ timeout: 1500 })) await confirm.fill(PASSWORD);

    await page.waitForTimeout(400);
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.waitForTimeout(3000);

    const url  = page.url();
    const body = (await page.textContent('body') ?? '').toLowerCase();

    if (body.includes('already') || body.includes('exists') || body.includes('registered')) {
      log('Already registered — proceeding to login');
      return 'already';
    }

    // Email verification required
    if (
      body.includes('verify') || body.includes('check your email') ||
      body.includes('check your inbox') || body.includes('confirmation') ||
      body.includes('sent to') || url.includes('verify') || url.includes('check-email')
    ) {
      log('Email verification required — will check inbox');
      return 'verify-needed';
    }

    if (!url.includes('/signup')) {
      log(`Signup OK → ${url}`);
      return 'ok';
    }

    await snap(page, 'signup-fail');
    log(`Signup may have failed — URL: ${url}`);
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
  await page.waitForTimeout(800);

  try {
    await page.locator('input[type="email"], input[name="email"]').first().fill(email);
    await page.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD);
    await page.waitForTimeout(300);
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.waitForTimeout(3000);

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
  await page.goto(SUBMISSION_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2000);

  try {
    const sels = [
      'button[aria-label*="vote" i]',
      'button[aria-label*="like" i]',
      'button[aria-label*="heart" i]',
      '[class*="vote"]:not(span):not(div):not(p)',
      '[class*="like"]:not(span):not(div):not(p)',
      'button:has(svg)',
      '[data-testid*="vote"]',
      '[data-testid*="like"]',
    ];

    for (const sel of sels) {
      try {
        const els = page.locator(sel);
        const cnt = await els.count();
        for (let i = 0; i < cnt; i++) {
          const el = els.nth(i);
          if (await el.isVisible({ timeout: 1000 })) {
            await el.scrollIntoViewIfNeeded();
            await el.click();
            await page.waitForTimeout(1500);
            log(`Voted ✓  (${sel})`);
            return true;
          }
        }
      } catch { /* try next */ }
    }

    await snap(page, 'vote-fail');
    const btns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b =>
        `"${b.textContent?.trim().slice(0, 30)}" aria="${b.getAttribute('aria-label') ?? ''}" class="${b.className.slice(0, 50)}"`
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
      await mainPage.waitForTimeout(2000);
      log('Email verified ✓');
    }

    // 5. Log in
    const loggedIn = await login(mainPage, email, log);
    if (!loggedIn) return { result: 'fail-login', email };

    // 6. Vote
    const voted = await vote(mainPage, log);
    return { result: voted ? 'success' : 'fail-vote', email };
  } catch (err) {
    log(`Unhandled error: ${err}`);
    return { result: 'error', email: '' };
  } finally {
    for (const p of pages) await p.close().catch(() => undefined);
  }
}
