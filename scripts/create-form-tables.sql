-- Forms table
CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  access_key TEXT UNIQUE NOT NULL DEFAULT '',
  form_type TEXT NOT NULL DEFAULT 'custom',
  website_url TEXT,
  success_message TEXT DEFAULT 'Thanks! Your submission has been received.',
  success_redirect TEXT,
  redirect_target TEXT NOT NULL DEFAULT '_self',
  custom_success_html TEXT,
  notification_emails TEXT[] DEFAULT '{}',
  cc_emails TEXT[] DEFAULT '{}',
  bcc_emails TEXT[] DEFAULT '{}',
  reply_to_email TEXT,
  email_subject TEXT,
  from_name TEXT,
  auto_reply BOOLEAN NOT NULL DEFAULT false,
  auto_reply_subject TEXT,
  auto_reply_body TEXT,
  spam_protection TEXT NOT NULL DEFAULT 'automatic',
  turnstile_key TEXT,
  rate_limit INT NOT NULL DEFAULT 60,
  allowed_origins TEXT[] DEFAULT '{}',
  honeypot BOOLEAN NOT NULL DEFAULT true,
  store_responses BOOLEAN NOT NULL DEFAULT true,
  retention TEXT NOT NULL DEFAULT 'forever',
  show_metadata BOOLEAN NOT NULL DEFAULT false,
  layout TEXT NOT NULL DEFAULT 'comfortable',
  width TEXT NOT NULL DEFAULT 'full',
  alignment TEXT NOT NULL DEFAULT 'left',
  label_position TEXT NOT NULL DEFAULT 'above',
  theme TEXT NOT NULL DEFAULT 'light',
  custom_css TEXT,
  headless BOOLEAN NOT NULL DEFAULT false,
  submission_count INT NOT NULL DEFAULT 0,
  last_submission_at TIMESTAMPTZ,
  conversion_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forms_user ON forms(user_id);
CREATE INDEX IF NOT EXISTS idx_forms_status ON forms(status);
CREATE INDEX IF NOT EXISTS idx_forms_slug ON forms(slug);

-- Form Fields
CREATE TABLE IF NOT EXISTS form_fields (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  required BOOLEAN NOT NULL DEFAULT false,
  placeholder TEXT,
  help_text TEXT,
  default_value JSONB,
  options JSONB,
  validation JSONB,
  appearance JSONB,
  "order" INT NOT NULL DEFAULT 0,
  hidden BOOLEAN NOT NULL DEFAULT false,
  read_only BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_form_fields_form ON form_fields(form_id);

-- Form Submissions
CREATE TABLE IF NOT EXISTS form_submissions (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}',
  metadata JSONB,
  source TEXT,
  ip_address TEXT,
  user_agent TEXT,
  referrer TEXT,
  country TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_form_subs_form ON form_submissions(form_id);
CREATE INDEX IF NOT EXISTS idx_form_subs_created ON form_submissions(created_at);
CREATE INDEX IF NOT EXISTS idx_form_subs_form_created ON form_submissions(form_id, created_at);

-- Form Analytics
CREATE TABLE IF NOT EXISTS form_analytics (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  views INT NOT NULL DEFAULT 0,
  starts INT NOT NULL DEFAULT 0,
  submissions INT NOT NULL DEFAULT 0,
  failed_submissions INT NOT NULL DEFAULT 0,
  avg_completion_time DOUBLE PRECISION,
  device_breakdown JSONB,
  country_breakdown JSONB,
  referrer_breakdown JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(form_id, date)
);

CREATE INDEX IF NOT EXISTS idx_form_analytics_form ON form_analytics(form_id);

-- Form Connections
CREATE TABLE IF NOT EXISTS form_connections (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  "order" INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_form_connections_form ON form_connections(form_id);
