/* ═══════════════════════════════════════════════════════════════════
   Password strength — a real measurement, dependency-free.

   The security screen's `/api/security/password-check` promised a strength
   analysis and returned `weak: 0, reused: 0, feedback: []` for every account,
   which is worse than saying nothing: it told people their password had been
   checked and found fine. This is the check that was claimed.

   Why hand-rolled rather than zxcvbn: nothing in the repo ships a strength
   estimator (only the 10-item blocklist inside `password-reset.ts`), and
   pulling a ~1 MB dictionary package into the API bundle for one settings
   screen is not a fair trade. What matters here is what the dictionary-free
   part of zxcvbn measures — length against the charset actually used, plus the
   patterns people fall back on when they're told to "add a capital and a
   digit" — and those are a dozen honest lines of arithmetic:

     • entropy from the pool the password really draws on;
     • common-password and keyboard-walk matching (case/markings-insensitive);
     • repetition (aaa, abcabc), sequences (abc, 123, qwe), date-shaped tails;
     • the account's own details, which a generic scorer cannot see.

   Nothing here is logged. Not the password, not a hash of it, not a prefix.
   The caller gets numbers and sentences back, and the ledger only ever learns
   the score band.
   ═══════════════════════════════════════════════════════════════════ */

/** The repo's password policy lives in `password-reset.ts` and `setPassword`:
    8–128 characters, at least one lowercase, one uppercase, one digit. A
    password that fails it is reported as weak whatever the arithmetic says. */
export const PASSWORD_POLICY = { minLength: 8, maxLength: 128 } as const;

export type StrengthBand = 'very_weak' | 'weak' | 'fair' | 'good' | 'strong';

export interface StrengthInput {
  password: string;
  /** The account's own details — the strings a person is most likely to fold
      into a password. Compared case- and separator-insensitively. */
  context?: (string | null | undefined)[];
}

export interface StrengthResult {
  /** 0–4, the band an interface can colour. */
  score: number;
  band: StrengthBand;
  /** True when the password is genuinely guessable — the measurement, kept
      deliberately apart from `meetsPolicy`: a four-word phrase like
      `nine-glass-marmot` is strong even though the site's format rules ask for
      a capital and a digit. Collapsing the two would tell people their strong
      passphrase is weak, which is not information, it is noise. */
  weak: boolean;
  /** Whether the house policy (8–128, mixed case, digit) is satisfied. This is
      what a save would be refused for; see `policyErrors`. */
  meetsPolicy: boolean;
  /** Estimated bits of entropy after the pattern discounts. */
  entropyBits: number;
  length: number;
  classes: { lower: boolean; upper: boolean; digit: boolean; symbol: boolean; nonAscii: boolean };
  /** Every problem found, phrased as something to do about it. */
  feedback: string[];
  /** Which policy rules failed, so a screen can quote the rule rather than a
      sentence built from it. */
  policyErrors: string[];
}

// The strings a person reaches for when asked to make a password. Matched
// after stripping case and the usual leetspeak substitutions, so `P@ssw0rd1`
// is caught by the same entry as `password1`.
const COMMON_ROOTS_RAW = [
  'password', 'passw0rd', 'p@ssw0rd', 'pass', 'passwd', 'qwerty', 'qwertyuiop', 'azerty',
  'abc', 'abcd', 'abc123', 'iloveyou', 'letmein', 'welcome', 'hello', 'monkey', 'dragon',
  'sunshine', 'princess', 'football', 'baseball', 'basketball', 'soccer', 'hockey',
  'superman', 'batman', 'spiderman', 'pokemon', 'michael', 'jennifer', 'jordan',
  'admin', 'administrator', 'root', 'login', 'guest', 'master', 'account', 'user',
  'trustno1', 'shadow', 'internet', 'computer', 'matrix', 'starwars', 'monkey123',
  'tinkle', 'whatever', 'freedom', 'love', 'angel', 'secret', 'god', 'test', 'demo',
  'changeme', 'default', 'winter', 'summer', 'spring', 'autumn', 'monday', 'friday',
];

/** Roots reduced to the same letters-only form the candidate is reduced to, so
    `trustno1` and `Trustno!` both land on `trustno`. Short roots still match
    exactly (below) but never as a prefix — `abc` inside a long random string
    is not evidence of anything. */
const COMMON_ROOTS = [...new Set(COMMON_ROOTS_RAW.map((r) => r.replace(/[^a-z]/g, '')).filter(Boolean))];

// Exact common passwords that survive only as themselves (mostly the top of
// the public frequency lists, with the digits that make them "compliant").
const COMMON_EXACT = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890', '111111', '000000',
  'password', 'Password1', 'Password123', 'Passw0rd', 'P@ssw0rd', 'qwerty', 'Qwerty123',
  'abc123', 'Abc12345', 'iloveyou', 'letmein', 'welcome', 'Welcome1', 'monkey',
  'dragon', 'sunshine', 'princess', 'football', 'admin', 'Root123', '1q2w3e4r',
  'qazwsx', 'zaq12wsx', '1qaz2wsx', '0000', '121212', '654321', '696969', '123qwe',
]);

const KEYBOARD_WALKS = [
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'qazwsx', 'edcrfv',
  '1234', '4321', '0123', '3210',
];

/** Leetspeak normalisation: only the substitutions people actually make. */
function deleet(s: string): string {
  return s
    .toLowerCase()
    .replace(/@/g, 'a')
    .replace(/4/g, 'a')
    .replace(/8/g, 'b')
    .replace(/3/g, 'e')
    .replace(/#/g, 'e')
    .replace(/6/g, 'g')
    .replace(/!/g, 'i')
    .replace(/1/g, 'i')
    .replace(/0/g, 'o')
    .replace(/\$/g, 's')
    .replace(/5/g, 's')
    .replace(/\+/g, 't')
    .replace(/7/g, 't');
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

/** True when `s` contains a run of `n` consecutive characters (abc, 123, zyx,
    987) — the single most common way a "compliant" password stays guessable. */
function hasSequentialRun(s: string, n = 4): boolean {
  if (s.length < n) return false;
  const lower = s.toLowerCase();
  for (let i = 0; i + n <= lower.length; i++) {
    let ascending = true;
    let descending = true;
    for (let j = 1; j < n; j++) {
      const prev = lower.charCodeAt(i + j - 1);
      const cur = lower.charCodeAt(i + j);
      if (cur !== prev + 1) ascending = false;
      if (cur !== prev - 1) descending = false;
      if (!ascending && !descending) break;
    }
    // A run of non-alphanumerics (e.g. `!"#$`) is not the pattern we mean.
    const token = lower.slice(i, i + n);
    const alphanumeric = [...token].every((c) => ALPHABET.includes(c) || /[0-9]/.test(c));
    if (alphanumeric && (ascending || descending)) return true;
  }
  return false;
}

/** Repeated characters (aaa) or a repeated chunk (abcabc). */
function repetitionOf(s: string): { kind: 'run' | 'chunk'; token: string } | null {
  const run = s.toLowerCase().match(/(.)\1{2,}/);
  if (run) return { kind: 'run', token: run[1] };
  const chunk = s.toLowerCase().match(/^(.{1,4})\1{2,}/);
  if (chunk) return { kind: 'chunk', token: chunk[1] };
  const mid = s.toLowerCase().match(/(.{2,6})\1{1,}/);
  if (mid) return { kind: 'chunk', token: mid[1] };
  return null;
}

function isDateShape(s: string): boolean {
  return /(19|20)\d{2}([-/.]?(0[1-9]|1[0-2])[-/.]?(0[1-9]|[12]\d|3[01]))?/.test(s)
    || /^(0[1-9]|[12]\d|3[01])(19|20)\d{2}$/.test(s);
}

function poolSize(s: string): number {
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/[0-9]/.test(s)) pool += 10;
  if (/[^A-Za-z0-9]/.test(s)) pool += 33;
  if (/[^\x00-\x7F]/.test(s)) pool += 100;
  return pool || 1;
}

/**
 * Estimate the password's strength.
 *
 * `entropyBits` is not a guarantee — it is the usual charset arithmetic
 * (length × log2(pool)) with explicit discounts for the things that make a
 * long string worth much less than its length suggests: a common root, a
 * keyboard walk, a repeated chunk, a sequence, a date, or the owner's own
 * name/email. A 12-character `Password123!` scores ~79 bits unadjusted and is
 * discounted to almost nothing, which is the correct answer.
 */
export function scorePassword(input: StrengthInput): StrengthResult {
  const password = typeof input.password === 'string' ? input.password.slice(0, 1024) : '';
  const feedback: string[] = [];
  const policyErrors: string[] = [];

  const classes = {
    lower: /[a-z]/.test(password),
    upper: /[A-Z]/.test(password),
    digit: /[0-9]/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password),
    nonAscii: /[^\x00-\x7F]/.test(password),
  };

  if (!password) {
    return {
      score: 0, band: 'very_weak', weak: true, meetsPolicy: false, entropyBits: 0, length: 0, classes,
      feedback: ['Enter the password you want to check.'],
      policyErrors: ['Password is required.'],
    };
  }

  // ── Policy, quoted as the rest of the API enforces it ──
  if (password.length < PASSWORD_POLICY.minLength) {
    policyErrors.push(`Password must be at least ${PASSWORD_POLICY.minLength} characters.`);
    feedback.push(`Use at least ${PASSWORD_POLICY.minLength} characters — length is worth more than symbols.`);
  }
  if (password.length > PASSWORD_POLICY.maxLength) {
    policyErrors.push(`Password must be at most ${PASSWORD_POLICY.maxLength} characters.`);
    feedback.push(`That is over the ${PASSWORD_POLICY.maxLength}-character limit.`);
  }
  if (!classes.lower) policyErrors.push('Password must contain at least one lowercase letter.');
  if (!classes.upper) {
    policyErrors.push('Password must contain at least one uppercase letter.');
    feedback.push('Add a capital letter.');
  }
  if (!classes.digit) {
    policyErrors.push('Password must contain at least one number.');
    feedback.push('Add a number — somewhere other than the end.');
  }
  if (!classes.symbol && password.length < 14) {
    feedback.push('Add a symbol, or just make it longer — a phrase of four unrelated words is harder to guess than P@ssword1.');
  }

  const lower = password.toLowerCase();
  const leet = deleet(password);
  const uniqueChars = new Set(lower).size;

  let entropy = password.length * Math.log2(poolSize(password));

  // ── Common passwords / roots ──
  const lettersOnly = leet.replace(/[^a-z]/g, '');
  let commonHit: string | null = null;
  if (COMMON_EXACT.has(password) || COMMON_EXACT.has(lower)) commonHit = lower;
  if (!commonHit && lettersOnly) {
    for (const root of COMMON_ROOTS) {
      if (lettersOnly === root) { commonHit = root; break; }
      // A well-known word with a little decoration around it: `Password123!`.
      if (root.length >= 5 &&
        (lettersOnly.startsWith(root) || lettersOnly.endsWith(root)) &&
        lettersOnly.length - root.length <= 3) { commonHit = root; break; }
    }
  }
  if (commonHit) {
    entropy = Math.min(entropy, 8 + Math.log2(Math.max(2, password.length)) * 2);
    feedback.push(`“${commonHit}” is one of the most common password bases — people and software both try it first. Build it from unrelated words instead.`);
  }

  // ── Keyboard walks ──
  if (!commonHit) {
    let walkHit = false;
    for (const walk of KEYBOARD_WALKS) {
      if (walkHit) break;
      for (let i = 0; i + 4 <= walk.length && !walkHit; i++) {
        const frag = walk.slice(i, i + 4);
        if (lower.includes(frag) || lower.includes(reverse(frag))) {
          walkHit = true;
          entropy -= 14;
          feedback.push('Avoid keyboard rows like “qwerty” or “asdf” — they are tried as a single guess.');
        }
      }
    }
  }

  // ── Repetition ──
  const rep = repetitionOf(password);
  if (rep) {
    // Repetition is not multiplicative: `abcabcabcabc` is `abc` plus a counter,
    // so it is worth the short token's entropy and a few bits more — not four
    // times the length of guessing.
    entropy = rep.kind === 'run'
      ? Math.min(entropy - 16, 24)
      : Math.min(entropy - 12, rep.token.length * Math.log2(poolSize(password)) + 4);
    feedback.push(rep.kind === 'run'
      ? `Repeated characters (“${rep.token.repeat(3)}…”) add almost nothing — a guesser tries them first.`
      : `Repeating a short chunk (“${rep.token}”) is one guess, not several.`);
  }

  // ── Sequences ──
  if (hasSequentialRun(password, 4)) {
    entropy -= 12;
    feedback.push('Sequential runs like “abcd” or “1234” are patterns every cracker expands before anything else.');
  }

  // ── Date-shaped ──
  if (isDateShape(password)) {
    entropy -= 14;
    feedback.push('A date-shaped tail (a year, a birthday) is a small search space. Drop the date.');
  }

  // ── The owner's own details ──
  const needles = (input.context || [])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.toLowerCase())
    .filter((v) => v.length >= 3);
  for (const needle of needles) {
    const bare = needle.split('@')[0].replace(/[^a-z0-9]/g, '');
    if (bare.length >= 3 && (leet.includes(deleet(needle)) || lower.includes(bare))) {
      entropy -= 20;
      feedback.push('Your password contains part of your own name, email or username — that is the first thing an attacker with your account tries.');
      break;
    }
  }

  // A long string of one class (all letters) is worth less than the pool says.
  if (uniqueChars <= 4) entropy = Math.min(entropy, 20);
  entropy = Math.max(0, entropy);

  let band: StrengthBand;
  if (entropy < 28) band = 'very_weak';
  else if (entropy < 40) band = 'weak';
  else if (entropy < 60) band = 'fair';
  else if (entropy < 80) band = 'good';
  else band = 'strong';

  const scoreByBand: Record<StrengthBand, number> = { very_weak: 0, weak: 1, fair: 2, good: 3, strong: 4 };
  let score = scoreByBand[band];
  // A common word, or four distinct characters doing all the work, is worth
  // one or two guesses no matter how the arithmetic scored the length.
  if (commonHit || uniqueChars <= 4) score = Math.min(score, 1);
  const weak = score <= 1;
  const meetsPolicy = policyErrors.length === 0;

  if (feedback.length === 0) {
    feedback.push(
      band === 'strong' ? 'This is a strong password. Keep it unique to Tirbeo and let your browser or a manager remember it.'
        : 'Good enough to keep, but a passkey or a longer phrase would be better still.');
  }

  return {
    score,
    band,
    weak,
    meetsPolicy,
    entropyBits: Math.round(entropy * 10) / 10,
    length: password.length,
    classes,
    feedback,
    policyErrors,
  };
}

function reverse(v: string): string {
  return v.split('').reverse().join('');
}

/** One-line headline a settings screen can show beside the bar. */
export function strengthLabel(r: StrengthResult): string {
  if (r.weak && r.policyErrors.length) {
    return `Weak — ${r.policyErrors[0]}`;
  }
  if (!r.meetsPolicy && r.policyErrors.length) {
    // Strong, but not saveable yet: say which, in the order the rules ask.
    return `Hard to guess, but the site rules ask for more — ${r.policyErrors[0]}`;
  }
  switch (r.band) {
    case 'very_weak': return 'Very weak — easily guessed';
    case 'weak': return 'Weak — easily guessed';
    case 'fair': return 'Fair — could be stronger';
    case 'good': return 'Good';
    case 'strong': return 'Strong';
  }
}
