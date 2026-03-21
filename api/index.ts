/**
 * Vercel serverless entry — re-exports the Express app.
 * `vercel.json` rewrites all routes here; Express still handles `/api/*` and static `ui/`.
 */
import app from '../src/server';

export default app;
