/**
 * Browser / context factory.
 *
 * LOCAL  (no VERCEL env)  — playwright-extra + puppeteer-stealth + local Chromium
 * VERCEL (VERCEL=1)       — playwright-core  + @sparticuz/chromium (serverless binary)
 *
 * Note: after running `npm install`, do ONE of:
 *   Local dev  → npx playwright install chromium
 *   Vercel     → nothing extra (chromium downloaded at runtime via @sparticuz/chromium)
 */

import path from 'path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { isTorEnabled, getTorProxyUrl } from './tor';

const IS_VERCEL = !!process.env.VERCEL;

// ── Proxy helpers (local only) ─────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = [/example\.com/i, /^http:\/\/user:pass@/i];

function getProxies(): string[] {
  const raw = process.env.PROXIES ?? '';
  return raw.split(',').map(p => p.trim())
    .filter(p => p.length > 0 && !PLACEHOLDER_PATTERNS.some(re => re.test(p)));
}

let proxyIndex = 0;
function nextProxy(): string | undefined {
  const proxies = getProxies();
  if (!proxies.length) return undefined;
  const p = proxies[proxyIndex % proxies.length];
  proxyIndex++;
  console.log(`[browser] proxy: ${p.replace(/:([^@]+)@/, ':***@')}`);
  return p;
}

// ── Common context options ─────────────────────────────────────────────────

function contextOptions(proxyConfig?: { server: string }) {
  return {
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation'],
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  };
}

async function applyStealthScript(context: BrowserContext) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (!(window as any).chrome) {
      (window as any).chrome = { runtime: {} };
    }
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function launchSession(): Promise<BrowserSession> {
  // ── Vercel / serverless path ─────────────────────────────────────────────
  if (IS_VERCEL) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chromiumSparticuz = require('@sparticuz/chromium');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require('playwright-core');

    const executablePath: string = await chromiumSparticuz.executablePath();
    console.log(`[browser] Vercel — chromium at ${path.basename(executablePath)}`);

    const browser: Browser = await chromium.launch({
      args: chromiumSparticuz.args as string[],
      executablePath,
      headless: true,
    });

    const context: BrowserContext = await browser.newContext(contextOptions());
    await applyStealthScript(context);
    const page: Page = await context.newPage();
    return { browser, context, page };
  }

  // ── Local path: playwright-extra + stealth plugin ────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chromium } = require('playwright-extra');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  chromium.use(StealthPlugin());

  const headless = process.env.SHOW_BROWSER !== 'true';
  const slowMo   = parseInt(process.env.SLOW_MO ?? '0', 10);

  let proxyUrl: string | undefined;
  if (isTorEnabled()) {
    proxyUrl = getTorProxyUrl();
    console.log(`[browser] Tor → ${proxyUrl}`);
  } else {
    proxyUrl = nextProxy();
  }

  const proxyConfig = proxyUrl ? { server: proxyUrl } : undefined;

  const browser: Browser = await chromium.launch({
    headless,
    slowMo,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,800',
    ],
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
  });

  const context: BrowserContext = await browser.newContext(contextOptions(proxyConfig));
  await applyStealthScript(context);
  const page: Page = await context.newPage();
  return { browser, context, page };
}

export async function closeSession(session: BrowserSession): Promise<void> {
  try { await session.page.close(); }    catch { /* ignore */ }
  try { await session.context.close(); } catch { /* ignore */ }
  try { await session.browser.close(); } catch { /* ignore */ }
}
