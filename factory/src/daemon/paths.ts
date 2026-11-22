import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function resolvePaths(root?: string) {
  root ??= execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const factoryDir = join(root, '.factory');
  const liveDir = join(factoryDir, 'live');
  return {
    root,
    factoryDir,
    configFile: join(factoryDir, 'config.json'),
    committedDb: join(factoryDir, 'factory.db'),
    liveDir,
    liveDb: join(liveDir, 'factory.db'),
    mainWorktree: join(factoryDir, 'main'),
    worktreesDir: join(factoryDir, 'worktrees'),
    sessionsDir: join(factoryDir, 'sessions'),
    uiDir: join(root, 'factory', 'ui', 'dist'),
  };
}
