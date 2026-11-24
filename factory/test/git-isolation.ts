// Preloaded by `npm test` (node --import) so no git child process in the suite can reach a global signer.
import { gitSigningOffEnv } from '../src/daemon/git.ts';

Object.assign(process.env, gitSigningOffEnv());
