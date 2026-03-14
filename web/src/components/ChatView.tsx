import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useStore } from '../store';
import { useWebSocket } from '../hooks/useWebSocket';
import type { CardState, ChatMessage, FileAttachment, ToolCall } from '../types';
import { renderAsync as renderDocx } from 'docx-preview';
import * as XLSX from 'xlsx';
import styles from './ChatView.module.css';

/* ---- Tiny icons ---- */

function IconSend() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function IconChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function IconXCircle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}


function IconTool() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function IconPhone() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
    </svg>
  );
}

function IconPhoneOff() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.42 19.42 0 01-3.33-2.67" />
      <path d="M14.91 2.91a2 2 0 011 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L15 10.68" />
      <path d="M4.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function IconMic() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
      <path d="M19 10v2a7 7 0 01-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function IconMicSmall() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
      <path d="M19 10v2a7 7 0 01-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function IconPaperclip() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function IconX() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconFile() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function IconFileSidebar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

/* ---- File helpers ---- */

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileCategory(type: string): 'image' | 'video' | 'audio' | 'other' {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'other';
}

function fileExt(name: string): string {
  return (name.split('.').pop() || '').toLowerCase();
}

/** Can we render this file as text content (markdown, code, plain text)? */
function isTextPreviewable(name: string, type: string): boolean {
  const textExts = new Set(['md', 'txt', 'json', 'csv', 'xml', 'yaml', 'yml', 'toml', 'ini', 'log',
    'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
    'css', 'scss', 'less', 'html', 'htm', 'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql',
    'swift', 'kt', 'scala', 'lua', 'r', 'pl', 'php', 'dart', 'zig', 'env', 'gitignore',
    'dockerfile', 'makefile', 'cmake']);
  const ext = fileExt(name);
  return textExts.has(ext) || type.startsWith('text/') || type === 'application/json' || type === 'application/xml';
}

/** Can we embed this in an iframe? */
function isEmbedPreviewable(name: string): boolean {
  const ext = fileExt(name);
  return ext === 'pdf';
}

/** Office docs that we render client-side */
function isOfficePreviewable(name: string): 'docx' | 'xlsx' | 'pptx' | false {
  const ext = fileExt(name);
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (ext === 'pptx') return 'pptx';
  return false;
}

/** Build the server-side preview conversion URL (for pptx fallback) */
function serverPreviewUrl(fileUrl: string): string {
  return fileUrl.replace('/api/files/', '/api/files/preview/');
}

/* ---- File Preview Content (rendered inside the right panel) ---- */

function FilePreviewContent({ file }: { file: FileAttachment }) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [xlsxHtml, setXlsxHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const docxRef = useRef<HTMLDivElement>(null);
  const cat = fileCategory(file.type);
  const ext = fileExt(file.name);
  const officeType = isOfficePreviewable(file.name);

  // Fetch text content
  useEffect(() => {
    setTextContent(null);
    setXlsxHtml(null);
    setError(null);
    if (isTextPreviewable(file.name, file.type)) {
      setLoading(true);
      fetch(file.url)
        .then((r) => r.text())
        .then((t) => { setTextContent(t); setLoading(false); })
        .catch(() => { setError('Failed to load file.'); setLoading(false); });
    }
  }, [file.url, file.name, file.type]);

  // DOCX: render with docx-preview
  useEffect(() => {
    if (officeType !== 'docx' || !docxRef.current) return;
    setLoading(true);
    setError(null);
    fetch(file.url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (docxRef.current) {
          docxRef.current.innerHTML = '';
          return renderDocx(buf, docxRef.current, undefined, { inWrapper: true });
        }
      })
      .then(() => setLoading(false))
      .catch((err) => { setError('Failed to render DOCX: ' + err.message); setLoading(false); });
  }, [file.url, officeType]);

  // XLSX: parse and render with SheetJS
  useEffect(() => {
    if (officeType !== 'xlsx') return;
    setLoading(true);
    setError(null);
    fetch(file.url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
        const parts: string[] = [];
        for (const name of wb.SheetNames) {
          const sheet = wb.Sheets[name];
          parts.push(`<h3 style="margin:16px 0 8px;font-size:14px;color:#555">${name}</h3>`);
          parts.push(XLSX.utils.sheet_to_html(sheet, { editable: false }));
        }
        setXlsxHtml(parts.join('\n'));
        setLoading(false);
      })
      .catch((err) => { setError('Failed to render spreadsheet: ' + err.message); setLoading(false); });
  }, [file.url, officeType]);

  if (error) {
    return <div className={styles.previewLoading}>{error}</div>;
  }

  // Image
  if (cat === 'image') {
    return <img src={file.url} alt={file.name} className={styles.previewImage} />;
  }

  // Video
  if (cat === 'video') {
    return <video src={file.url} controls autoPlay className={styles.previewVideo} />;
  }

  // Audio
  if (cat === 'audio') {
    return (
      <div className={styles.previewAudioWrap}>
        <div className={styles.previewAudioIcon}><IconFile /></div>
        <div className={styles.previewAudioName}>{file.name}</div>
        <audio src={file.url} controls autoPlay className={styles.previewAudioPlayer} />
      </div>
    );
  }

  // PDF
  if (isEmbedPreviewable(file.name)) {
    return <iframe src={file.url} className={styles.previewIframe} title={file.name} />;
  }

  // DOCX — client-side rendering via docx-preview
  if (officeType === 'docx') {
    return (
      <>
        {loading && <div className={styles.previewLoading}>Rendering document...</div>}
        <div ref={docxRef} className={styles.previewDocx} />
      </>
    );
  }

  // XLSX — client-side rendering via SheetJS
  if (officeType === 'xlsx') {
    if (loading) return <div className={styles.previewLoading}>Rendering spreadsheet...</div>;
    if (xlsxHtml) {
      return <div className={styles.previewXlsx} dangerouslySetInnerHTML={{ __html: xlsxHtml }} />;
    }
    return null;
  }

  // PPTX — server-side conversion fallback (requires libreoffice)
  if (officeType === 'pptx') {
    return (
      <div className={styles.previewUnsupported}>
        <div className={styles.previewUnsupportedIcon}>PPTX</div>
        <div className={styles.previewUnsupportedName}>{file.name}</div>
        <div className={styles.previewUnsupportedSize}>{formatFileSize(file.size)}</div>
        <a href={file.url} download={file.name} className={styles.previewDownloadBtn}>Download</a>
      </div>
    );
  }

  // Text / Markdown / Code
  if (isTextPreviewable(file.name, file.type)) {
    if (loading) return <div className={styles.previewLoading}>Loading...</div>;
    if (textContent === null) return null;

    if (ext === 'md') {
      return (
        <div className={styles.previewMarkdown}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {textContent}
          </ReactMarkdown>
        </div>
      );
    }

    if (ext === 'html' || ext === 'htm') {
      return <iframe srcDoc={textContent} className={styles.previewIframe} title={file.name} sandbox="allow-same-origin" />;
    }

    return (
      <div className={styles.previewCode}>
        <pre><code>{textContent}</code></pre>
      </div>
    );
  }

  // Unsupported — download prompt
  return (
    <div className={styles.previewUnsupported}>
      <div className={styles.previewUnsupportedIcon}>{ext.toUpperCase()}</div>
      <div className={styles.previewUnsupportedName}>{file.name}</div>
      <div className={styles.previewUnsupportedSize}>{formatFileSize(file.size)}</div>
      <a href={file.url} download={file.name} className={styles.previewDownloadBtn}>Download</a>
    </div>
  );
}

/* ---- File Attachment Card ---- */

function FileAttachmentCard({ file, compact, onPreview }: { file: FileAttachment; compact?: boolean; onPreview?: (f: FileAttachment) => void }) {
  const [imgError, setImgError] = useState(false);
  const cat = fileCategory(file.type);
  const handleClick = (e: React.MouseEvent) => {
    if (onPreview) { e.preventDefault(); onPreview(file); }
  };

  if (cat === 'image' && !imgError) {
    return (
      <a href={file.url} onClick={handleClick} className={styles.attachCard}>
        <img
          src={file.url}
          alt={file.name}
          className={compact ? styles.attachImgCompact : styles.attachImg}
          onError={() => setImgError(true)}
        />
        <span className={styles.attachName}>{file.name}</span>
      </a>
    );
  }

  if (cat === 'video') {
    return (
      <div className={styles.attachCard} onClick={handleClick} style={{ cursor: 'pointer' }}>
        <video src={file.url} preload="metadata" className={compact ? styles.attachVideoCompact : styles.attachVideo} />
        <span className={styles.attachName}>{file.name}</span>
      </div>
    );
  }

  if (cat === 'audio') {
    return (
      <div className={styles.attachCardAudio} onClick={handleClick} style={{ cursor: 'pointer' }}>
        <div className={styles.attachAudioInfo}>
          <IconFile />
          <span className={styles.attachFileName}>{file.name}</span>
        </div>
        <audio src={file.url} controls preload="metadata" className={styles.attachAudio} />
      </div>
    );
  }

  // Generic file card
  const extLabel = file.name.split('.').pop()?.toUpperCase() || 'FILE';
  return (
    <a href={file.url} onClick={handleClick} className={styles.attachCardFile}>
      <div className={styles.attachFileIcon}>
        <span className={styles.attachFileExt}>{extLabel}</span>
      </div>
      <div className={styles.attachFileMeta}>
        <span className={styles.attachFileName}>{file.name}</span>
        <span className={styles.attachFileSize}>{formatFileSize(file.size)}</span>
      </div>
      <div className={styles.attachFileDownload}><IconDownload /></div>
    </a>
  );
}

/* ---- Helpers ---- */

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}


function decodeBase64Utf8(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ---- Code Block component ---- */

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const lang = match ? match[1] : '';
  const code = String(children).replace(/\n$/, '');

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  if (!className) {
    // inline code
    return <code>{children}</code>;
  }

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
        <span className={styles.codeBlockLang}>{lang || 'code'}</span>
        <button
          className={`${styles.codeBlockCopy} ${copied ? styles.codeBlockCopied : ''}`}
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <IconCheck /> Copied
            </>
          ) : (
            <>
              <IconCopy /> Copy
            </>
          )}
        </button>
      </div>
      <div className={styles.codeBlockBody}>
        <pre>
          <code className={className}>{children}</code>
        </pre>
      </div>
    </div>
  );
}

/* ---- Tool Calls display ---- */

function ToolCallsSection({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [expanded, setExpanded] = useState(true);
  if (toolCalls.length === 0) return null;

  const runningCount = toolCalls.filter((t) => t.status === 'running').length;

  return (
    <div className={styles.toolCalls}>
      <div
        className={styles.toolCallsHeader}
        onClick={() => setExpanded(!expanded)}
      >
        <IconTool />
        <span>
          {toolCalls.length} tool{toolCalls.length !== 1 ? 's' : ''}
          {runningCount > 0 ? ` (${runningCount} running)` : ''}
        </span>
        <span
          className={`${styles.toolCallsChevron} ${
            expanded ? styles.toolCallsChevronOpen : ''
          }`}
        >
          <IconChevronDown />
        </span>
      </div>

      {expanded && (
        <div className={styles.toolCallsList}>
          {toolCalls.map((tc, i) => (
            <div key={i} className={styles.toolCallItem}>
              <span className={styles.toolCallIcon}>
                {tc.status === 'running' ? (
                  <span className={styles.toolCallSpinner} />
                ) : (
                  <span className={styles.toolCallCheck}>
                    <IconCheck />
                  </span>
                )}
              </span>
              <span className={styles.toolCallName}>{tc.name}</span>
              {tc.detail && (
                <span className={styles.toolCallDetail}>{tc.detail}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Status bar ---- */

function StatusIndicator({ status }: { status: CardState['status'] }) {
  switch (status) {
    case 'thinking':
    case 'waiting_for_input':
      return (
        <div className={styles.statusAnim}>
          <div className={styles.statusDots}>
            <div className={styles.statusDot} />
            <div className={styles.statusDot} />
            <div className={styles.statusDot} />
          </div>
        </div>
      );

    case 'running':
      return (
        <div className={styles.statusAnim}>
          <div className={styles.shimmerBar} />
        </div>
      );

    case 'error':
      return (
        <div className={styles.statusBar}>
          <div className={styles.statusIcon} style={{ color: 'var(--red)' }}>
            <IconXCircle />
          </div>
          <span className={`${styles.statusLabel} ${styles.statusError}`}>
            Error
          </span>
        </div>
      );

    default:
      return null;
  }
}

/* ---- Pending Question ---- */

function PendingQuestionUI({
  state,
  onAnswer,
}: {
  state: CardState;
  onAnswer: (answer: string) => void;
}) {
  if (!state.pendingQuestion) return null;

  return (
    <div className={styles.pendingQuestion}>
      {state.pendingQuestion.questions.map((q, i) => (
        <div key={i}>
          {q.header && (
            <div className={styles.pendingQuestionHeader}>{q.header}</div>
          )}
          <div className={styles.pendingQuestionText}>{q.question}</div>
          <div className={styles.pendingOptions}>
            {q.options.map((opt, j) => (
              <button
                key={j}
                className={styles.optionBtn}
                onClick={() => onAnswer(opt.label)}
              >
                {opt.label}
                {opt.description && (
                  <span className={styles.optionBtnDesc}>{opt.description}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- Assistant Message ---- */

function AssistantMessageView({
  msg,
  onAnswer,
}: {
  msg: ChatMessage;
  onAnswer: (toolUseId: string, answer: string) => void;
}) {
  const state = msg.state;

  const markdownComponents = useMemo(
    () => ({
      code: CodeBlock,
    }),
    [],
  );

  return (
    <div className={styles.assistantMessage}>
      {state && <StatusIndicator status={state.status} />}

      {state && <ToolCallsSection toolCalls={state.toolCalls} />}

      {msg.text && (
        <div className={styles.responseContent}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents}
          >
            {msg.text}
          </ReactMarkdown>
        </div>
      )}

      {state?.errorMessage && (
        <div className={styles.errorBlock}>{state.errorMessage}</div>
      )}

      {state?.pendingQuestion && (
        <PendingQuestionUI
          state={state}
          onAnswer={(answer) =>
            onAnswer(state.pendingQuestion!.toolUseId, answer)
          }
        />
      )}
    </div>
  );
}

/* ---- Empty State ---- */

function EmptyState({ onHintClick }: { onHintClick: (text: string) => void }) {
  const activeBotName = useStore((s) => s.activeBotName);
  const hints = [
    'Explain this codebase',
    'Find all TODO comments',
    'Write unit tests',
    'Refactor for readability',
  ];

  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}>
        <div className={styles.emptyIconInner}>M</div>
      </div>
      <h2 className={styles.emptyTitle}>
        {activeBotName ? `Chat with ${activeBotName}` : 'Start a conversation'}
      </h2>
      <p className={styles.emptySubtitle}>
        Ask anything about your codebase. Claude will read files, run commands,
        and help you build.
      </p>
      <div className={styles.emptyHints}>
        {hints.map((hint) => (
          <button
            key={hint}
            className={styles.emptyHint}
            onClick={() => onHintClick(hint)}
          >
            {hint}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ==== Main ChatView Component ==== */

export function ChatView() {
  const activeSessionId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const addMessage = useStore((s) => s.addMessage);
  const createSession = useStore((s) => s.createSession);
  const connected = useStore((s) => s.connected);
  const activeBotName = useStore((s) => s.activeBotName);
  const updateMessageText = useStore((s) => s.updateMessageText);
  const updateMessageState = useStore((s) => s.updateMessageState);
  const token = useStore((s) => s.token);

  const { send } = useWebSocket();

  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // ── Speech-to-text state ──
  const [sttActive, setSttActive] = useState(false);
  const sttRef = useRef<SpeechRecognition | null>(null);

  // ── File upload state ──
  interface PendingFile { file: File; previewUrl?: string; }
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Call mode state ──
  const [callActive, setCallActive] = useState(false);
  type CallPhase = 'recording' | 'processing' | 'playing';
  const [callPhase, setCallPhase] = useState<CallPhase>('recording');
  const [callStartTime, setCallStartTime] = useState(0);
  const [callElapsed, setCallElapsed] = useState('0:00');
  const [callStatusText, setCallStatusText] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null); // for mobile audio playback
  const playbackSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const callActiveRef = useRef(false); // avoid stale closure
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vadRafRef = useRef<number>(0); // requestAnimationFrame id
  const hasSpokenRef = useRef(false); // whether user has started speaking
  const handleCallVoiceSendRef = useRef<(blob: Blob) => void>(() => {}); // stable ref for onstop

  const session = activeSessionId ? sessions.get(activeSessionId) : undefined;
  const messages = session?.messages || [];

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (!autoScrollRef.current || !messageListRef.current) return;
    const el = messageListRef.current;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Detect manual scroll
  const handleScroll = useCallback(() => {
    const el = messageListRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    autoScrollRef.current = isAtBottom;
  }, []);

  // Call duration timer
  useEffect(() => {
    if (!callActive) return;
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      setCallElapsed(`${m}:${s.toString().padStart(2, '0')}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [callActive, callStartTime]);

  // Stop VAD monitoring
  const stopVAD = useCallback(() => {
    if (vadRafRef.current) { cancelAnimationFrame(vadRafRef.current); vadRafRef.current = 0; }
    if (vadTimerRef.current) { clearTimeout(vadTimerRef.current); vadTimerRef.current = null; }
    if (audioContextRef.current) { audioContextRef.current.close().catch(() => {}); audioContextRef.current = null; }
    analyserRef.current = null;
    hasSpokenRef.current = false;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioRef.current) {
        audioRef.current.pause();
      }
      stopVAD();
    };
  }, [stopVAD]);

  // Start recording within an active call (with VAD)
  const startCallRecording = useCallback(async () => {
    if (!callActiveRef.current) return;
    setCallPhase('recording');
    setCallStatusText('Listening...');
    stopVAD();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!callActiveRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      chunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      // Wire onstop directly so it works for each new MediaRecorder instance
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size > 0) handleCallVoiceSendRef.current(blob);
      };
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();

      // Set up VAD: detect silence after user has spoken
      const audioCtx = new AudioContext();
      audioContextRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      analyserRef.current = analyser;
      hasSpokenRef.current = false;

      const SPEECH_THRESHOLD = 3;    // RMS level to consider as speech (low for mobile mics)
      const SILENCE_DURATION = 1800; // ms of silence before auto-stop

      const dataArray = new Uint8Array(analyser.fftSize);

      const checkAudio = () => {
        if (!callActiveRef.current || mediaRecorderRef.current?.state !== 'recording') return;

        analyser.getByteTimeDomainData(dataArray);
        // Calculate RMS (root mean square) for volume level
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const val = (dataArray[i] - 128) / 128;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / dataArray.length) * 100;

        if (rms > SPEECH_THRESHOLD) {
          // User is speaking
          if (!hasSpokenRef.current) {
            hasSpokenRef.current = true;
            setCallStatusText('Speaking...');
          }
          if (vadTimerRef.current) { clearTimeout(vadTimerRef.current); vadTimerRef.current = null; }
        } else if (hasSpokenRef.current && !vadTimerRef.current) {
          // User was speaking but now silent — start countdown
          vadTimerRef.current = setTimeout(() => {
            if (callActiveRef.current && mediaRecorderRef.current?.state === 'recording') {
              // Auto-stop recording after silence
              mediaRecorderRef.current.stop();
              if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
              }
              stopVAD();
            }
          }, SILENCE_DURATION);
        }

        vadRafRef.current = requestAnimationFrame(checkAudio);
      };
      vadRafRef.current = requestAnimationFrame(checkAudio);
    } catch {
      setCallStatusText('Microphone access denied');
    }
  }, [stopVAD]);

  // Stop recording and send audio
  const stopCallRecording = useCallback(() => {
    stopVAD();
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [stopVAD]);

  // Process and send recorded audio, then auto-cycle
  const handleCallVoiceSend = useCallback(
    async (blob: Blob) => {
      if (!callActiveRef.current) return;
      setCallPhase('processing');
      setCallStatusText('Thinking...');

      let sessionId = activeSessionId;
      if (!sessionId) {
        sessionId = createSession(activeBotName || undefined);
      }

      const userMsgId = generateId();
      const assistantMsgId = generateId();

      addMessage(sessionId, { id: userMsgId, type: 'user', text: 'Voice message...', timestamp: Date.now() });
      addMessage(sessionId, {
        id: assistantMsgId, type: 'assistant', text: '',
        state: { status: 'thinking', userPrompt: 'Voice message', responseText: '', toolCalls: [] },
        timestamp: Date.now(),
      });
      autoScrollRef.current = true;

      try {
        const params = new URLSearchParams();
        if (activeBotName) params.set('botName', activeBotName);
        params.set('chatId', sessionId);
        params.set('tts', 'doubao');
        params.set('voiceMode', 'true');
        params.set('sendCards', 'false');

        const res = await fetch(`/api/voice?${params.toString()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/webm', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: blob,
        });

        if (!res.ok) {
          const errText = await res.text();
          updateMessageText(sessionId, userMsgId, 'Voice (failed)');
          updateMessageState(sessionId, assistantMsgId, {
            status: 'error', userPrompt: '', responseText: '', toolCalls: [], errorMessage: errText,
          });
          if (callActiveRef.current) startCallRecording();
          return;
        }

        const ct = res.headers.get('content-type') || '';

        if (ct.includes('audio/')) {
          const audioBlob = await res.blob();
          const th = res.headers.get('x-transcript');
          const rh = res.headers.get('x-response-text');
          const transcript = th ? decodeBase64Utf8(th) : 'Voice message';
          const responseText = rh ? decodeBase64Utf8(rh) : '';

          updateMessageText(sessionId, userMsgId, transcript);
          updateMessageState(sessionId, assistantMsgId, {
            status: 'complete', userPrompt: transcript, responseText, toolCalls: [],
          });

          // Play audio response using Web Audio API (works on mobile)
          setCallPhase('playing');
          setCallStatusText('Speaking...');
          const arrayBuf = await audioBlob.arrayBuffer();
          const pCtx = playbackCtxRef.current;
          if (pCtx && pCtx.state !== 'closed') {
            try {
              if (pCtx.state === 'suspended') await pCtx.resume();
              const audioBuf = await pCtx.decodeAudioData(arrayBuf);
              const source = pCtx.createBufferSource();
              source.buffer = audioBuf;
              source.connect(pCtx.destination);
              playbackSourceRef.current = source;
              source.onended = () => {
                playbackSourceRef.current = null;
                if (callActiveRef.current) startCallRecording();
              };
              source.start();
            } catch {
              // Fallback: try HTML Audio element
              const url = URL.createObjectURL(audioBlob);
              const audio = new Audio(url);
              audioRef.current = audio;
              audio.onended = () => { URL.revokeObjectURL(url); if (callActiveRef.current) startCallRecording(); };
              audio.play().catch(() => { if (callActiveRef.current) startCallRecording(); });
            }
          } else {
            // No playback context — skip to next recording
            if (callActiveRef.current) startCallRecording();
          }
        } else {
          const data = await res.json();
          updateMessageText(sessionId, userMsgId, data.transcript || 'Voice message');
          updateMessageState(sessionId, assistantMsgId, {
            status: 'complete', userPrompt: data.transcript || '', responseText: data.responseText || '', toolCalls: [],
          });
          // No audio to play — auto-cycle
          if (callActiveRef.current) startCallRecording();
        }
      } catch (err) {
        updateMessageText(sessionId, userMsgId, 'Voice (error)');
        updateMessageState(sessionId, assistantMsgId, {
          status: 'error', userPrompt: '', responseText: '', toolCalls: [],
          errorMessage: `${err}`,
        });
        if (callActiveRef.current) startCallRecording();
      }
    },
    [activeSessionId, activeBotName, createSession, addMessage, updateMessageState, updateMessageText, token, startCallRecording],
  );

  // Keep ref in sync so startCallRecording's onstop can call latest handleCallVoiceSend
  useEffect(() => {
    handleCallVoiceSendRef.current = handleCallVoiceSend;
  }, [handleCallVoiceSend]);

  // Start a call — create playback AudioContext during user gesture (required for mobile)
  const startCall = useCallback(async () => {
    // Create AudioContext in user gesture context so playback works on iOS/Android
    if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
      playbackCtxRef.current = new AudioContext();
    }
    if (playbackCtxRef.current.state === 'suspended') {
      await playbackCtxRef.current.resume();
    }
    callActiveRef.current = true;
    setCallActive(true);
    setCallStartTime(Date.now());
    setCallElapsed('0:00');
    startCallRecording();
  }, [startCallRecording]);

  // End the call
  const endCall = useCallback(() => {
    callActiveRef.current = false;
    setCallActive(false);
    setCallStatusText('');
    stopVAD();
    // Stop everything
    if (mediaRecorderRef.current?.state === 'recording') {
      // Discard — don't trigger onstop send
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      // Revoke any object URL to prevent memory leak
      if (audioRef.current.src?.startsWith('blob:')) URL.revokeObjectURL(audioRef.current.src);
      audioRef.current = null;
    }
    if (playbackSourceRef.current) {
      try { playbackSourceRef.current.stop(); } catch {}
      playbackSourceRef.current = null;
    }
    if (playbackCtxRef.current) {
      playbackCtxRef.current.close().catch(() => {});
      playbackCtxRef.current = null;
    }
  }, [stopVAD]);

  // Tap center button during call: stop current recording and send
  const handleCallTap = useCallback(() => {
    if (callPhase === 'recording') {
      stopCallRecording();
    } else if (callPhase === 'playing') {
      // Skip playback, start recording next turn
      if (playbackSourceRef.current) {
        try { playbackSourceRef.current.stop(); } catch {}
        playbackSourceRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      startCallRecording();
    }
  }, [callPhase, stopCallRecording, startCallRecording]);

  // ── Speech-to-text (Web Speech API) ──
  const startSTT = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;

    let finalTranscript = '';
    const baseInput = input;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += t;
        } else {
          interim += t;
        }
      }
      setInput(baseInput + finalTranscript + interim);
    };

    recognition.onerror = () => {
      setSttActive(false);
      sttRef.current = null;
    };

    recognition.onend = () => {
      setSttActive(false);
      sttRef.current = null;
    };

    sttRef.current = recognition;
    recognition.start();
    setSttActive(true);
  }, [input]);

  const stopSTT = useCallback(() => {
    if (sttRef.current) {
      sttRef.current.stop();
      sttRef.current = null;
    }
    setSttActive(false);
  }, []);

  const toggleSTT = useCallback(() => {
    if (sttActive) {
      stopSTT();
    } else {
      startSTT();
    }
  }, [sttActive, startSTT, stopSTT]);

  // ── File upload handlers ──
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newFiles: PendingFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      newFiles.push({ file, previewUrl });
    }
    setPendingFiles((prev) => [...prev, ...newFiles]);
    // Reset input so same file can be selected again
    e.target.value = '';
  }, []);

  const removeFile = useCallback((index: number) => {
    setPendingFiles((prev) => {
      const next = [...prev];
      if (next[index].previewUrl) URL.revokeObjectURL(next[index].previewUrl!);
      next.splice(index, 1);
      return next;
    });
  }, []);

  // Cleanup file preview URLs on unmount
  useEffect(() => {
    return () => {
      pendingFiles.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Upload files to server and return attachments
  const uploadFiles = useCallback(async (files: PendingFile[], sessionId: string): Promise<FileAttachment[]> => {
    const attachments: FileAttachment[] = [];
    for (const f of files) {
      try {
        const params = new URLSearchParams({ filename: f.file.name, chatId: sessionId });
        if (token) params.set('token', token);
        const res = await fetch(`/api/upload?${params.toString()}`, {
          method: 'POST',
          headers: {
            'Content-Type': f.file.type || 'application/octet-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: f.file,
        });
        if (res.ok) {
          const data = await res.json();
          attachments.push({
            name: f.file.name,
            type: f.file.type || 'application/octet-stream',
            size: f.file.size,
            url: `/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(data.filename)}`,
            path: data.path,
          });
        } else {
          console.error(`Upload failed for ${f.file.name}: ${res.status} ${res.statusText}`);
        }
      } catch (err) {
        console.error(`Upload error for ${f.file.name}:`, err);
      }
    }
    return attachments;
  }, [token]);

  // Send message
  const handleSend = useCallback(async () => {
    const text = input.trim();
    const hasFiles = pendingFiles.length > 0;
    if ((!text && !hasFiles) || !connected) return;

    // Stop STT if active
    if (sttActive) stopSTT();

    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = createSession(activeBotName || undefined);
    }

    // Check for /stop command
    if (text === '/stop' && !hasFiles) {
      send({ type: 'stop', chatId: sessionId });
      setInput('');
      return;
    }

    // Upload files first if any
    let fileInfo = '';
    let attachments: FileAttachment[] = [];
    if (hasFiles) {
      attachments = await uploadFiles(pendingFiles, sessionId);
      if (attachments.length > 0) {
        const lines = attachments.map((a) => {
          const cat = fileCategory(a.type);
          if (cat === 'image') return `  - ${a.path} (image: ${a.name}, ${formatFileSize(a.size)})`;
          if (cat === 'audio') return `  - ${a.path} (audio: ${a.name}, ${formatFileSize(a.size)})`;
          if (cat === 'video') return `  - ${a.path} (video: ${a.name}, ${formatFileSize(a.size)})`;
          return `  - ${a.path} (${a.name}, ${formatFileSize(a.size)})`;
        });
        fileInfo = `\n\nThe user uploaded ${attachments.length} file(s):\n${lines.join('\n')}\n\nFor text-based files (txt, csv, json, md, code, etc.), use the Read tool. For images, use the Read tool to view them. For binary files (pdf, docx, xlsx, etc.), acknowledge receipt and describe what you can help with.`;
      }
      // Clear pending files
      pendingFiles.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
      setPendingFiles([]);
    }

    const fullText = (text + fileInfo).trim();

    // If upload failed and no text, abort
    if (!fullText) {
      // Show error as system message
      if (hasFiles) {
        addMessage(sessionId, {
          id: generateId(),
          type: 'system',
          text: 'File upload failed. Please try again.',
          timestamp: Date.now(),
        });
      }
      return;
    }

    // Don't show fallback text when attachments exist — the file cards speak for themselves
    const displayText = text || '';

    const userMsgId = generateId();
    const assistantMsgId = generateId();

    // Add user message with attachments
    addMessage(sessionId, {
      id: userMsgId,
      type: 'user',
      text: displayText,
      timestamp: Date.now(),
      ...(attachments.length > 0 ? { attachments } : {}),
    });

    // Add placeholder assistant message
    addMessage(sessionId, {
      id: assistantMsgId,
      type: 'assistant',
      text: '',
      state: {
        status: 'thinking',
        userPrompt: fullText,
        responseText: '',
        toolCalls: [],
      },
      timestamp: Date.now(),
    });

    // Send via WebSocket
    send({
      type: 'chat',
      botName: activeBotName || 'default',
      chatId: sessionId,
      text: fullText,
      messageId: assistantMsgId,
    });

    setInput('');
    autoScrollRef.current = true;
  }, [input, connected, activeSessionId, activeBotName, createSession, addMessage, send, pendingFiles, uploadFiles, sttActive, stopSTT]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleAnswer = useCallback(
    (toolUseId: string, answer: string) => {
      if (!activeSessionId) return;
      send({
        type: 'answer',
        chatId: activeSessionId,
        toolUseId,
        answer,
      });
    },
    [activeSessionId, send],
  );

  const handleHintClick = useCallback(
    (text: string) => {
      setInput(text);
      // Focus the textarea
      textareaRef.current?.focus();
    },
    [],
  );

  // ── File panel & preview state ──
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [filePanelWidth, setFilePanelWidth] = useState(420);
  const resizingRef = useRef(false);
  const [previewFile, setPreviewFile] = useState<FileAttachment | null>(null);

  // Open panel and show preview when clicking a file
  const openPreview = useCallback((file: FileAttachment) => {
    setPreviewFile(file);
    setFilePanelOpen(true);
  }, []);

  // Collect all attachments from messages in this session
  const allFiles = useMemo(() => {
    const files: FileAttachment[] = [];
    for (const msg of messages) {
      if (msg.attachments) files.push(...msg.attachments);
    }
    return files;
  }, [messages]);

  // Resize handler for file panel
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startWidth = filePanelWidth;

    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = startX - ev.clientX;
      setFilePanelWidth(Math.max(280, Math.min(700, startWidth + delta)));
    };
    const onUp = () => {
      resizingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [filePanelWidth]);

  const hasMessages = messages.length > 0;

  return (
    <div className={styles.chatLayout}>
    <div className={styles.container}>
      {/* Messages or empty state */}
      {hasMessages ? (
        <div
          className={styles.messageList}
          ref={messageListRef}
          onScroll={handleScroll}
        >
          <div className={styles.messageListInner}>
            {messages.map((msg, i) => (
              <div
                key={msg.id}
                className={`${styles.messageRow} ${
                  msg.type === 'user'
                    ? styles.messageRowUser
                    : msg.type === 'system'
                      ? styles.messageRowSystem
                      : styles.messageRowAssistant
                }`}
                style={{ animationDelay: `${Math.min(i * 50, 300)}ms` }}
              >
                {msg.type === 'user' && (
                  <div className={styles.userBubbleWrap}>
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className={styles.attachGrid}>
                        {msg.attachments.map((file, fi) => (
                          <FileAttachmentCard key={fi} file={file} onPreview={openPreview} />
                        ))}
                      </div>
                    )}
                    {msg.text && <div className={styles.userBubble}>{msg.text}</div>}
                  </div>
                )}
                {msg.type === 'system' && (
                  <div className={styles.systemBubble}>{msg.text}</div>
                )}
                {msg.type === 'assistant' && (
                  <AssistantMessageView msg={msg} onAnswer={handleAnswer} />
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <EmptyState onHintClick={handleHintClick} />
      )}

      {/* Call overlay */}
      {callActive && (
        <div className={styles.callOverlay}>
          <div className={styles.callContent}>
            <div className={styles.callHeader}>
              <div className={styles.callBotName}>{activeBotName || 'Claude'}</div>
              <div className={styles.callTimer}>{callElapsed}</div>
            </div>

            <button
              className={`${styles.callCenterBtn} ${
                callPhase === 'recording' ? styles.callCenterRecording : ''
              } ${callPhase === 'processing' ? styles.callCenterProcessing : ''} ${
                callPhase === 'playing' ? styles.callCenterPlaying : ''
              }`}
              onClick={handleCallTap}
              disabled={callPhase === 'processing'}
            >
              <IconMic />
            </button>

            <div className={styles.callStatus}>{callStatusText}</div>

            <button className={styles.callHangup} onClick={endCall} title="End call">
              <IconPhoneOff />
            </button>
          </div>
        </div>
      )}

      {/* Input area */}
      <div className={styles.inputArea}>
        {/* File preview bar */}
        {pendingFiles.length > 0 && (
          <div className={styles.filePreviews}>
            {pendingFiles.map((f, i) => (
              <div key={i} className={styles.filePreview}>
                {f.previewUrl ? (
                  <img src={f.previewUrl} alt={f.file.name} className={styles.filePreviewImg} />
                ) : (
                  <div className={styles.filePreviewIcon}>
                    <IconPaperclip />
                  </div>
                )}
                <span className={styles.filePreviewName}>{f.file.name}</span>
                <button className={styles.filePreviewRemove} onClick={() => removeFile(i)}>
                  <IconX />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className={styles.inputWrapper}>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          <button
            className={styles.attachBtn}
            onClick={() => fileInputRef.current?.click()}
            disabled={!connected}
            title="Upload files"
          >
            <IconPaperclip />
          </button>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            placeholder={connected ? (sttActive ? 'Listening...' : 'Ask anything...') : 'Connecting...'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={!connected}
          />
          <button
            className={`${styles.sttBtn} ${sttActive ? styles.sttBtnActive : ''}`}
            onClick={toggleSTT}
            disabled={!connected}
            title={sttActive ? 'Stop voice input' : 'Voice input'}
          >
            <IconMicSmall />
          </button>
          <button
            className={styles.callBtn}
            onClick={startCall}
            disabled={!connected || callActive}
            title="Start voice call"
          >
            <IconPhone />
          </button>
          <button
            className={styles.sendBtn}
            onClick={handleSend}
            disabled={(!input.trim() && pendingFiles.length === 0) || !connected}
            title="Send (Enter)"
          >
            <IconSend />
          </button>
        </div>
        <div className={styles.inputHint}>
          <span>Enter to send, Shift+Enter for newline</span>
          <span>{connected ? '' : 'Reconnecting...'}</span>
        </div>
      </div>

      {/* File panel toggle button (floating) */}
      {allFiles.length > 0 && (
        <button
          className={`${styles.filePanelToggle} ${filePanelOpen ? styles.filePanelToggleActive : ''}`}
          onClick={() => { setFilePanelOpen(!filePanelOpen); if (filePanelOpen) setPreviewFile(null); }}
          title={filePanelOpen ? 'Hide files' : `Show files (${allFiles.length})`}
        >
          <IconFileSidebar />
          <span className={styles.filePanelBadge}>{allFiles.length}</span>
        </button>
      )}
    </div>{/* end container */}

    {/* Right side panel: file list or file preview */}
    {filePanelOpen && allFiles.length > 0 && (
      <>
        <div className={styles.resizeHandle} onMouseDown={handleResizeStart} />
        <div className={styles.filePanel} style={{ width: filePanelWidth }}>
          {previewFile ? (
            /* ── Preview view ── */
            <>
              <div className={styles.filePanelHeader}>
                <button className={styles.panelBackBtn} onClick={() => setPreviewFile(null)} title="Back to files">
                  <IconChevronLeft />
                </button>
                <span className={styles.previewTitle}>{previewFile.name}</span>
                <a href={previewFile.url} download={previewFile.name} className={styles.panelHeaderIcon} title="Download">
                  <IconDownload />
                </a>
                <button className={styles.panelHeaderIcon} onClick={() => { setFilePanelOpen(false); setPreviewFile(null); }}>
                  <IconX />
                </button>
              </div>
              <div className={styles.previewBody}>
                <FilePreviewContent file={previewFile} />
              </div>
            </>
          ) : (
            /* ── File list view ── */
            <>
              <div className={styles.filePanelHeader}>
                <span>Files ({allFiles.length})</span>
                <button className={styles.filePanelClose} onClick={() => setFilePanelOpen(false)}>
                  <IconX />
                </button>
              </div>
              <div className={styles.filePanelList}>
                {allFiles.map((file, i) => (
                  <FileAttachmentCard key={i} file={file} compact onPreview={openPreview} />
                ))}
              </div>
            </>
          )}
        </div>
      </>
    )}
    </div>
  );
}
