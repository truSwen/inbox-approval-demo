import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { fileURLToPath } from 'node:url';
import { createServer } from './tools.js';
import { openStore } from './core.js';

const store = openStore(process.env.DEMO_DB ?? fileURLToPath(new URL('./demo.sqlite', import.meta.url)));
store.seed();
serveStdio(() => createServer(store));
