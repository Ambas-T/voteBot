/**
 * Core vote logic.
 *
 * Flow per email:
 *   1. Sign up on creativeaward.ai with the provided email
 *   2. Log in  (site may auto-login after signup, or we try explicitly)
 *   3. Vote / Like on the submission page
 *
 * No email-verification step — the caller supplies real emails they own.
 */

import path from 'path';
import fs from 'fs';
import type { Page } from 'playwright';

const SIGNUP_URL     = 'https://www.creativeaward.ai/signup?callbackUrl=%2Fmy-submissions';
const LOGIN_URL      = 'https://www.creativeaward.ai/login?callbackUrl=%2Fmy-submissions';
const SUBMISSION_URL = 'https://www.creativeaward.ai/submission/e2efa077-c740-456d-89ef-915473b3961d';

const PASSWORD = process.env.ACCOUNT_PASSWORD?.replace(/^"|"$/g, '') ?? 'ta123#$55';

const SHOT_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

// ── Random name pool ────────────────────────────────────────────────────────

const FIRST_NAMES = [
  'Abebe','Tigist','Haile','Mekdes','Dawit','Selamawit','Yonas','Hiwot',
  'Samuel','Bethlehem','Daniel','Rahel','Biruk','Liya','Solomon','Meron',
  'Yared','Tsion','Nahom','Eden','Kidus','Sara','Abel','Martha','Natnael',
  'Fiker','Mihret','Robel','Beza','Eyob',
];

const LAST_NAMES = [
  'Tadesse','Bekele','Negash','Haile','Girma','Tesfaye','Alemu','Worku',
  'Mekonnen','Gebre','Ayele','Tekle','Desta','Woldemariam','Kebede','Assefa',
  'Tilahun','Mulugeta','Getachew','Lemma',
];

function randomName() {
  const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
  return { firstName: pick(FIRST_NAMES), lastName: pick(LAST_NAMES) };
}

// ── Screenshot helper ───────────────────────────────────────────────────────

async function snap(page: Page, label: string) {
  try {
    await page.screenshot({ path: path.join(SHOT_DIR, `${Date.now()}-${label}.png`) });
  } catch { /* ignore */ }
}

// ── Sign up ─────────────────────────────────────────────────────────────────

async function signup(
  page: Page,
  email: string,
  firstName: string,
  lastName: string,
  log: (m: string) => void,
): Promise<'ok' | 'already' | 'fail'> {
  log(`Signing up: ${email}`);
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
    await page.waitForTimeout(2500);

    const url  = page.url();
    const body = (await page.textContent('body') ?? '').toLowerCase();

    if (body.includes('already') || body.includes('exists') || body.includes('registered')) {
      log('Already registered — skipping to login');
      return 'already';
    }
    if (!url.includes('/signup') || body.includes('verify') || body.includes('check your email')) {
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

// ── Log in ─────────────────────────────────────────────────────────────────

async function login(page: Page, email: string, log: (m: string) => void): Promise<boolean> {
  // If we're already logged in after signup, skip
  if (!page.url().includes('/login') && !page.url().includes('/signup')) {
    log('Already logged in after signup ✓');
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
    await page.waitForTimeout(2500);

    if (page.url().includes('/login')) {
      await snap(page, 'login-fail');
      log('Login failed — still on login page (email may need verification first)');
      return false;
    }
    log('Logged in ✓');
    return true;
  } catch (err) {
    log(`Login error: ${err}`);
    return false;
  }
}

// ── Vote ───────────────────────────────────────────────────────────────────

async function vote(page: Page, log: (m: string) => void): Promise<boolean> {
  log('Navigating to submission…');
  await page.goto(SUBMISSION_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1500);

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

// ── Public API ─────────────────────────────────────────────────────────────

export type VoteResult = 'success' | 'fail-signup' | 'fail-login' | 'fail-vote' | 'error';

/**
 * Run the full flow for a single provided email address.
 * Uses the already-opened `page` (launched by the caller with Tor proxy).
 */
export async function runVoteForEmail(
  page: Page,
  email: string,
  log: (m: string) => void,
): Promise<VoteResult> {
  try {
    const { firstName, lastName } = randomName();

    const signupResult = await signup(page, email, firstName, lastName, log);
    if (signupResult === 'fail') return 'fail-signup';

    const loggedIn = await login(page, email, log);
    if (!loggedIn) return 'fail-login';

    const voted = await vote(page, log);
    return voted ? 'success' : 'fail-vote';
  } catch (err) {
    log(`Unhandled error: ${err}`);
    return 'error';
  }
}
