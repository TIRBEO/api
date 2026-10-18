/**
 * Password strength scoring (features/security/password-strength).
 *
 * Pure — no prisma, no network. These pin the promise `/api/security/password-check`
 * now makes: that a number and a sentence come from a real measurement, and
 * that the patterns people actually fall back on (a common word with digits on
 * the end, a keyboard row, a birthday, their own name) are scored down even
 * when they satisfy the character-class rules.
 */
import { describe, it, expect } from 'vitest';
import { scorePassword, strengthLabel, PASSWORD_POLICY } from '@/features/security/password-strength';

const check = (password: string, context?: string[]) => scorePassword({ password, context });

describe('scorePassword — policy floor', () => {
  it('fails the house rules below 8 characters, whatever else it looks like', () => {
    const r = check('Ab1!');
    expect(r.weak).toBe(true);
    expect(r.meetsPolicy).toBe(false);
    expect(r.policyErrors.join(' ')).toMatch(/at least 8/);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it('names every missing character class the reset path requires', () => {
    const r = check('alllowercase');
    expect(r.policyErrors.join(' ')).toMatch(/uppercase/);
    expect(r.policyErrors.join(' ')).toMatch(/number/);
    // A measurement, not a judgement: long and odd, but not saveable yet.
    expect(r.meetsPolicy).toBe(false);
  });

  it('refuses the blocklist that password-reset.ts refuses', () => {
    for (const pw of ['password', 'Password1', 'qwerty', '12345678', 'letmein', 'welcome']) {
      expect(check(pw).weak, pw).toBe(true);
    }
  });

  it('rejects a password over the policy ceiling instead of grading it', () => {
    const r = check(`A1a${'x'.repeat(200)}`);
    expect(r.policyErrors.join(' ')).toMatch(new RegExp(`at most ${PASSWORD_POLICY.maxLength}`));
  });
});

describe('scorePassword — patterns that fake length', () => {
  it('scores a common root with decoration as weak', () => {
    const r = check('Password123!');
    expect(r.weak).toBe(true);
    expect(r.feedback.join(' ')).toMatch(/password/);
  });

  it('catches leetspeak substitutions of the same root', () => {
    expect(check('P@ssw0rd').weak).toBe(true);
    expect(check('p4ssword').weak).toBe(true);
  });

  it('catches keyboard walks forwards and backwards', () => {
    expect(check('Qwertyuiop1').weak).toBe(true);
    expect(check('poiuytrew9').weak).toBe(true);
  });

  it('catches repeated characters and repeated chunks', () => {
    expect(check('aaaaaaaaA1').weak).toBe(true);
    expect(check('abcabcabc123').weak).toBe(true);
  });

  it('catches sequential runs inside an otherwise compliant password', () => {
    const r = check('Xyz12345abcd');
    expect(r.feedback.join(' ')).toMatch(/sequential|keyboard/i);
  });

  it('catches a date-shaped tail', () => {
    const r = check('Trailing1987');
    expect(r.feedback.join(' ')).toMatch(/date/i);
  });

  it('flags the account holder’s own email, username or name', () => {
    const r = check('RahimSarkar2024', ['rahim@example.com', 'rahim', 'Rahim Sarkar']);
    expect(r.feedback.join(' ')).toMatch(/your own name|own name/i);
    expect(r.entropyBits).toBeLessThan(60);
  });

  it('does not flag an unrelated strong passphrase', () => {
    const r = check('Nine-Glass-Marmot-24', ['someone@example.com', 'rahim']);
    expect(r.weak).toBe(false);
    expect(r.meetsPolicy).toBe(true);
    expect(r.band === 'good' || r.band === 'strong').toBe(true);
  });

  it('keeps guessability and rule-compliance as two separate answers', () => {
    // Long, varied, and refused by the form rules — strong, not saveable.
    const strong = check('nine-glass-marmot-wander');
    expect(strong.weak).toBe(false);
    expect(strong.meetsPolicy).toBe(false);
    // And the reverse: compliant because someone typed the usual thing.
    const compliant = check('Password1');
    expect(compliant.meetsPolicy).toBe(true);
    expect(compliant.weak).toBe(true);
  });
});

describe('scorePassword — output shape', () => {
  it('always says something actionable, and never echoes the password', () => {
    for (const pw of ['short', 'password1', 'Zq9!mv2&kx7#Lt', 'aaaaaaaaA1']) {
      const r = check(pw);
      expect(r.feedback.length).toBeGreaterThan(0);
      const text = r.feedback.join(' ');
      if (pw.length > 6) expect(text.includes(pw), pw).toBe(false);
    }
  });

  it('reports the measured fields a screen needs', () => {
    const r = check('Abcdef123456');
    expect(r.length).toBe(12);
    expect(r.classes).toEqual({ lower: true, upper: true, digit: true, symbol: false, nonAscii: false });
    expect(r.entropyBits).toBeGreaterThan(0);
    expect(['very_weak', 'weak', 'fair', 'good', 'strong']).toContain(r.band);
    expect(typeof r.weak).toBe('boolean');
  });

  it('answers an empty candidate honestly instead of a silent zero', () => {
    const r = check('');
    expect(r.weak).toBe(true);
    expect(r.entropyBits).toBe(0);
    expect(r.feedback.length).toBeGreaterThan(0);
  });

  it('labels the band for the interface', () => {
    expect(strengthLabel(check('password1'))).toMatch(/weak|rules/i);
    expect(strengthLabel(check('Nine-Glass-Marmot-24'))).toMatch(/strong|Good enough|Good/i);
    // Strong-but-noncompliant must not be labelled weak.
    expect(strengthLabel(check('nine-glass-marmot-wander'))).toMatch(/rules ask for more/i);
  });

  it('bounds pathological input rather than hanging', () => {
    const r = check('A1' + 'z'.repeat(5000));
    expect(r.length).toBeLessThanOrEqual(1024);
  });
});
