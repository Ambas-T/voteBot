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

export function isTorEnabled(): boolean {
  return process.env.TOR_ENABLED === 'true';
}

export function getTorProxyUrl(): string {
  const port = process.env.TOR_PROXY_PORT ?? '9150';
  return `socks5://127.0.0.1:${port}`;
}

// ── Cookie-file authentication ─────────────────────────────────────────────

/**
 * Read the Tor cookie file and return it as a hex string for AUTHENTICATE.
 * Tor Browser writes it to one of several known locations on Windows.
 */
function readTorCookieHex(): string | null {
  const candidates = [
    // Tor Browser (standard install)
    path.join(os.homedir(), 'Desktop', 'Tor Browser', 'Browser', 'TorBrowser', 'Data', 'Tor', 'control_auth_cookie'),
    path.join(os.homedir(), 'Downloads', 'Tor Browser', 'Browser', 'TorBrowser', 'Data', 'Tor', 'control_auth_cookie'),
    // AppData roaming (some versions)
    path.join(os.homedir(), 'AppData', 'Roaming', 'tor', 'control_auth_cookie'),
    // Explicit override via env
    process.env.TOR_COOKIE_FILE ?? '',
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const cookie = fs.readFileSync(p);
        console.log(`[tor] Using cookie file: ${p}`);
        return cookie.toString('hex');
      }
    } catch { /* try next */ }
  }
  return null;
}

// ── NEWNYM — request a fresh exit node ────────────────────────────────────

export async function rotateTorIP(): Promise<void> {
  const controlPort = parseInt(process.env.TOR_CONTROL_PORT ?? '9151', 10);
  const password    = process.env.TOR_CONTROL_PASSWORD?.trim() ?? '';

  // Prefer cookie auth; fall back to password auth; last resort: no-auth
  const cookieHex = password ? null : readTorCookieHex();
  const authLine  = cookieHex
    ? `AUTHENTICATE ${cookieHex}\r\n`
    : password
      ? `AUTHENTICATE "${password}"\r\n`
      : 'AUTHENTICATE\r\n';

  return new Promise((resolve) => {
    const sock = net.createConnection({ port: controlPort, host: '127.0.0.1' }, () => {
      sock.write(authLine);
      sock.write('SIGNAL NEWNYM\r\n');
      sock.write('QUIT\r\n');
    });

    let response = '';
    sock.on('data', (d) => { response += d.toString(); });
    sock.on('close', () => {
      if (response.includes('250')) {
        console.log('[tor] New circuit requested ✓');
      } else {
        console.warn('[tor] Unexpected control response:', response.trim().slice(0, 120));
      }
      resolve();
    });
    sock.on('error', (err) => {
      if (err.message.includes('ECONNREFUSED')) {
        console.warn('[tor] Control port not reachable — add "ControlPort 9151" to torrc and restart Tor Browser');
      } else {
        console.warn(`[tor] Rotate error: ${err.message}`);
      }
      resolve(); // always non-fatal
    });
    setTimeout(() => { sock.destroy(); resolve(); }, 5_000);
  });
}

/**
 * After NEWNYM, wait for Tor to build a fresh circuit.
 * Microsoft exit-node blocks make 10 s the minimum; 15 s is safer.
 */
export async function waitForNewCircuit(ms = 15_000): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
