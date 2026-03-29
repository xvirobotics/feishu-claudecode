/* ---- File Preview Content (rendered inside the right panel) ---- */

import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileAttachment } from '../../types';
import { fileCategory, fileExt, isTextPreviewable, isEmbedPreviewable, isOfficePreviewable, formatFileSize, serverPreviewUrl } from './helpers';
import { IconFile, IconDownload } from './icons';
import styles from '../ChatView.module.css';

export function FilePreviewContent({ file }: { file: FileAttachment }) {
  const cat = fileCategory(file.type);
  const ext = fileExt(file.name);

  /* ── Image ── */
  if (cat === 'image') {
    return <img src={file.url} alt={file.name} className={styles.previewImage} />;
  }

  /* ── Video ── */
  if (cat === 'video') {
    return <video src={file.url} controls className={styles.previewVideo} />;
  }

  /* ── Audio ── */
  if (cat === 'audio') {
    return (
      <div className={styles.previewAudioWrap}>
        <div className={styles.previewAudioIcon}><IconFile /></div>
        <div className={styles.previewAudioName}>{file.name}</div>
        <audio src={file.url} controls className={styles.previewAudioPlayer} />
      </div>
    );
  }

  /* ── PDF / HTML iframe ── */
  if (isEmbedPreviewable(file.name)) {
    return (
      <iframe
        src={serverPreviewUrl(file.url)}
        className={styles.previewIframe}
        title={file.name}
        sandbox={ext === 'pdf' ? undefined : 'allow-scripts allow-same-origin'}
      />
    );
  }

  /* ── DOCX ── */
  const officeType = isOfficePreviewable(file.name);
  if (officeType === 'docx') {
    return <DocxPreview url={file.url} />;
  }

  /* ── XLSX ── */
  if (officeType === 'xlsx') {
    return <XlsxPreview url={file.url} />;
  }

  /* ── Markdown ── */
  if (ext === 'md' || ext === 'markdown') {
    return <MarkdownPreview url={file.url} />;
  }

  /* ── Text / Code ── */
  if (isTextPreviewable(file.name, file.type)) {
    return <TextPreview url={file.url} />;
  }

  /* ── Unsupported ── */
  return (
    <div className={styles.previewUnsupported}>
      <div className={styles.previewUnsupportedIcon}>{ext.toUpperCase().slice(0, 4) || '?'}</div>
      <div className={styles.previewUnsupportedName}>{file.name}</div>
      <div className={styles.previewUnsupportedSize}>{formatFileSize(file.size)}</div>
      <a href={file.url} download={file.name} className={styles.previewDownloadBtn}>
        <IconDownload /> Download
      </a>
    </div>
  );
}

/* ── Sub-components ── */

function DocxPreview({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ renderAsync }, res] = await Promise.all([
          import('docx-preview'),
          fetch(url),
        ]);
        const blob = await res.blob();
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = '';
        await renderAsync(blob, containerRef.current, undefined, {
          className: 'docx-preview',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: true,
        });
      } catch (err) {
        if (!cancelled && containerRef.current) {
          containerRef.current.textContent = `Error rendering DOCX: ${err}`;
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  return (
    <>
      {loading && <div className={styles.previewLoading}>Loading document...</div>}
      <div ref={containerRef} className={styles.previewDocx} />
    </>
  );
}

function XlsxPreview({ url }: { url: string }) {
  const [html, setHtml] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [XLSX, res] = await Promise.all([
          import('xlsx'),
          fetch(url),
        ]);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
        const sheets: string[] = [];
        for (const name of wb.SheetNames) {
          const ws = wb.Sheets[name];
          sheets.push(`<h3>${name}</h3>` + XLSX.utils.sheet_to_html(ws));
        }
        setHtml(sheets.join(''));
      } catch (err) {
        if (!cancelled) setHtml(`<p>Error rendering spreadsheet: ${err}</p>`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  if (loading) return <div className={styles.previewLoading}>Loading spreadsheet...</div>;
  return <div className={styles.previewXlsx} dangerouslySetInnerHTML={{ __html: html }} />;
}

function MarkdownPreview({ url }: { url: string }) {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(url).then((r) => r.text()).then((t) => { if (!cancelled) setContent(t); }).catch(() => { if (!cancelled) setContent('Error loading file'); });
    return () => { cancelled = true; };
  }, [url]);

  if (content === null) return <div className={styles.previewLoading}>Loading...</div>;
  return (
    <div className={styles.previewMarkdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function TextPreview({ url }: { url: string }) {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(url).then((r) => r.text()).then((t) => { if (!cancelled) setContent(t); }).catch(() => { if (!cancelled) setContent('Error loading file'); });
    return () => { cancelled = true; };
  }, [url]);

  if (content === null) return <div className={styles.previewLoading}>Loading...</div>;
  return (
    <div className={styles.previewCode}>
      <pre>{content}</pre>
    </div>
  );
}
