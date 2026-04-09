/* ---- Code Block with copy button ---- */

import { useState, useCallback, type ReactNode } from 'react';
import { IconCopy, IconCheck } from './icons';
import styles from '../ChatView.module.css';

interface CodeBlockProps {
  language: string;
  children: string;
}

export function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [children]);

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
        <span className={styles.codeBlockLang}>{language || 'code'}</span>
        <button
          className={`${styles.codeBlockCopy} ${copied ? styles.codeBlockCopied : ''}`}
          onClick={handleCopy}
        >
          {copied ? <><IconCheck /> Copied</> : <><IconCopy /> Copy</>}
        </button>
      </div>
      <div className={styles.codeBlockBody}>
        <pre>
          <code className={language ? `language-${language}` : ''}>
            {children}
          </code>
        </pre>
      </div>
    </div>
  );
}
