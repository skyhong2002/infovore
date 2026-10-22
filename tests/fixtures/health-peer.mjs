// Synthetic health protocol peer. No filesystem, DB or upstream network.
import { createServer } from 'node:http';
const body = { status: 'healthy', maxSourceAgeHours: 1, sources: [{ source: 'synthetic', fresh: true, ageMs: 0, error: null }] };
const hanging = new Set();
const server = createServer((req, res) => {
  if (req.url === '/stall') { hanging.add(res); res.on('close', () => hanging.delete(res)); }
  else res.end('synthetic backend');
});
server.listen(0, '127.0.0.1', () => process.send?.({ type: 'ready', port: server.address().port }));
process.on('message', (m) => {
  if (m.type === 'health') process.send?.({ type: 'health', snapshot: { capturedAt: Date.now() - (m.ageMs ?? 0), body: m.body ?? body } });
  if (m.type === 'error') process.send?.({ type: 'health-error' });
  if (m.type === 'release') { for (const res of hanging) res.end('synthetic completed'); }
  if (m.type === 'crash') process.exit(7);
});
process.on('disconnect', () => process.exit());
