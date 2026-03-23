/**
 * Production entry point — imports the Express server.
 * Railway runs: npm run build && npm start (node dist/api/index.js)
 * The server module handles listening when not in serverless (Vercel) mode.
 */
import '../src/server';
