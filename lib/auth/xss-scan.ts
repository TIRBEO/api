// Edge-safe XSS detection (no DB imports — safe for Next.js middleware).
// Only blocks patterns that are definitively injection attacks.
// Natural language mentions of alert(), fetch(), eval() are NOT blocked.

const XSS_PATTERNS: { regex: RegExp; label: string }[] = [
  // HTML injection — require word-boundary after tag name to avoid
  // false positives on <formula>, <form>, <metadata>, etc.
  { regex: /<\s*\/?\s*(script|iframe|object|embed|svg|math)\b[\s>\/]/i, label: 'dangerous_tag' },

  // Dangerous protocol handlers
  { regex: /javascript\s*:/i, label: 'javascript_proto' },
  { regex: /vbscript\s*:/i, label: 'vbscript_proto' },
  { regex: /data\s*:\s*text\/html/i, label: 'data_html' },

  // Inline event handlers in an HTML-attribute context
  { regex: /on(?:error|load|click|mouseover|mouseenter|focus|blur|change|submit|pointerover|pointerenter)\s*=\s*["']/i, label: 'inline_handler' },

  // CSS injection inside style attributes
  { regex: /style\s*=\s*["']?[^"']*(?:expression|behavior|moz-binding)[^"']*["']?/i, label: 'css_expression' },

  // DOM manipulation that implies script execution
  { regex: /document\.(?:cookie|location|domain|write)\b/i, label: 'dom_access' },
  { regex: /window\.(?:location|top|parent)\b/i, label: 'window_access' },
];

export function detectXss(value: string | null | undefined): string | null {
  if (!value) return null;
  for (const { regex, label } of XSS_PATTERNS) {
    if (regex.test(value)) return label;
  }
  return null;
}
