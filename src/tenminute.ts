/**
 * Temporary email via the Guerrilla Mail public API.
 * https://www.guerrillamail.com  (API compatible with 10minutemail concept)
 *
 * All calls are plain Node.js fetch — completely independent of the Tor/SOCKS5
 * proxy used by Playwright.  The browser context only ever opens creativeaward.ai.
 *
 * Flow:
 *   1. GET get_email_address  → fresh address + session token
 *   2. GET check_email        → poll inbox (every 5 s)
 *   3. GET fetch_email        → read body, extract verification link
 */

const API = 'https://api.guerrillamail.com/ajax.php';

const VERIFY_KEYWORDS = ['verify', 'confirm', 'activation', 'activate', 'token', 'validate'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept':     'application/json',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TempMailbox {
  address:  string;
  login:    string;
  domain:   string;
  token:    string; // sid_token — must be passed in every subsequent call
}

interface SessionResp  { email_addr: string; sid_token: string }
interface InboxResp    { list: MailMeta[]; count: number }
interface MailMeta     { mail_id: string; mail_subject: string }
interface MailBodyResp { mail_id: string; mail_subject: string; mail_body: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

async function gm<T>(params: Record<string, string>): Promise<T> {
  const qs  = new URLSearchParams(params).toString();
  const resp = await fetch(`${API}?${qs}`, { headers: HEADERS });
  if (!resp.ok) throw new Error(`guerrillamail ${params['f']}: HTTP ${resp.status}`);
  return resp.json() as Promise<T>;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getTempMailbox(log: (m: string) => void): Promise<TempMailbox> {
  log('Getting temp email…');

  // Get a session first
  const data = await gm<SessionResp>({ f: 'get_email_address' });
  if (!data.sid_token) throw new Error('No session token from guerrillamail');

  // Force a unique username so we never collide with a previously-registered address
  const unique = 'vb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const updated = await gm<SessionResp>({
    f: 'set_email_user',
    email_user: unique,
    sid_token: data.sid_token,
  });

  const address = (updated.email_addr ?? '').trim();
  if (!address.includes('@')) {
    throw new Error(`Unexpected response: ${JSON.stringify(updated)}`);
  }

  const [login, domain] = address.split('@');
  log(`Temp email: ${address}`);
  return { address, login, domain, token: data.sid_token };
}

export async function waitForVerificationLink(
  mailbox: TempMailbox,
  log: (m: string) => void,
  timeoutMs = 120_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  log('Polling inbox for verification email…');

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));

    let inbox: InboxResp;
    try {
      inbox = await gm<InboxResp>({ f: 'check_email', seq: '0', sid_token: mailbox.token });
    } catch (err) {
      log(`Inbox poll error: ${err} — retrying…`);
      continue;
    }

    const msgs = inbox.list ?? [];
    if (msgs.length === 0) { log('No messages yet…'); continue; }

    log(`Inbox: ${msgs.length} message(s) — reading…`);

    for (const meta of msgs) {
      const link = await fetchAndExtractLink(meta.mail_id, mailbox.token, log);
      if (link) return link;
    }

    log('No verification link found yet — retrying…');
  }

  log('Timed out waiting for verification email.');
  return null;
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function fetchAndExtractLink(
  mailId: string,
  token:  string,
  log:    (m: string) => void,
): Promise<string | null> {
  try {
    const msg = await gm<MailBodyResp>({ f: 'fetch_email', email_id: mailId, sid_token: token });
    log(`Email subject: "${msg.mail_subject}"`);

    const body = msg.mail_body ?? '';

    // href="..." attributes
    for (const m of body.matchAll(/href=["']([^"']+)["']/gi)) {
      const href = m[1];
      if (VERIFY_KEYWORDS.some(k => href.toLowerCase().includes(k))) {
        log(`Verification link: ${href.slice(0, 90)}`);
        return href;
      }
    }
    // Bare https?:// URLs
    for (const m of body.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      const url = m[0].replace(/[.,;)\]]+$/, '');
      if (VERIFY_KEYWORDS.some(k => url.toLowerCase().includes(k))) {
        log(`Verification link (plain): ${url.slice(0, 90)}`);
        return url;
      }
    }
  } catch (err) {
    log(`Fetch email error: ${err}`);
  }
  return null;
}
