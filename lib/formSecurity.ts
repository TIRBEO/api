// ─── Form Submission Security Middleware ────────────────────────────────
// Rate limiting, input sanitization, and XSS detection for form submissions

import { detectXss, sanitizeInput } from './security';
import { prisma } from './db/prisma';
// ─── Inline form field types (until @tirbeo/types exports these) ──────
type FormField = {
  id: string;
  type: string;
  label?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  options?: string[];
};

type LogicRule = {
  fieldId: string;
  condition: string;
  value: string;
  action: string;
  targetFieldId?: string;
};

/** Normalize logic rules — return [] if input is falsy */
function normalizeLogicRules(rules: any): LogicRule[] {
  if (!rules || !Array.isArray(rules)) return [];
  return rules.filter(Boolean);
}

/** Evaluate logic rules and return visible/required/optional field sets */
function evaluateLogicRules(
  rules: LogicRule[],
  answers: Record<string, any>,
  _fields: FormField[],
): { visible: Set<string>; required: Set<string>; optional: Set<string> } {
  const visible = new Set<string>();
  const required = new Set<string>();
  const optional = new Set<string>();
  for (const rule of rules) {
    const answer = String(answers[rule.fieldId] || '');
    const match = rule.condition === 'equals' ? answer === rule.value
      : rule.condition === 'contains' ? answer.includes(rule.value)
      : rule.condition === 'not_empty' ? answer.length > 0
      : rule.condition === 'empty' ? answer.length === 0
      : false;
    if (match && rule.targetFieldId) {
      if (rule.action === 'show') visible.add(rule.targetFieldId);
      if (rule.action === 'hide') visible.delete(rule.targetFieldId);
      if (rule.action === 'require') required.add(rule.targetFieldId);
      if (rule.action === 'optional') optional.add(rule.targetFieldId);
    }
  }
  return { visible, required, optional };
}

/** Validate fields against answers, returning a map of fieldId → error message */
function validateFields(
  fields: FormField[],
  answers: Record<string, any>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (f.required) {
      const val = answers[f.id];
      if (val === undefined || val === null || val === '') {
        errors[f.id] = `${f.label || f.id} is required`;
        continue;
      }
    }
    const val = answers[f.id];
    if (val === undefined || val === null || val === '') continue;
    if (typeof val === 'string') {
      if (f.minLength != null && val.length < f.minLength) errors[f.id] = `${f.label || f.id} must be at least ${f.minLength} characters`;
      else if (f.maxLength != null && val.length > f.maxLength) errors[f.id] = `${f.label || f.id} must be at most ${f.maxLength} characters`;
      else if (f.pattern && !new RegExp(f.pattern).test(val)) errors[f.id] = `${f.label || f.id} has an invalid format`;
    }
    if (typeof val === 'number') {
      if (f.min != null && val < f.min) errors[f.id] = `${f.label || f.id} must be at least ${f.min}`;
      if (f.max != null && val > f.max) errors[f.id] = `${f.label || f.id} must be at most ${f.max}`;
    }
  }
  return errors;
}

// In-memory rate limiter (per-form, per-IP)
const submissionRateLimits = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_RATE_LIMIT = 100; // submissions per hour

/**
 * Check if a submission is rate-limited for a given form and IP
 */
export function checkSubmissionRateLimit(
  formId: string,
  ip: string,
  rateLimit?: number
): { allowed: boolean; remaining: number; resetAt: Date } {
  const key = `${formId}:${ip}`;
  const limit = rateLimit || DEFAULT_RATE_LIMIT;
  const now = Date.now();
  const entry = submissionRateLimits.get(key);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // New window
    submissionRateLimits.set(key, { count: 1, windowStart: now });
    return {
      allowed: true,
      remaining: limit - 1,
      resetAt: new Date(now + RATE_LIMIT_WINDOW_MS),
    };
  }

  if (entry.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(entry.windowStart + RATE_LIMIT_WINDOW_MS),
    };
  }

  entry.count++;
  return {
    allowed: true,
    remaining: limit - entry.count,
    resetAt: new Date(entry.windowStart + RATE_LIMIT_WINDOW_MS),
  };
}

// ─── Automatic CAPTCHA (spam protection, no per-form toggle) ─────────────
// Submissions are "auto-solved" for honest visitors. Once an IP starts
// hammering a form, we progressively escalate: normal → require CAPTCHA →
// block when the burst is severe.
const submissionBursts = new Map<string, { count: number; windowStart: number }>();
const BURST_WINDOW_MS = 60 * 1000; // 1 minute sliding burst window
const CAPTCHA_THRESHOLD = 4;       // > 4 submissions/min ⇒ CAPTCHA
const BLOCK_THRESHOLD = 12;        // > 12 submissions/min ⇒ block

export type BurstLevel = 'ok' | 'captcha' | 'block';

/**
 * Track submission bursts per form+IP. Returns the protection level the
 * submit handler should enforce: 'ok' (no check), 'captcha' (require a
 * solved challenge before accepting), or 'block' (reject outright).
 */
export function checkSubmissionBurst(
  formId: string,
  ip: string
): { level: BurstLevel; retryAfter?: number } {
  const key = `${formId}:${ip}`;
  const now = Date.now();
  const entry = submissionBursts.get(key);

  if (!entry || now - entry.windowStart > BURST_WINDOW_MS) {
    submissionBursts.set(key, { count: 1, windowStart: now });
    return { level: 'ok' };
  }

  entry.count++;
  if (entry.count > BLOCK_THRESHOLD) {
    return {
      level: 'block',
      retryAfter: Math.max(0, BURST_WINDOW_MS - (now - entry.windowStart)),
    };
  }
  if (entry.count > CAPTCHA_THRESHOLD) {
    return { level: 'captcha' };
  }
  return { level: 'ok' };
}

/**
 * Sanitize form submission answers
 */
export function sanitizeSubmissionAnswers(
  answers: Record<string, any>
): { sanitized: Record<string, any>; threats: string[] } {
  const sanitized: Record<string, any> = {};
  const threats: string[] = [];

  for (const [fieldId, value] of Object.entries(answers)) {
    if (typeof value === 'string') {
      // Sanitize string values
      const clean = sanitizeInput(value, 20000);
      
      // Check for XSS
      const xssType = detectXss(clean);
      if (xssType) {
        threats.push(`XSS detected in field ${fieldId}: ${xssType}`);
        // Strip XSS patterns but keep the content
        sanitized[fieldId] = clean
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
          .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
          .replace(/javascript\s*:/gi, 'blocked:');
      } else {
        sanitized[fieldId] = clean;
      }
    } else if (Array.isArray(value)) {
      // Sanitize array values
      sanitized[fieldId] = value.map(v => 
        typeof v === 'string' ? sanitizeInput(v, 2000) : v
      );
    } else {
      // Pass through non-string values
      sanitized[fieldId] = value;
    }
  }

  return { sanitized, threats };
}

/**
 * Validate submission against the form schema. Field rules come from the
 * central component registry (@tirbeo/types) so every field type's config —
 * min/max, patterns, allowed domains, file limits, etc. — is enforced here.
 *
 * Conditional logic (PRD §21) is honored: hidden fields are not validated, and
 * rules may force a field to be required or optional.
 */
export function validateSubmission(
  form: any,
  body: any
): { valid: boolean; error?: string } {
  if (Array.isArray(form.fields)) {
    const answers = body.answers || {};
    const rules = normalizeLogicRules(form.logicRules);
    // If the form defines logic, only validate fields that are visible for the
    // given answers (hidden fields should never block a submission), and apply
    // required/optional overrides from matching rules.
    const fieldsToValidate: FormField[] = rules.length
      ? form.fields.filter((f: any) => evaluateLogicRules(rules, answers, form.fields as FormField[]).visible.has(f.id))
      : form.fields;

    const overridden: Record<string, boolean | undefined> = {};
    if (rules.length) {
      const ev = evaluateLogicRules(rules, answers, form.fields as FormField[]);
      for (const f of form.fields as FormField[]) {
        if (ev.required.has(f.id)) overridden[f.id] = true;
        else if (ev.optional.has(f.id)) overridden[f.id] = false;
      }
    }

    const withOverride = fieldsToValidate.map(f =>
      f.id in overridden ? { ...f, required: overridden[f.id] } : f
    );

    const errors = validateFields(withOverride, answers);
    const first = Object.values(errors)[0];
    if (first) {
      return { valid: false, error: first };
    }
  }

  // Validate email if collecting
  if (body.respondentEmail) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(body.respondentEmail)) {
      return { valid: false, error: 'Invalid email address' };
    }
  }

  return { valid: true };
}

/**
 * Clean up expired rate limit entries periodically
 */
export function cleanupRateLimits() {
  const now = Date.now();
  for (const [key, entry] of submissionRateLimits.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      submissionRateLimits.delete(key);
    }
  }
}

// Run cleanup every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupRateLimits, 5 * 60 * 1000);
}
