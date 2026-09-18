/**
 * ESLint config for apps/api.
 *
 * Boundary rules freeze the dependency direction established by the
 * 2026-09-17 restructuring (audit/2026-09-17-api-restructure.md):
 *
 *   app/ (transport) → features/ (domains) → infrastructure/ | shared/ | config/
 *   jobs/ → features/ + infrastructure/
 *   shared/ imports nothing above it.
 *
 * ENFORCED HARD (error):
 *   - features/ → app/ or jobs/          (inversion: jobs call features, never reverse)
 *   - infrastructure/ → features/        (inversion; single documented exception below)
 *   - shared/ → anything above it
 *   - app/ → jobs/                       (job scheduling lives in jobs/ + server.ts;
 *                                        cron route and admin/maintenance are
 *                                        whitelisted operator-trigger entry points)
 *
 * ALLOWED CONVENTION (documented, not an invitation):
 *   - app/ routes import @/infrastructure/db, /observability, /cache, /realtime
 *     directly. This is the existing pervasive transport-plumbing pattern across
 *     ~80 routes; rewriting it is out of scope. New business logic still belongs
 *     in features/. app/ → infrastructure/storage (R2) IS restricted: storage
 *     access must go through features/media.
 *
 * EXCEPTION: infrastructure/realtime/ws/server.ts may import
 * features/auth/session — the WebSocket handshake authenticates connections
 * before any HTTP context exists.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const appRules = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['@/infrastructure/storage', '@/infrastructure/storage/**'],
          message: 'app/ must access object storage via features/media (or a dedicated storage feature), not the R2 adapter directly.',
        },
        {
          group: ['@/jobs/**', '@/jobs/*'],
          message: 'app/ must not import jobs/. Job scheduling lives in jobs/ and server.ts.',
        },
      ],
    },
  ],
};

// Operator-triggered job entry points (verified 2026-09-17):
// - app/api/cron/route.ts: Vercel cron target (/api/cron, 03:00 daily)
// - app/api/admin/maintenance/route.ts: admin UI writes maintenance schedule
const appJobEntryPoints = [
  'app/api/cron/route.ts',
  'app/api/admin/maintenance/route.ts',
];

const featureRules = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['@/app/**', '@/app/*', '../app/**', './app/**'],
          message: 'features/ must not import app/ (transport). Dependency direction: app → features.',
        },
        {
          group: ['@/jobs/**', '@/jobs/*', '../jobs/**'],
          message: 'features/ must not import jobs/. Jobs call features, never the reverse.',
        },
      ],
    },
  ],
};

const infrastructureRules = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['@/features/**', '@/features/*', '../features/**'],
          message: 'infrastructure/ must not import features/ (dependency direction: features → infrastructure).',
        },
        {
          group: ['@/jobs/**', '@/jobs/*'],
          message: 'infrastructure/ must not import jobs/.',
        },
      ],
    },
  ],
};

// ws/server performs the WebSocket handshake authentication before any HTTP
// context exists — features/auth/session is its sanctioned dependency.
const wsServerRules = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['@/features/!(auth)/**', '@/features/!(auth)/*'],
          message: 'ws/server may import only features/auth/session (handshake authentication).',
        },
        {
          group: ['@/jobs/**', '@/jobs/*'],
          message: 'infrastructure/ must not import jobs/.',
        },
      ],
    },
  ],
};

const sharedRules = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: [
            '@/features/**', '@/features/*',
            '@/infrastructure/**', '@/infrastructure/*',
            '@/jobs/**', '@/jobs/*',
            '@/app/**', '@/app/*',
          ],
          message: 'shared/ is the bottom layer: no imports from features, infrastructure, jobs or app.',
        },
      ],
    },
  ],
};

const configRules = sharedRules; // config/ is also a bottom layer

export default tseslint.config(
  { ignores: ['node_modules/**', '.next/**', 'scripts/tmp-*', 'scripts/*.mjs', 'scripts/*.cjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // General rules first — area overrides below must come AFTER to win.
  { files: ['app/**/*.ts', 'app/**/*.tsx'], rules: appRules },
  { files: ['features/**/*.ts'], rules: featureRules },
  { files: ['infrastructure/**/*.ts'], rules: infrastructureRules },
  { files: ['shared/**/*.ts'], rules: sharedRules },
  { files: ['config/**/*.ts'], rules: configRules },
  // Overrides (must be after the general blocks above):
  { files: ['infrastructure/realtime/ws/server.ts'], rules: wsServerRules },
  { files: appJobEntryPoints, rules: { 'no-restricted-imports': 'off' } },
  { files: ['next.config.js'], rules: { 'no-undef': 'off' } }, // CommonJS config file
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // pre-existing style; not the purpose of this config
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Legacy patterns pre-dating this config — warnings keep them visible
      // without re-litigating 70+ sites; new code should not add them:
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-require-imports': 'warn', // intentional lazy requires in serverless paths
      // JS scripts (node-run, CommonJS) — keep JS linting relevant to this repo:
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off', // intentional control-char matching in security sanitizers
      'no-useless-escape': 'warn',
    },
  },
);
