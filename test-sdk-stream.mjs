import { query } from '@anthropic-ai/claude-agent-sdk';
import { createRequire } from 'module';
import { dirname, join } from 'path';

const require2 = createRequire(import.meta.url);
const CLAUDE_EXECUTABLE = process.execPath;

async function test() {
  const types = {};
  const toolMsgs = [];
  
  const stream = query({
    prompt: 'Read the file /etc/hostname using the Read tool and tell me its contents.',
    options: {
      maxTurns: 3,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: '/tmp',
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      executableArgs: [join(dirname(require2.resolve('@anthropic-ai/claude-agent-sdk')), 'cli.js')],
    }
  });

  for await (const msg of stream) {
    const t = msg.type;
    types[t] = (types[t] || 0) + 1;
    
    if (t === 'user' || t === 'assistant') {
      const content = (msg.message && msg.message.content) ? msg.message.content : [];
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_use' || b.type === 'tool_result') {
            toolMsgs.push({
              msgType: t,
              blockType: b.type,
              name: b.name || '-',
            });
          }
        }
      }
    }
  }
  console.log('Message types:', JSON.stringify(types));
  for (const m of toolMsgs) {
    console.log('  ' + m.msgType + ' -> ' + m.blockType + ' (' + m.name + ')');
  }
}

test().catch(function(e) { console.error('Error:', e.message, e.stack); process.exit(1); });
