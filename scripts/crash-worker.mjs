import { createRuntime } from '../src/runtime.js';

const [point, operation, encoded] = process.argv.slice(2);
if (!point || !operation || !encoded) process.exit(2);

const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
const runtime = await createRuntime({
  hook: async (observed) => {
    if (observed === point) process.kill(process.pid, 'SIGKILL');
  },
});

const methods = {
  reportScore: 'reportScore',
  publish: 'publish',
  freezeSeason: 'freezeSeason',
  rebuild: 'rebuild',
  garbageCollect: 'garbageCollect',
};

try {
  const method = methods[operation];
  if (!method) process.exitCode = 2;
  else {
    await runtime.service[method](payload);
    process.exitCode = 3;
  }
} finally {
  await runtime.close();
}
