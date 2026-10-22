// Independent public frontend process for the parent-process socket probes.
import { startGateway } from '../../src/gateway.ts';
const gateway = startGateway({ port: 0, hostname: '127.0.0.1', requestDeadlineMs: 3000, staleMs: 4000, maxInFlight: 2, homeRefreshMs: 1000, homeCooldownMs: 1000,
  backendFile: new URL('./availability-backend.mjs', import.meta.url) });
gateway.server.on('listening', () => process.send?.({ type: 'ready', port: gateway.server.address().port }));
gateway.child.on('message', (message) => {
  if (message.type !== 'ready') process.send?.(message);
});
process.on('message', (message) => gateway.child.connected && gateway.child.send(message));
process.on('disconnect', () => gateway.close());
process.on('SIGTERM', () => gateway.close());
