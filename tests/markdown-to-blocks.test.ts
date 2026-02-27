import { describe, it, expect } from 'vitest';
import { parseInlineMarkdown, markdownToBlocks, batchBlocks, contentHash } from '../src/sync/markdown-to-blocks.js';

describe('parseInlineMarkdown', () => {
  it('returns plain text for simple input', () => {
    const result = parseInlineMarkdown('hello world');
    expect(result).toEqual([{ text_run: { content: 'hello world' } }]);
  });

  it('parses bold text', () => {
    const result = parseInlineMarkdown('this is **bold** text');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ text_run: { content: 'this is ' } });
    expect(result[1]).toEqual({ text_run: { content: 'bold', text_element_style: { bold: true } } });
    expect(result[2]).toEqual({ text_run: { content: ' text' } });
  });

  it('parses italic text with asterisk', () => {
    const result = parseInlineMarkdown('this is *italic* text');
    expect(result).toHaveLength(3);
    expect(result[1].text_run?.text_element_style?.italic).toBe(true);
  });

  it('parses italic text with underscore', () => {
    const result = parseInlineMarkdown('this is _italic_ text');
    expect(result).toHaveLength(3);
    expect(result[1].text_run?.text_element_style?.italic).toBe(true);
  });

  it('parses bold+italic text', () => {
    const result = parseInlineMarkdown('***both***');
    expect(result).toHaveLength(1);
    expect(result[0].text_run?.text_element_style?.bold).toBe(true);
    expect(result[0].text_run?.text_element_style?.italic).toBe(true);
  });

  it('parses inline code', () => {
    const result = parseInlineMarkdown('use `npm install` here');
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual({
      text_run: { content: 'npm install', text_element_style: { inline_code: true } },
    });
  });

  it('parses strikethrough', () => {
    const result = parseInlineMarkdown('this is ~~deleted~~ text');
    expect(result).toHaveLength(3);
    expect(result[1].text_run?.text_element_style?.strikethrough).toBe(true);
  });

  it('parses links', () => {
    const result = parseInlineMarkdown('click [here](https://example.com) please');
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual({
      text_run: { content: 'here', text_element_style: { link: { url: 'https://example.com' } } },
    });
  });

  it('URL-encodes link URLs with special characters', () => {
    const result = parseInlineMarkdown('[doc](https://example.com/中文文档)');
    expect(result).toHaveLength(1);
    expect(result[0].text_run?.text_element_style?.link?.url).toBe('https://example.com/%E4%B8%AD%E6%96%87%E6%96%87%E6%A1%A3');
  });

  it('strips relative links and keeps text only', () => {
    const result = parseInlineMarkdown('[doc](/some/path)');
    expect(result).toHaveLength(1);
    expect(result[0].text_run?.content).toBe('doc');
    expect(result[0].text_run?.text_element_style?.link).toBeUndefined();
  });

  it('handles empty string', () => {
    const result = parseInlineMarkdown('');
    expect(result).toHaveLength(1);
    expect(result[0].text_run?.content).toBe('');
  });

  it('handles multiple inline formats', () => {
    const result = parseInlineMarkdown('**bold** and `code`');
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result[0].text_run?.text_element_style?.bold).toBe(true);
  });
});

describe('markdownToBlocks', () => {
  it('converts headings', () => {
    const blocks = markdownToBlocks('# Title\n## Subtitle\n### H3');
    expect(blocks).toHaveLength(3);
    expect(blocks[0].block_type).toBe(3); // HEADING1
    expect(blocks[1].block_type).toBe(4); // HEADING2
    expect(blocks[2].block_type).toBe(5); // HEADING3
  });

  it('converts paragraphs', () => {
    const blocks = markdownToBlocks('Hello world');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_type).toBe(2); // TEXT
    expect(blocks[0].text.elements[0].text_run.content).toBe('Hello world');
  });

  it('converts code blocks', () => {
    const blocks = markdownToBlocks('```python\nprint("hi")\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_type).toBe(14); // CODE
    expect(blocks[0].code.elements[0].text_run.content).toBe('print("hi")');
    expect(blocks[0].code.language).toBe(50); // python
  });

  it('handles code blocks with no language', () => {
    const blocks = markdownToBlocks('```\nfoo\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code.language).toBe(1); // plaintext
  });

  it('converts bullet lists', () => {
    const blocks = markdownToBlocks('- item 1\n- item 2\n* item 3');
    expect(blocks).toHaveLength(3);
    for (const b of blocks) {
      expect(b.block_type).toBe(12); // BULLET
    }
  });

  it('converts ordered lists', () => {
    const blocks = markdownToBlocks('1. first\n2. second');
    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      expect(b.block_type).toBe(13); // ORDERED
    }
  });

  it('converts blockquotes as text blocks', () => {
    const blocks = markdownToBlocks('> This is a quote\n> with two lines');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_type).toBe(2); // TEXT (rendered as plain text since Feishu API doesn't support bare quote blocks)
    expect(blocks[0].text.elements[0].text_run.content).toContain('This is a quote');
  });

  it('converts horizontal rules', () => {
    const blocks = markdownToBlocks('---');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_type).toBe(22); // DIVIDER
  });

  it('converts todo items', () => {
    const blocks = markdownToBlocks('- [ ] undone\n- [x] done');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].block_type).toBe(17); // TODO
    expect(blocks[0].todo.style.done).toBe(false);
    expect(blocks[1].todo.style.done).toBe(true);
  });

  it('converts tables as code blocks', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_type).toBe(14); // CODE (rendered as plaintext code block)
    expect(blocks[0].code.elements[0].text_run.content).toContain('| A | B |');
  });

  it('skips empty lines', () => {
    const blocks = markdownToBlocks('\n\n\n');
    expect(blocks).toHaveLength(0);
  });

  it('handles mixed content', () => {
    const md = [
      '# Title',
      '',
      'A paragraph.',
      '',
      '- bullet 1',
      '- bullet 2',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '---',
    ].join('\n');
    const blocks = markdownToBlocks(md);
    expect(blocks.length).toBeGreaterThanOrEqual(5); // heading, para, 2 bullets, code, divider
    expect(blocks[0].block_type).toBe(3); // heading
    expect(blocks[blocks.length - 1].block_type).toBe(22); // divider
  });
});

describe('batchBlocks', () => {
  it('returns single batch for small arrays', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => ({ block_type: 2, text: { elements: [{ text_run: { content: `${i}` } }] } }));
    const batches = batchBlocks(blocks, 50);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(10);
  });

  it('splits into multiple batches', () => {
    const blocks = Array.from({ length: 120 }, (_, i) => ({ block_type: 2, text: { elements: [{ text_run: { content: `${i}` } }] } }));
    const batches = batchBlocks(blocks, 50);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(50);
    expect(batches[1]).toHaveLength(50);
    expect(batches[2]).toHaveLength(20);
  });

  it('handles empty array', () => {
    const batches = batchBlocks([]);
    expect(batches).toHaveLength(0);
  });
});

describe('contentHash', () => {
  it('returns consistent hash for same input', () => {
    const h1 = contentHash('hello');
    const h2 = contentHash('hello');
    expect(h1).toBe(h2);
  });

  it('returns different hash for different input', () => {
    const h1 = contentHash('hello');
    const h2 = contentHash('world');
    expect(h1).not.toBe(h2);
  });

  it('returns 8-char hex string', () => {
    const h = contentHash('test');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles empty string', () => {
    const h = contentHash('');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });
});
