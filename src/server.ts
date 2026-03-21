/**
 * VoteBot UI server.
 *
 * Endpoints
 *   GET  /api/events       — Server-Sent Events (logs + status + stats)
 *   POST /api/vote/start   — Start voting  { emails: string[] }
 *   POST /api/vote/stop    — Abort a running session
 *   GET  /api/status       — Current status JSON
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import type { Request, Response } from 'express';
import { launchSession } from './browser';
import { isTorEnabled, rotateTorIP, waitForNewCircuit } from './tor';
import { runVoteForEmail } from './voter';

const app  = express();
const PORT = parseInt(process.env.UI_PORT ?? '3000', 10);

// Rotate Tor every N emails (default 2)
const EMAILS_PER_SESSION = parseInt(process.env.EMAILS_PER_SESSION ?? '2', 10);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(process.cwd(), 'ui')));

// ── SSE ────────────────────────────────────────────────────────────────────

const sseClients: Response[] = [];

function broadcast(type: string, payload: object) {
  const data = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  sseClients.forEach(c => { try { c.write(data); } catch { /* ignore */ } });
}

function broadcastLog(msg: string)                    { broadcast('log',    { message: msg }); }
function broadcastStatus(status: string)              { broadcast('status', { status }); }
function broadcastStats(done: number, total: number, success: number, failed: number) {
  broadcast('stats', { done, total, success, failed });
}

app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);

  res.write(`data: ${JSON.stringify({ type: 'status', status: state.status })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'stats', done: state.done, total: state.total, success: state.success, failed: state.failed })}\n\n`);

  req.on('close', () => {
    const i = sseClients.indexOf(res);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  status:  'idle' as 'idle' | 'voting',
  aborted: false,
  done:    0,
  total:   0,
  success: 0,
  failed:  0,
};

// ── Endpoints ──────────────────────────────────────────────────────────────

app.post('/api/vote/start', async (req: Request, res: Response) => {
  if (state.status !== 'idle') {
    res.json({ ok: false, error: 'Already running — stop first' });
    return;
  }

  const emails: string[] = (req.body?.emails ?? [])
    .map((e: string) => e.trim())
    .filter((e: string) => e.includes('@'));

  if (emails.length === 0) {
    res.json({ ok: false, error: 'No valid emails provided' });
    return;
  }

  state.status  = 'voting';
  state.aborted = false;
  state.done    = 0;
  state.total   = emails.length;
  state.success = 0;
  state.failed  = 0;

  broadcastStatus('voting');
  broadcastStats(0, emails.length, 0, 0);
  broadcastLog(`── Starting ${emails.length} vote(s) ──`);

  res.json({ ok: true, count: emails.length });

  // ── Background loop ──────────────────────────────────────────────────────
  (async () => {
    let idx = 0;

    while (idx < emails.length && !state.aborted) {
      // Open a new Tor browser session for up to EMAILS_PER_SESSION emails
      const batch = emails.slice(idx, idx + EMAILS_PER_SESSION);
      broadcastLog(`\n━━ Opening Tor browser for ${batch.length} email(s)…`);

      let browser: Awaited<ReturnType<typeof launchSession>>['browser'] | null = null;
      let context: Awaited<ReturnType<typeof launchSession>>['context'] | null = null;

      try {
        const session = await launchSession();
        browser = session.browser;
        context = session.context;
        let page = session.page;

        for (let b = 0; b < batch.length && !state.aborted; b++) {
          const email = batch[b];
          broadcastLog(`── [${idx + b + 1}/${emails.length}] ${email}`);

          // Each email gets a fresh page in the same session
          if (b > 0) {
            page = await context.newPage();
          }

          const result = await runVoteForEmail(page, email, broadcastLog);

          state.done++;
          if (result === 'success') {
            state.success++;
            broadcastLog(`✅ [${state.done}/${state.total}] Vote succeeded — ${email}`);
          } else {
            state.failed++;
            broadcastLog(`❌ [${state.done}/${state.total}] Failed (${result}) — ${email}`);
          }
          broadcastStats(state.done, state.total, state.success, state.failed);
        }
      } catch (err) {
        broadcastLog(`❌ Session error: ${err}`);
        const skipped = batch.length - (state.done - idx);
        state.done   += skipped;
        state.failed += skipped;
        broadcastStats(state.done, state.total, state.success, state.failed);
      } finally {
        if (context) await context.close().catch(() => undefined);
        if (browser) await browser.close().catch(() => undefined);
        broadcastLog('Browser closed.');
      }

      idx += batch.length;

      // Rotate Tor before the next batch
      if (idx < emails.length && !state.aborted) {
        if (isTorEnabled()) {
          broadcastLog('[tor] Rotating circuit…');
          await rotateTorIP();
          await waitForNewCircuit(15_000);
          broadcastLog('[tor] New circuit ready.');
        } else {
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }

    if (state.aborted) broadcastLog('🛑 Stopped by user.');
    broadcastLog(`\n══ Done ══  ✅ ${state.success} succeeded   ❌ ${state.failed} failed`);
    state.status = 'idle';
    broadcastStatus('idle');
    broadcastStats(state.done, state.total, state.success, state.failed);
  })().catch(err => {
    broadcastLog(`Fatal: ${err}`);
    state.status = 'idle';
    broadcastStatus('idle');
  });
});

app.post('/api/vote/stop', (_req: Request, res: Response) => {
  state.aborted = true;
  broadcastLog('🛑 Stop requested…');
  res.json({ ok: true });
});

app.get('/api/status', (_req: Request, res: Response) => {
  res.json(state);
});

// ── Start (local only — Vercel invokes the exported app directly) ──────────

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════╗`);
    console.log(`║  VoteBot UI → http://localhost:${PORT}  ║`);
    console.log(`╚══════════════════════════════════════╝\n`);
  });
}

export default app;
