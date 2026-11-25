import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { loadConfig } from '../shared/config.ts';
import { createBus } from './bus.ts';
import { openDb } from './db.ts';
import { createForge } from './forge.ts';
import { createEngine, validateReviewerMapping } from './engine.ts';
import { createQueue } from './git.ts';
import { createApiServer } from './http.ts';
import { acquireInstanceLock, installSignalHandlers, onShutdown } from './lifecycle.ts';
import { killAllSessions, runSession } from './omp.ts';
import { resolvePaths } from './paths.ts';
import { createStateCommitter } from './state-commit.ts';
import { createStore } from './store.ts';
import * as worktrees from './worktrees.ts';

const { values } = parseArgs({ options: { root: { type: 'string' }, port: { type: 'string' } } });
const paths = resolvePaths(values.root);
const config = loadConfig(paths.configFile);
const port = values.port !== undefined ? Number(values.port) : config.port;

mkdirSync(paths.liveDir, { recursive: true });
if (!existsSync(paths.liveDb) && existsSync(paths.committedDb)) copyFileSync(paths.committedDb, paths.liveDb);

const db = openDb(paths.liveDb);
const bus = createBus();
const store = createStore(db, bus);
let engine: ReturnType<typeof createEngine> | undefined; // the server is up (instance lock) before the engine exists
const server = createApiServer({ store, bus, uiDir: paths.uiDir, root: paths.root, mainHealth: () => engine?.mainHealth() });

// Take the instance lock before touching shared state: a losing second daemon must not reset .factory/main.
try {
  await acquireInstanceLock(server, port);
} catch (e) {
  console.error((e as Error).message);
  db.close();
  process.exit(1);
}

try {
  validateReviewerMapping(config);
} catch (e) {
  console.error((e as Error).message);
  server.close();
  db.close();
  process.exit(1);
}

const queue = createQueue();
const forge = createForge({ root: paths.root, mainWorktree: paths.mainWorktree, queue });
try {
  await forge.ensureMainWorktree();
} catch (e) {
  console.error(`factory: cannot prepare ${paths.mainWorktree}: ${(e as Error).message}`);
  server.close();
  db.close();
  process.exit(1);
}
const committer = createStateCommitter({
  db, bus, queue, mainWorktree: paths.mainWorktree,
  prefix: config.git.stateCommitPrefix, debounceSec: config.git.stateCommitDebounceSec,
});
onShutdown(async () => { committer.stop(); await committer.flush('shutdown'); });
onShutdown(() => killAllSessions());
installSignalHandlers({ server, db });
engine = createEngine({ store, bus, config, paths, runSession, worktrees, forge, committer });
onShutdown(() => engine!.stop());
console.log(`factory daemon listening on http://127.0.0.1:${(server.address() as AddressInfo).port} (root ${paths.root})`);
await engine.start();
