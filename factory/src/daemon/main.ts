import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { loadConfig } from '../shared/config.ts';
import { createBus } from './bus.ts';
import { openDb } from './db.ts';
import { createApiServer } from './http.ts';
import { acquireInstanceLock, installSignalHandlers, onShutdown } from './lifecycle.ts';
import { killAllSessions } from './omp.ts';
import { resolvePaths } from './paths.ts';
import { createStore } from './store.ts';

const { values } = parseArgs({ options: { root: { type: 'string' }, port: { type: 'string' } } });
const paths = resolvePaths(values.root);
const config = loadConfig(paths.configFile);
const port = values.port !== undefined ? Number(values.port) : config.port;

mkdirSync(paths.liveDir, { recursive: true });
if (!existsSync(paths.liveDb) && existsSync(paths.committedDb)) copyFileSync(paths.committedDb, paths.liveDb);

const db = openDb(paths.liveDb);
const bus = createBus();
const store = createStore(db, bus);
const server = createApiServer({ store, bus, uiDir: paths.uiDir });

try {
  await acquireInstanceLock(server, port);
} catch (e) {
  console.error((e as Error).message);
  db.close();
  process.exit(1);
}
onShutdown(() => killAllSessions());
installSignalHandlers({ server, db });
console.log(`factory daemon listening on http://127.0.0.1:${(server.address() as AddressInfo).port} (root ${paths.root})`);
