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

type PlaywrightProxy = { server: string; username?: string; password?: string };

function parseProxy(raw: string): PlaywrightProxy {
  // http://user:pass@host:port  →  split credentials out
  const m = raw.match(/^(https?):\/\/([^:@]+):([^@]+)@(.+)$/);
  if (m) {
    return { server: `${m[1]}://${m[4]}`, username: m[2], password: m[3] };
  }
  // host:port:user:pass  (file format)
  const parts = raw.split(':');
  if (parts.length === 4) {
    return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
  }
  return { server: raw };
}

let proxyIndex = 0;
function nextProxy(): PlaywrightProxy | undefined {
  const proxies = getProxies();
  if (!proxies.length) return undefined;
  const raw = proxies[proxyIndex % proxies.length];
  proxyIndex++;
  const p = parseProxy(raw);
  console.log(`[browser] proxy: ${p.server} (user: ${p.username?.slice(0, 8)}…)`);
  return p;
}

// ── Common context options ─────────────────────────────────────────────────

function contextOptions(proxyConfig?: PlaywrightProxy) {
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

export async function launchSession(opts?: { headless?: boolean }): Promise<BrowserSession> {
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

  // ── Local path: plain playwright (parallel-safe, no CDP shim crashes) ──────
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chromium } = require('playwright');

  const headless =
    opts?.headless !== undefined ? opts.headless : process.env.SHOW_BROWSER !== 'true';
  const slowMo = parseInt(process.env.SLOW_MO ?? '0', 10);

  const proxyMode = (process.env.PROXY_MODE ?? '').trim().toLowerCase()
    || (isTorEnabled() ? 'tor' : 'none');

  let proxyConfig: PlaywrightProxy | undefined;
  if (proxyMode === 'tor') {
    const torUrl = getTorProxyUrl();
    console.log(`[browser] Tor → ${torUrl}`);
    proxyConfig = { server: torUrl };
  } else if (proxyMode === 'proxies') {
    proxyConfig = nextProxy();
  }

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
    ...(proxyConfig ? { proxy: { server: proxyConfig.server } } : {}),
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
