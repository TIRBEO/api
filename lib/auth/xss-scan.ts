// Edge-safe XSS detection (no DB imports — safe for Next.js middleware).

const XSS_PATTERNS: { regex: RegExp; label: string }[] = [
  { regex: /<\s*script[\s>]/i, label: 'script_tag' },
  { regex: /<\s*\/\s*script/i, label: 'script_close' },
  { regex: /<\s*iframe[\s>]/i, label: 'iframe_tag' },
  { regex: /<\s*object[\s>]/i, label: 'object_tag' },
  { regex: /<\s*embed[\s>]/i, label: 'embed_tag' },
  { regex: /<\s*svg[\s>]/i, label: 'svg_tag' },
  { regex: /<\s*math[\s>]/i, label: 'math_tag' },
  { regex: /<\s*template[\s>]/i, label: 'template_tag' },
  { regex: /<\s*link[\s>]/i, label: 'link_tag' },
  { regex: /<\s*meta[\s>]/i, label: 'meta_tag' },
  { regex: /<\s*form[\s>]/i, label: 'form_tag' },
  { regex: /javascript\s*:/i, label: 'javascript_proto' },
  { regex: /vbscript\s*:/i, label: 'vbscript_proto' },
  { regex: /data\s*:\s*text\/html/i, label: 'data_html' },
  { regex: /on(?:error|load|click|mouseover|mouseenter|focus|blur|change|submit|pointerover|pointerenter)\s*=/i, label: 'inline_handler' },
  { regex: /style\s*=\s*["']?[^"']*(?:expression|behavior|moz-binding|@import)[^"']*["']?/i, label: 'css_expression' },
  { regex: /document\.(?:cookie|location|domain|write)/i, label: 'dom_access' },
  { regex: /window\.(?:location|top|parent)/i, label: 'window_access' },
  { regex: /alert\s*\(/i, label: 'alert_call' },
  { regex: /eval\s*\(/i, label: 'eval_call' },
  { regex: /fetch\s*\(/i, label: 'fetch_call' },
];

export function detectXss(value: string | null | undefined): string | null {
  if (!value) return null;
  for (const { regex, label } of XSS_PATTERNS) {
    if (regex.test(value)) return label;
  }
  return null;
}
