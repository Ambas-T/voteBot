/**
 * VoteBot UI server.
 *
 * Endpoints
 *   GET  /api/events            — Server-Sent Events (logs + status + stats)
 *   POST /api/vote/start        — Start voting  { count: number }
 *   POST /api/vote/stop         — Abort a running session
 *   POST /api/manual/open-browser — Local only: visible browser on submission URL
 *   GET  /api/status            — Current status JSON
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import type { Request, Response } from 'express';
import { launchSession } from './browser';
import { isTorEnabled, rotateTorIP, waitForNewCircuit } from './tor';
import { runVoteSession, SUBMISSION_URL } from './voter';

const app  = express();
const PORT = parseInt(process.env.UI_PORT ?? '3000', 10);

const VOTES_PER_SESSION = parseInt(process.env.VOTES_PER_SESSION ?? '3', 10);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(process.cwd(), 'ui')));

// ── SSE ────────────────────────────────────────────────────────────────────

const sseClients: Response[] = [];

function broadcast(type: string, payload: object) {
  const data = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  sseClients.forEach(c => { try { c.write(data); } catch { /* ignore */ } });
}

function broadcastLog(msg: string) {
  console.log(msg);
  broadcast('log', { message: msg });
}
function broadcastStatus(status: string)              { broadcast('status', { status }); }
function broadcastStats(done: number, total: number, success: number, failed: number) {
  broadcast('stats', { done, total, success, failed });
}
function broadcastVoteResult(email: string, result: string, success: boolean) {
  broadcast('vote_result', { email, result, success });
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

let manualBrowserOpen = false;

// ── Endpoints ──────────────────────────────────────────────────────────────

app.post('/api/vote/start', async (req: Request, res: Response) => {
  if (state.status !== 'idle') {
    res.json({ ok: false, error: 'Already running — stop first' });
    return;
  }
  if (manualBrowserOpen) {
    res.json({ ok: false, error: 'Close the manual browser window first' });
    return;
  }

  const rawCount = parseInt(String(req.body?.count ?? '0'), 10);
  const count    = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 0;

  if (count === 0) {
    res.json({ ok: false, error: 'Provide count (1+)' });
    return;
  }

  state.status  = 'voting';
  state.aborted = false;
  state.done    = 0;
  state.total   = count;
  state.success = 0;
  state.failed  = 0;

  broadcastStatus('voting');
  broadcastStats(0, count, 0, 0);
  broadcastLog(`── Starting ${count} vote session(s) ──`);

  res.json({ ok: true, count });

  // ── Background loop ──────────────────────────────────────────────────────
  (async () => {
    let successInBatch = 0;
    let consecutiveFails = 0;

    const usingTor = isTorEnabled()
      || (process.env.PROXY_MODE ?? '').trim().toLowerCase() === 'tor';

    async function rotateCircuit() {
      if (usingTor) {
        broadcastLog('[tor] Rotating circuit…');
        await rotateTorIP();
        await waitForNewCircuit(10_000);
        broadcastLog('[tor] New circuit ready.');
      } else {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    while (state.done < count && !state.aborted) {
      const remaining = count - state.done;
      const batchSize = Math.min(VOTES_PER_SESSION, remaining);
      broadcastLog(`\n━━ Opening browser for ${batchSize} vote(s)…`);

      let browser: Awaited<ReturnType<typeof launchSession>>['browser'] | null = null;
      let context: Awaited<ReturnType<typeof launchSession>>['context'] | null = null;
      successInBatch = 0;

      try {
        const session = await launchSession();
        browser = session.browser;
        context = session.context;
        await session.page.close().catch(() => undefined);

        for (let b = 0; b < batchSize && !state.aborted; b++) {
          broadcastLog(`── [${state.done + 1}/${count}] Starting vote session…`);

          const { result, email } = await runVoteSession(context, broadcastLog);

          state.done++;
          if (result === 'success') {
            state.success++;
            successInBatch++;
            consecutiveFails = 0;
            broadcastLog(`✅ [${state.done}/${state.total}] Vote succeeded${email ? ` — ${email}` : ''}`);
          } else {
            state.failed++;
            consecutiveFails++;
            broadcastLog(`❌ [${state.done}/${state.total}] Failed (${result})${email ? ` — ${email}` : ''}`);

            if (consecutiveFails >= 2) {
              broadcastLog('2 consecutive failures — rotating circuit');
              break;
            }
          }
          broadcastVoteResult(email, result, result === 'success');
          broadcastStats(state.done, state.total, state.success, state.failed);
        }
      } catch (err) {
        broadcastLog(`❌ Session error: ${err}`);
        state.done++;
        state.failed++;
        consecutiveFails++;
        broadcastStats(state.done, state.total, state.success, state.failed);
      } finally {
        if (context) await context.close().catch(() => undefined);
        if (browser) await browser.close().catch(() => undefined);
        broadcastLog('Browser closed.');
      }

      // Rotate Tor circuit before the next batch
      if (state.done < count && !state.aborted) {
        await rotateCircuit();
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

/** Local only: open a visible Chromium window on the submission page for manual sign-in / vote. */
app.post('/api/manual/open-browser', async (_req: Request, res: Response) => {
  if (process.env.VERCEL) {
    res.json({ ok: false, error: 'Manual browser is only available when running the app locally.' });
    return;
  }
  if (state.status !== 'idle') {
    res.json({ ok: false, error: 'Stop automated voting first.' });
    return;
  }
  if (manualBrowserOpen) {
    res.json({ ok: false, error: 'A manual browser window is already open.' });
    return;
  }

  manualBrowserOpen = true;
  res.json({ ok: true });
  broadcastLog('Manual browser: opening submission page — sign in, vote, then close the window.');

  (async () => {
    let browser: Awaited<ReturnType<typeof launchSession>>['browser'] | null = null;
    let context: Awaited<ReturnType<typeof launchSession>>['context'] | null = null;
    try {
      const session = await launchSession({ headless: false });
      browser = session.browser;
      context = session.context;
      const { page } = session;
      await page.goto(SUBMISSION_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await new Promise<void>(resolve => {
        browser!.once('disconnected', () => resolve());
      });
    } catch (err) {
      broadcastLog(`Manual browser error: ${err}`);
    } finally {
      manualBrowserOpen = false;
      if (context) await context.close().catch(() => undefined);
      if (browser) await browser.close().catch(() => undefined);
      broadcastLog('Manual browser closed.');
    }
  })().catch(err => {
    manualBrowserOpen = false;
    broadcastLog(`Manual browser fatal: ${err}`);
  });
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
