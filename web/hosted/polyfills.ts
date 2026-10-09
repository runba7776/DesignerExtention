import { Buffer } from 'buffer';

// Node globals used by the shared server modules when they run in the browser.
const scope = globalThis as unknown as { Buffer?: typeof Buffer; process?: NodeJS.Process; global?: unknown };
scope.Buffer ??= Buffer;
scope.process ??= { env: {}, versions: {}, cwd: () => '/' } as unknown as NodeJS.Process;
scope.global ??= globalThis;
