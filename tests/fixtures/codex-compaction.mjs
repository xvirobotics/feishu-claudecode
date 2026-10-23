import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  appendFileSync(process.env.RPC_LOG, line + '\n');
  const reply = result => send({ id: m.id, result });
  if (m.method === 'initialize') reply({});
  if (m.method === 'thread/resume') reply({ thread: { id: 'test-thread' } });
  if (m.method === 'thread/compact/start') {
    reply({});
    send({ method: 'turn/started', params: { threadId: 'test-thread', turn: { id: 'test-turn' } } });
    send({ method: 'turn/completed', params: { threadId: 'unrelated-thread', turn: { id: 'unrelated-turn', status: 'completed' } } });
    if (process.env.SCENARIO === 'hold') return;
    if (process.env.SCENARIO === 'exit') { process.exit(2); }
    if (process.env.SCENARIO !== 'no-compaction') {
      send({ method: 'item/completed', params: { threadId: 'test-thread', turnId: 'test-turn', item: { type: 'contextCompaction' } } });
    }
    send({ method: 'turn/completed', params: { threadId: 'test-thread', turn: { id: 'test-turn', status: 'completed' } } });
  }
});
