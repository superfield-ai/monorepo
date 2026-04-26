/**
 * Unit tests for renderMarkdown() in WikiRender.tsx.
 *
 * Runs in the headless Chromium environment (same as other apps unit tests).
 * Focuses on HTML escaping (XSS prevention) and transformation correctness.
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/components/WikiRender';

// ── HTML escaping (XSS prevention) ────────────────────────────────────────────

describe('HTML escaping', () => {
  it('escapes < to &lt;', () => {
    expect(renderMarkdown('<script>')).toContain('&lt;script&gt;');
  });

  it('escapes > to &gt;', () => {
    expect(renderMarkdown('a > b')).toContain('a &gt; b');
  });

  it('escapes & to &amp;', () => {
    expect(renderMarkdown('a & b')).toContain('a &amp; b');
  });

  it('<script>alert("xss")</script> → never raw in output', () => {
    const out = renderMarkdown('<script>alert("xss")</script>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('</script>');
    expect(out).toContain('&lt;script&gt;');
  });
});

// ── Headings ──────────────────────────────────────────────────────────────────

describe('headings', () => {
  it('# → <h1>', () => {
    expect(renderMarkdown('# Title')).toContain('<h1>Title</h1>');
  });

  it('## → <h2>', () => {
    expect(renderMarkdown('## Section')).toContain('<h2>Section</h2>');
  });

  it('### → <h3>', () => {
    expect(renderMarkdown('### Sub')).toContain('<h3>Sub</h3>');
  });

  it('###### → <h6>', () => {
    expect(renderMarkdown('###### Deep')).toContain('<h6>Deep</h6>');
  });
});

// ── Inline formatting ─────────────────────────────────────────────────────────

describe('inline formatting', () => {
  it('**bold** → <strong>', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });

  it('*italic* → <em>', () => {
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>');
  });

  it('`code` → <code>', () => {
    expect(renderMarkdown('`code`')).toContain('<code>code</code>');
  });

  it('[text](url) → <a href="url">text</a>', () => {
    const out = renderMarkdown('[click here](http://example.com)');
    expect(out).toContain('<a href="http://example.com">click here</a>');
  });
});

// ── Lists ─────────────────────────────────────────────────────────────────────

describe('lists', () => {
  it('- item → wrapped in <ul>', () => {
    const out = renderMarkdown('- alpha\n- beta');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>alpha</li>');
    expect(out).toContain('<li>beta</li>');
  });
});

// ── Empty input ───────────────────────────────────────────────────────────────

describe('empty input', () => {
  it('returns a string (may be empty)', () => {
    expect(typeof renderMarkdown('')).toBe('string');
  });
});

// ── Mixed content ─────────────────────────────────────────────────────────────

describe('mixed content', () => {
  it('heading + bold + link all rendered', () => {
    const out = renderMarkdown('# Title\n\n**bold** and [link](http://x.com)');
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<a href="http://x.com">link</a>');
  });
});
