import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

/**
 * Assistant replies rendered as Markdown (paragraphs, lists, headings, tables, fenced code). Output
 * goes through DOMPurify before it reaches the DOM; links open in a new tab with no referrer.
 * Code blocks are the only monospace text in the product (--code), matching docs/BRAND.md.
 */

marked.setOptions({ gfm: true, breaks: true, async: false });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'img', 'svg', 'math', 'iframe', 'form', 'input', 'button'],
  FORBID_ATTR: ['style', 'onerror', 'onload'],
};

export function renderMarkdown(src: string): string {
  const html = marked.parse(src) as string;
  return DOMPurify.sanitize(html, PURIFY);
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  // eslint-disable-next-line react/no-danger
  return <div className={`md ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
}
