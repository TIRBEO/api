/**
 * Email Brain unit tests — renderer escaping/substitution, content schema
 * validation, digest grouping. No DB or network required.
 */
import { describe, expect, it } from 'vitest';
import { renderBlocksHtml, renderBlocksText } from '@/features/email-brain/render';
import { ContentSchema } from '@/features/email-brain/ai';

const VARS = {
  'user.name': 'Alex <script>alert(1)</script>',
  dashboardUrl: 'https://dashboard.tirbeo.app',
};

describe('emailBrain render', () => {
  it('escapes HTML-injected variable values', () => {
    const html = renderBlocksHtml(
      { subject: 'Hi', blocks: [{ type: 'paragraph', text: 'Hello {{user.name}}' }] },
      VARS,
    );
    expect(html).toContain('Alex &lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('escapes body but keeps trusted button URLs working', () => {
    const html = renderBlocksHtml(
      {
        subject: 'Hi',
        blocks: [
          { type: 'paragraph', text: 'x' },
          { type: 'button', label: 'Open', url: '{{dashboardUrl}}' },
        ],
      },
      VARS,
    );
    expect(html).toContain('href="https://dashboard.tirbeo.app"');
  });

  it('drops buttons whose URL resolves to a non-http(s) scheme', () => {
    const html = renderBlocksHtml(
      { subject: 'Hi', blocks: [{ type: 'button', label: 'X', url: 'javascript:alert(1)' }] },
      VARS,
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
  });

  it('renders plain text without markup', () => {
    const text = renderBlocksText(
      {
        subject: 'Hi',
        blocks: [
          { type: 'heading', text: 'Title' },
          { type: 'paragraph', text: 'Body {{user.name}}' },
          { type: 'list', items: ['one', 'two'] },
        ],
      },
      VARS,
    );
    expect(text).toContain('TITLE');
    expect(text).toContain('• one');
    expect(text).not.toContain('<h2');
    expect(text).not.toContain('<li');
  });
});

describe('emailBrain content schema', () => {
  it('accepts a valid block set', () => {
    const parsed = ContentSchema.safeParse({
      subject: 'Hello',
      blocks: [
        { type: 'paragraph', text: 'Welcome' },
        { type: 'button', label: 'Go', url: '{{dashboardUrl}}' },
        { type: 'alert', tone: 'info', text: 'Heads up' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown block types (AI cannot invent HTML)', () => {
    const parsed = ContentSchema.safeParse({
      subject: 'x',
      blocks: [{ type: 'script', text: 'evil' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects oversized content', () => {
    const parsed = ContentSchema.safeParse({
      subject: 'x',
      blocks: Array.from({ length: 25 }, (_, i) => ({ type: 'paragraph', text: `p${i}` })),
    });
    expect(parsed.success).toBe(false);
  });
});
