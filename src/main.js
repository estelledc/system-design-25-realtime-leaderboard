import { createServer } from 'node:http';
import { createHandler } from './http.js';
import { createRuntime } from './runtime.js';

if (process.argv[2] !== 'serve') {
  process.stderr.write('usage: node src/main.js serve\n');
  process.exitCode = 2;
} else {
  const runtime = await createRuntime();
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const server = createServer(createHandler(runtime.service, {
    logger: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  }));
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ operation: 'serve', outcome: 'ready', port })}\n`);
  });
  const shutdown = async () => {
    server.close();
    await runtime.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
