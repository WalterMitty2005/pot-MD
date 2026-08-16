import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { open } from '@tauri-apps/api/shell';

import 'katex/dist/katex.min.css';
import './Markdown.css';

/**
 * Detect whether the text is likely to contain Markdown syntax,
 * so plain translations are not accidentally reformatted.
 */
export function looksLikeMarkdown(text) {
    if (typeof text !== 'string' || text === '') {
        return false;
    }
    // fenced code block ``` or ~~~
    if (/^(```|~~~)/m.test(text)) return true;
    // display math $$...$$
    if (/\$\$.+?\$\$/s.test(text)) return true;
    // inline math $...$ or \( ... \)
    if (/(^|\s)\$[^\s$][^$\n]*\$/m.test(text) || /\\\(.+?\\\)/s.test(text)) return true;
    // gfm table: | --- | separator line
    if (/^\s*\|?[-: ]*\|[-|: ]+\|?\s*$/m.test(text) && text.includes('|')) return true;
    // heading
    if (/^#{1,6}\s+\S/m.test(text)) return true;
    // bold / italic with paired markers
    if (/\*\*[^*\n]+\*\*/.test(text) || /__[^_\n]+__/.test(text)) return true;
    if (/(^|\s)\*[^*\n]+\*(\s|$)/m.test(text) || /(^|\s)_[^_\n]+_(\s|$)/m.test(text)) return true;
    // strikethrough
    if (/~~[^~\n]+~~/.test(text)) return true;
    // unordered / ordered list (multiple lines to reduce false positives)
    const listLines = text.split('\n').filter((line) => /^\s*([-*+]|\d+[.)])\s+\S/.test(line)).length;
    if (listLines >= 2) return true;
    // inline code with backticks
    if (/`[^`\n]+`/.test(text)) return true;
    // link or image
    if (/!?\[[^\]\n]*\]\([^)\n]+\)/.test(text)) return true;
    return false;
}

export default function Markdown({ text, fontSize }) {
    return (
        <div
            className='pot-markdown-body select-text'
            style={{ fontSize: fontSize ? `${fontSize}px` : undefined }}
        >
            <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[
                    rehypeKatex,
                    [rehypeHighlight, { detect: true, ignoreMissing: true }],
                ]}
                components={{
                    a: ({ node, href, children, ...props }) => (
                        <a
                            {...props}
                            href={href}
                            onClick={(e) => {
                                // open external links with the system browser instead of navigating inside the window
                                e.preventDefault();
                                if (typeof href === 'string' && /^https?:\/\//.test(href)) {
                                    open(href).catch(() => {});
                                }
                            }}>
                            {children}
                        </a>
                    ),
                }}>
                {text}
            </ReactMarkdown>
        </div>
    );
}
