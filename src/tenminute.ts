/**
 * Temporary email via the mail.tm public REST API.
 * https://api.mail.tm
 *
 * All calls are plain Node.js fetch — they run in the server process and are
 * completely independent of the Tor/SOCKS5 proxy that Playwright uses.
 * This means temp email creation and inbox polling work whether or not Tor
 * is enabled, and regardless of which browser context is active.
 *
 * Flow:
 *   1. GET  /domains           → pick a live domain
 *   2. POST /accounts          → create a random address + password
 *   3. POST /token             → obtain a Bearer JWT for that inbox
 *   4. GET  /messages (poll)   → wait until a message arrives
 *   5. GET  /messages/{id}     → read the body, extract the verification link
 */

const BASE = 'https://api.mail.tm';

const VERIFY_KEYWORDS = ['verify', 'confirm', 'activation', 'activate', 'token', 'validate'];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TempMailbox {
  address: string;
  login:   string;
  domain:  string;
  token:   string; // Bearer JWT for this inbox
}

interface HydraPage<T> { 'hydra:member': T[] }
interface DomainItem   { domain: string }
interface MsgItem      { id: string; subject: string }
interface MsgDetail    { id: string; subject: string; html: string[]; text: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomStr(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function mailtmFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...opts.headers },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`mail.tm ${path}: HTTP ${resp.status} — ${body.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getTempMailbox(log: (m: string) => void): Promise<TempMailbox> {
  log('Creating temp email via mail.tm…');

  const domainsPage = await mailtmFetch<HydraPage<DomainItem>>('/domains?page=1');
  const domains = domainsPage['hydra:member'];
  if (!domains?.length) throw new Error('mail.tm returned no available domains');
  const domain = domains[Math.floor(Math.random() * domains.length)].domain;

  // Timestamp prefix (base-36, always increasing) + random suffix → guaranteed unique
  const address  = `${Date.now().toString(36)}${randomStr(6)}@${domain}`;
  const password = randomStr(20);

  await mailtmFetch<unknown>('/accounts', {
    method: 'POST',
    body:   JSON.stringify({ address, password }),
  });

  const { token } = await mailtmFetch<{ token: string }>('/token', {
    method: 'POST',
    body:   JSON.stringify({ address, password }),
  });

  const login = address.split('@')[0];
  log(`Temp email: ${address}`);
  return { address, login, domain, token };
}

export async function waitForVerificationLink(
  mailbox: TempMailbox,
  log: (m: string) => void,
  timeoutMs = 120_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const authHeader = { Authorization: `Bearer ${mailbox.token}` };
  log('Polling inbox for verification email…');

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));

    let msgs: MsgItem[];
    try {
      const page = await mailtmFetch<HydraPage<MsgItem>>(
        '/messages?page=1', { headers: authHeader }
      );
      msgs = page['hydra:member'] ?? [];
    } catch (err) {
      log(`Inbox poll error: ${err} — retrying…`);
      continue;
    }

    if (msgs.length === 0) { log('No messages yet…'); continue; }

    log(`Inbox: ${msgs.length} message(s) — reading…`);
    for (const meta of msgs) {
      const link = await readAndExtractLink(meta.id, authHeader, log);
      if (link) return link;
    }
    log('No verification link found yet — retrying…');
  }

  log('Timed out waiting for verification email.');
  return null;
}

// ── Internals ─────────────────────────────────────────────────────────────────

async function readAndExtractLink(
  id: string,
  authHeader: Record<string, string>,
  log: (m: string) => void,
): Promise<string | null> {
  try {
    const msg = await mailtmFetch<MsgDetail>(`/messages/${id}`, { headers: authHeader });
    log(`Email subject: "${msg.subject}"`);

    const bodies: string[] = [
      ...(Array.isArray(msg.html) ? msg.html : [msg.html ?? '']),
      msg.text ?? '',
    ].filter(Boolean);

    for (const content of bodies) {
      // href="..." attributes
      for (const m of content.matchAll(/href=["']([^"']+)["']/gi)) {
        const href = m[1];
        if (VERIFY_KEYWORDS.some(k => href.toLowerCase().includes(k))) {
          log(`Verification link: ${href.slice(0, 90)}`);
          return href;
        }
      }
      // Bare https?:// URLs
      for (const m of content.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
        const url = m[0].replace(/[.,;)\]]+$/, '');
        if (VERIFY_KEYWORDS.some(k => url.toLowerCase().includes(k))) {
          log(`Verification link (plain): ${url.slice(0, 90)}`);
          return url;
        }
      }
    }
  } catch (err) {
    log(`Read message error: ${err}`);
  }
  return null;
}
