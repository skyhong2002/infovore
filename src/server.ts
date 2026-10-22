import { startGateway } from './gateway.js';

const gateway = startGateway();
let stopping = false;
// A crash is not a DB timeout: only after confirmed child exit do we exit
// nonzero and let the existing compose restart policy recreate a single owner.
gateway.child.once('exit', () => {
  if (!stopping) process.exitCode = 1;
  gateway.close();
});
gateway.server.on('listening', () => console.log(`listening on :${(gateway.server.address() as { port: number }).port}`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { stopping = true; gateway.close(); });
}
