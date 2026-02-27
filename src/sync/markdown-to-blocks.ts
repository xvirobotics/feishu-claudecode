/**
 * Converts Markdown content into Feishu document block structures.
 * Handles headings, paragraphs, code blocks, lists, quotes, dividers, tables, and inline formatting.
 */

// --- Feishu block type constants ---
const BLOCK_TYPE = {
  PAGE: 1,
  TEXT: 2,
  HEADING1: 3,
  HEADING2: 4,
  HEADING3: 5,
  HEADING4: 6,
  HEADING5: 7,
  HEADING6: 8,
  HEADING7: 9,
  HEADING8: 10,
  HEADING9: 11,
  BULLET: 12,
  ORDERED: 13,
  CODE: 14,
  QUOTE: 15,
  TODO: 17,
  DIVIDER: 22,
  TABLE: 31,
  TABLE_CELL: 32,
} as const;

// Map language names to Feishu's language enum values
const LANGUAGE_MAP: Record<string, number> = {
  'plaintext': 1, 'abap': 2, 'ada': 3, 'apache': 4, 'apex': 5,
  'assembly': 6, 'bash': 7, 'shell': 7, 'sh': 7, 'csharp': 8, 'c#': 8, 'cs': 8,
  'c++': 9, 'cpp': 9, 'c': 10, 'cobol': 11, 'css': 12, 'coffeescript': 13,
  'd': 14, 'dart': 15, 'delphi': 16, 'django': 17, 'dockerfile': 18,
  'erlang': 19, 'fortran': 20, 'foxpro': 21, 'go': 22, 'groovy': 23,
  'html': 24, 'htmlbars': 25, 'http': 26, 'haskell': 27, 'json': 28,
  'java': 29, 'javascript': 30, 'js': 30, 'julia': 31, 'kotlin': 32,
  'latex': 33, 'lisp': 34, 'lua': 36, 'matlab': 38, 'makefile': 39,
  'markdown': 40, 'md': 40, 'nginx': 41, 'objective-c': 42, 'objc': 42,
  'openedgeabl': 43, 'perl': 44, 'php': 45, 'powershell': 47, 'prolog': 48,
  'protobuf': 49, 'python': 50, 'py': 50, 'r': 51, 'rpg': 52, 'ruby': 53, 'rb': 53,
  'rust': 54, 'rs': 54, 'sas': 55, 'scss': 56, 'sql': 57, 'scala': 58,
  'scheme': 59, 'smalltalk': 60, 'swift': 61, 'thrift': 62, 'typescript': 63,
  'ts': 63, 'tsx': 63, 'jsx': 30, 'vbscript': 64, 'vbnet': 65, 'xml': 66,
  'yaml': 67, 'yml': 67, 'cmake': 68, 'diff': 69, 'gams': 70,
  'less': 72, 'pascal': 73, 'stata': 76, 'toml': 80,
};

interface TextElement {
  text_run?: {
    content: string;
    text_element_style?: {
      bold?: boolean;
      italic?: boolean;
      strikethrough?: boolean;
      inline_code?: boolean;
      link?: { url: string };
    };
  };
}

interface FeishuBlock {
  block_type: number;
  [key: string]: any;
}

/** Parse inline Markdown formatting into Feishu TextElement array. */
export function parseInlineMarkdown(text: string): TextElement[] {
  const elements: TextElement[] = [];
  // Regex for inline formatting: links, bold, italic, strikethrough, inline code
  // Process inline code first to prevent nested parsing within code spans
  const regex = /(`[^`]+`)|(\[([^\]]+)\]\(([^)]+)\))|(\*\*\*([^*]+)\*\*\*)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)|(~~([^~]+)~~)/g;

  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add plain text before the match
    if (match.index > lastIndex) {
      elements.push({ text_run: { content: text.slice(lastIndex, match.index) } });
    }

    if (match[1]) {
      // Inline code: `code`
      elements.push({
        text_run: {
          content: match[1].slice(1, -1),
          text_element_style: { inline_code: true },
        },
      });
    } else if (match[2]) {
      // Link: [text](url) — Feishu requires full absolute URLs (http/https)
      const rawUrl = match[4];
      if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        elements.push({
          text_run: {
            content: match[3],
            text_element_style: { link: { url: encodeURI(rawUrl) } },
          },
        });
      } else {
        // Relative/internal links: render as plain text (Feishu rejects non-http URLs)
        elements.push({ text_run: { content: match[3] } });
      }
    } else if (match[5]) {
      // Bold+italic: ***text***
      elements.push({
        text_run: {
          content: match[6],
          text_element_style: { bold: true, italic: true },
        },
      });
    } else if (match[7]) {
      // Bold: **text**
      elements.push({
        text_run: {
          content: match[8],
          text_element_style: { bold: true },
        },
      });
    } else if (match[9]) {
      // Italic: *text*
      elements.push({
        text_run: {
          content: match[10],
          text_element_style: { italic: true },
        },
      });
    } else if (match[11]) {
      // Italic alt: _text_
      elements.push({
        text_run: {
          content: match[12],
          text_element_style: { italic: true },
        },
      });
    } else if (match[13]) {
      // Strikethrough: ~~text~~
      elements.push({
        text_run: {
          content: match[14],
          text_element_style: { strikethrough: true },
        },
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining plain text
  if (lastIndex < text.length) {
    elements.push({ text_run: { content: text.slice(lastIndex) } });
  }

  // If no elements, add the full text as plain
  if (elements.length === 0) {
    elements.push({ text_run: { content: text } });
  }

  return elements;
}

/** Convert Markdown text to an array of Feishu document blocks. */
export function markdownToBlocks(markdown: string): FeishuBlock[] {
  const lines = markdown.split('\n');
  const blocks: FeishuBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // --- Code block ---
    const codeMatch = line.match(/^```(\w*)/);
    if (codeMatch) {
      const lang = codeMatch[1].toLowerCase();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const content = codeLines.join('\n');
      blocks.push({
        block_type: BLOCK_TYPE.CODE,
        code: {
          elements: [{ text_run: { content } }],
          language: LANGUAGE_MAP[lang] || 1,
        },
      });
      continue;
    }

    // --- Table (render as code block since Feishu API doesn't support inline table cell creation) ---
    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      const content = tableLines.join('\n');
      blocks.push({
        block_type: BLOCK_TYPE.CODE,
        code: {
          elements: [{ text_run: { content } }],
          language: 1, // plaintext
        },
      });
      continue;
    }

    // --- Heading ---
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const blockType = BLOCK_TYPE.HEADING1 + level - 1;
      const key = `heading${level}`;
      blocks.push({
        block_type: blockType,
        [key]: { elements: parseInlineMarkdown(text) },
      });
      i++;
      continue;
    }

    // --- Horizontal rule ---
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ block_type: BLOCK_TYPE.DIVIDER, divider: {} });
      i++;
      continue;
    }

    // --- Checkbox / todo ---
    const todoMatch = line.match(/^(\s*)-\s+\[([ xX])\]\s+(.*)/);
    if (todoMatch) {
      const done = todoMatch[2].toLowerCase() === 'x';
      const text = todoMatch[3].trim();
      blocks.push({
        block_type: BLOCK_TYPE.TODO,
        todo: {
          elements: parseInlineMarkdown(text),
          style: { done },
        },
      });
      i++;
      continue;
    }

    // --- Unordered list ---
    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (bulletMatch) {
      const text = bulletMatch[2].trim();
      blocks.push({
        block_type: BLOCK_TYPE.BULLET,
        bullet: { elements: parseInlineMarkdown(text) },
      });
      i++;
      continue;
    }

    // --- Ordered list ---
    const orderedMatch = line.match(/^(\s*)\d+[.)]\s+(.*)/);
    if (orderedMatch) {
      const text = orderedMatch[2].trim();
      blocks.push({
        block_type: BLOCK_TYPE.ORDERED,
        ordered: { elements: parseInlineMarkdown(text) },
      });
      i++;
      continue;
    }

    // --- Blockquote (rendered as plain text since Feishu API doesn't support bare quote blocks) ---
    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const quoteText = quoteLines.join('\n').trim();
      blocks.push({
        block_type: BLOCK_TYPE.TEXT,
        text: { elements: parseInlineMarkdown(quoteText) },
      });
      continue;
    }

    // --- Empty line (skip) ---
    if (line.trim() === '') {
      i++;
      continue;
    }

    // --- Regular paragraph ---
    const paraLines: string[] = [line];
    i++;
    // Collect continuation lines (non-empty, non-special)
    while (i < lines.length) {
      const next = lines[i];
      if (
        next.trim() === '' ||
        next.match(/^#{1,6}\s/) ||
        next.match(/^[-*+]\s/) ||
        next.match(/^\d+[.)]\s/) ||
        next.startsWith('>') ||
        next.startsWith('```') ||
        /^(-{3,}|\*{3,}|_{3,})\s*$/.test(next) ||
        (next.includes('|') && next.trim().startsWith('|'))
      ) {
        break;
      }
      paraLines.push(next);
      i++;
    }
    const paraText = paraLines.join('\n').trim();
    if (paraText) {
      blocks.push({
        block_type: BLOCK_TYPE.TEXT,
        text: { elements: parseInlineMarkdown(paraText) },
      });
    }
  }

  return blocks;
}

/**
 * Feishu API limits the number of blocks per request.
 * Split blocks into batches for safe insertion.
 */
export function batchBlocks(blocks: FeishuBlock[], maxPerBatch = 50): FeishuBlock[][] {
  const batches: FeishuBlock[][] = [];
  for (let i = 0; i < blocks.length; i += maxPerBatch) {
    batches.push(blocks.slice(i, i + maxPerBatch));
  }
  return batches;
}

/** Compute a simple hash for content change detection. */
export function contentHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
