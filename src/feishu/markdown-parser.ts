/**
 * Markdown → Block sequence parser
 *
 * Used by card-builder-v2: splits Claude's markdown output into a block
 * sequence, then each block type maps to a native Feishu v2 component
 * (heading/table/code_block/markdown).
 *
 * Uses `marked` to parse (handles nesting/escaping/alignment edge cases),
 * then flattens its token tree into our block types.
 */
import { marked, type Tokens } from 'marked';

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'table'; headers: string[]; align: ('left' | 'center' | 'right')[]; rows: string[][] }
  | { type: 'codeblock'; lang: string; code: string }
  | { type: 'hr' }
  | { type: 'markdown'; text: string };

/** Convert a token back to raw markdown text (for passthrough blocks) */
function tokenToMarkdown(token: Tokens.Generic): string {
  return token.raw ?? '';
}

/**
 * Flatten inline tokens array into a markdown string.
 * Used for heading titles, table cells, and other inline contexts.
 */
function inlineTokensToText(tokens: Tokens.Generic[] | undefined): string {
  if (!tokens) return '';
  return tokens.map((t) => t.raw ?? (t as any).text ?? '').join('');
}

export function parseMarkdownToBlocks(md: string): Block[] {
  if (!md) return [];

  const tokens = marked.lexer(md);
  const blocks: Block[] = [];

  // Collect consecutive paragraph/list/blockquote etc. into a single markdown
  // block so Feishu's native markdown renderer handles them as a unit.
  let buffer: string[] = [];
  const flushBuffer = () => {
    if (buffer.length > 0) {
      const text = buffer.join('').trim();
      if (text) blocks.push({ type: 'markdown', text });
      buffer = [];
    }
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        flushBuffer();
        const t = token as Tokens.Heading;
        const level = Math.min(6, Math.max(1, t.depth)) as 1 | 2 | 3 | 4 | 5 | 6;
        blocks.push({
          type: 'heading',
          level,
          text: inlineTokensToText(t.tokens) || t.text,
        });
        break;
      }

      case 'table': {
        flushBuffer();
        const t = token as Tokens.Table;
        const headers = t.header.map((h) => h.text);
        const align    = t.align.map((a) => (a === 'center' ? 'center' : a === 'right' ? 'right' : 'left'));
        const rows     = t.rows.map((row) => row.map((cell) => cell.text));
        blocks.push({ type: 'table', headers, align, rows });
        break;
      }

      case 'code': {
        flushBuffer();
        const t = token as Tokens.Code;
        blocks.push({
          type: 'codeblock',
          lang: t.lang || '',
          code: t.text,
        });
        break;
      }

      case 'hr': {
        flushBuffer();
        blocks.push({ type: 'hr' });
        break;
      }

      // paragraph / list / blockquote / plain text → buffer, merged later
      case 'paragraph':
      case 'list':
      case 'blockquote':
      case 'space':
      case 'text':
      case 'html':
      case 'br':
      default:
        buffer.push(tokenToMarkdown(token));
        break;
    }
  }

  flushBuffer();
  return blocks;
}
