/**
 * Tor integration helpers.
 *
 * Requirements (Windows) — Tor Browser (easiest):
 *   1. Download Tor Browser from https://www.torproject.org/download/
 *   2. Launch it and let it connect (leave it open while the bot runs)
 *   3. Enable the control port so the bot can rotate IPs:
 *      - Open: <TorBrowser>\Browser\TorBrowser\Data\Tor\torrc
 *      - Add these two lines and save:
 *          ControlPort 9151
 *          CookieAuthentication 1
 *      - Restart Tor Browser
 *   4. .env is already configured (TOR_ENABLED=true, ports 9150/9151)
 */

import net from 'net';
import fs  from 'fs';
import os  from 'os';
import path from 'path';

type Logger = (msg: string) => void;
const noop: Logger = () => {};

export function isTorEnabled(): boolean {
  return process.env.TOR_ENABLED === 'true';
}

export function getTorProxyUrl(): string {
  const port = process.env.TOR_PROXY_PORT ?? '9150';
  return `socks5://127.0.0.1:${port}`;
}

// ── Cookie-file authentication ─────────────────────────────────────────────

const COOKIE_NAME = 'control_auth_cookie';
const TB_SUFFIX   = ['Browser', 'TorBrowser', 'Data', 'Tor', COOKIE_NAME];

function readTorCookieHex(log: Logger): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Desktop', 'Tor Browser', ...TB_SUFFIX),
    path.join(home, 'Downloads', 'Tor Browser', ...TB_SUFFIX),
    // Common Windows "Documents" install
    path.join(home, 'Documents', 'Tor Browser', ...TB_SUFFIX),
    // Program-Files–style installs
    'C:\\Tor Browser\\Browser\\TorBrowser\\Data\\Tor\\' + COOKIE_NAME,
    'C:\\Program Files\\Tor Browser\\Browser\\TorBrowser\\Data\\Tor\\' + COOKIE_NAME,
    'C:\\Program Files (x86)\\Tor Browser\\Browser\\TorBrowser\\Data\\Tor\\' + COOKIE_NAME,
    // OneDrive–redirected Desktop
    path.join(home, 'OneDrive', 'Desktop', 'Tor Browser', ...TB_SUFFIX),
    // Standalone tor daemon (choco / scoop)
    path.join(home, 'AppData', 'Roaming', 'tor', COOKIE_NAME),
    path.join(home, 'AppData', 'Local', 'tor', COOKIE_NAME),
    // Explicit override
    process.env.TOR_COOKIE_FILE ?? '',
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const cookie = fs.readFileSync(p);
        log(`[tor] Cookie file found: ${p}`);
        return cookie.toString('hex');
      }
    } catch { /* try next */ }
  }

  log('[tor] ⚠ No cookie file found — tried: ' + candidates.map(c => path.basename(path.dirname(c))).join(', '));
  return null;
}

// ── NEWNYM — request a fresh exit node ────────────────────────────────────

export async function rotateTorIP(log: Logger = noop): Promise<boolean> {
  const controlPort = parseInt(process.env.TOR_CONTROL_PORT ?? '9151', 10);
  const password    = process.env.TOR_CONTROL_PASSWORD?.trim() ?? '';

  const cookieHex = password ? null : readTorCookieHex(log);
  const authLine  = cookieHex
    ? `AUTHENTICATE ${cookieHex}\r\n`
    : password
      ? `AUTHENTICATE "${password}"\r\n`
      : 'AUTHENTICATE\r\n';

  log(`[tor] Sending NEWNYM to 127.0.0.1:${controlPort} (auth=${cookieHex ? 'cookie' : password ? 'password' : 'none'})`);

  return new Promise((resolve) => {
    const sock = net.createConnection({ port: controlPort, host: '127.0.0.1' }, () => {
      sock.write(authLine);
      sock.write('SIGNAL NEWNYM\r\n');
      sock.write('QUIT\r\n');
    });

    let response = '';
    sock.on('data', (d) => { response += d.toString(); });
    sock.on('close', () => {
      const trimmed = response.trim().replace(/\r?\n/g, ' | ');
      if (response.includes('250')) {
        log(`[tor] New circuit requested ✓  (${trimmed.slice(0, 100)})`);
        resolve(true);
      } else {
        log(`[tor] ⚠ NEWNYM failed — response: ${trimmed.slice(0, 150)}`);
        resolve(false);
      }
    });
    sock.on('error', (err) => {
      if (err.message.includes('ECONNREFUSED')) {
        log('[tor] ⚠ Control port refused — is Tor running with ControlPort 9151?');
      } else {
        log(`[tor] ⚠ Rotate error: ${err.message}`);
      }
      resolve(false);
    });
    setTimeout(() => { sock.destroy(); resolve(false); }, 5_000);
  });
}

/**
 * After NEWNYM, wait for Tor to build a fresh circuit.
 * 10s minimum; 15s is safer for exit-node diversity.
 */
export async function waitForNewCircuit(ms = 15_000): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch our current exit IP through the Tor SOCKS proxy. */
export async function checkTorIP(log: Logger = noop): Promise<string | null> {
  try {
    const resp = await fetch('https://api.ipify.org?format=text', { signal: AbortSignal.timeout(10_000) });
    const ip = (await resp.text()).trim();
    log(`[tor] Current exit IP: ${ip}`);
    return ip;
  } catch {
    log('[tor] Could not determine exit IP');
    return null;
  }
}
