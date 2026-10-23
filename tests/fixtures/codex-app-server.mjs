import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const threadId = 'test-thread';
const turnId = 'test-turn';
const complete = () => send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (process.env.RPC_LOG) appendFileSync(process.env.RPC_LOG, line + '\n');
  const reply = result => send({ id: m.id, result });
  if (m.method === 'initialize') reply({});
  if (m.method === 'thread/start' || m.method === 'thread/resume') reply({ thread: { id: threadId } });
  if (m.method === 'turn/start') {
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    reply({ turn: { id: turnId } });
    send({ method: 'turn/completed', params: { threadId: 'unrelated-thread', turn: { id: 'other-turn', status: 'completed' } } });
    if (process.env.SCENARIO === 'exit') process.exit(2);
  }
  if (m.method === 'turn/steer') {
    if (process.env.SCENARIO === 'reject') {
      send({ id: m.id, error: { code: -32600, message: 'No active turn' } });
      return;
    }
    reply({ turnId });
    send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'msg', text: m.params.input[0].text } } });
    complete();
  }
});
