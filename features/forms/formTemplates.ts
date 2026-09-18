/**
 * Form template catalog — served by GET /api/templates and consumed by
 * POST /api/templates/[id] (instantiate as a real Form).
 *
 * Mirrors the client-side TEMPLATES catalog in apps/forms/app/create/page.tsx
 * (single source of truth for ids; keep both in sync). `icon` is a lucide
 * icon NAME — the templates page maps it via its ICON_MAP.
 */

export interface TemplateField {
  type: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  options?: Array<Record<string, unknown>>;
}

export interface FormTemplateDef {
  id: string;
  name: string;
  description: string;
  category: 'General' | 'Professional' | 'Education' | 'Events';
  icon: string;
  fields: TemplateField[];
}

export const FORM_TEMPLATES: FormTemplateDef[] = [
  {
    id: 'blank',
    name: 'Blank form',
    description: 'Start from scratch',
    category: 'General',
    icon: 'PenTool',
    fields: [],
  },
  // ── General ─────────────────────────────────────────────
  {
    id: 'contact',
    name: 'Contact form',
    description: 'Name, email, message',
    category: 'General',
    icon: 'MessageSquare',
    fields: [
      { type: 'text', label: 'Full name', required: true, placeholder: 'John Doe' },
      { type: 'email', label: 'Email address', required: true, placeholder: 'john@example.com' },
      { type: 'textarea', label: 'Message', required: true, placeholder: 'How can we help you?' },
    ],
  },
  {
    id: 'feedback-form',
    name: 'Feedback form',
    description: 'Collect user feedback',
    category: 'General',
    icon: 'ClipboardList',
    fields: [
      { type: 'text', label: 'Your name', required: false, placeholder: 'Optional' },
      { type: 'rating', label: 'Overall rating', required: true },
      { type: 'textarea', label: 'What did you like?', required: false },
      { type: 'textarea', label: 'What can we improve?', required: false },
    ],
  },
  {
    id: 'survey',
    name: 'Survey',
    description: 'Multi-question survey',
    category: 'General',
    icon: 'BarChart3',
    fields: [
      { type: 'rating', label: 'Overall satisfaction', required: true },
      { type: 'textarea', label: 'What would you change?', required: false },
      {
        type: 'radio', label: 'How often do you use us?', required: true,
        options: [
          { label: 'Daily', value: 'daily' },
          { label: 'Weekly', value: 'weekly' },
          { label: 'Monthly', value: 'monthly' },
          { label: 'First time', value: 'first' },
        ],
      },
    ],
  },
  {
    id: 'registration',
    name: 'Registration',
    description: 'Event or team signup',
    category: 'General',
    icon: 'Users',
    fields: [
      { type: 'text', label: 'Full name', required: true },
      { type: 'email', label: 'Email', required: true },
      { type: 'phone', label: 'Phone', required: false },
      {
        type: 'select', label: 'Role', required: true,
        options: [
          { label: 'Attendee', value: 'attendee' },
          { label: 'Speaker', value: 'speaker' },
          { label: 'Sponsor', value: 'sponsor' },
        ],
      },
    ],
  },
  {
    id: 'application',
    name: 'Application',
    description: 'General application form',
    category: 'General',
    icon: 'FileText',
    fields: [
      { type: 'text', label: 'Full name', required: true },
      { type: 'email', label: 'Email address', required: true },
      { type: 'phone', label: 'Phone number', required: false },
      { type: 'textarea', label: 'Why are you applying?', required: true },
    ],
  },
  {
    id: 'rsvp',
    name: 'RSVP',
    description: 'Guest attendance confirmation',
    category: 'General',
    icon: 'Calendar',
    fields: [
      { type: 'text', label: 'Full name', required: true },
      {
        type: 'radio', label: 'Will you attend?', required: true,
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      },
      { type: 'number', label: 'Number of guests', required: false },
    ],
  },
  {
    id: 'newsletter',
    name: 'Newsletter signup',
    description: 'Collect subscribers',
    category: 'General',
    icon: 'Mail',
    fields: [
      { type: 'text', label: 'First name', required: false },
      { type: 'email', label: 'Email address', required: true },
      {
        type: 'checkbox', label: 'Interests', required: false,
        options: [
          { label: 'Product updates', value: 'product' },
          { label: 'Company news', value: 'news' },
          { label: 'Events', value: 'events' },
        ],
      },
    ],
  },
  {
    id: 'csat',
    name: 'Customer satisfaction',
    description: 'Measure satisfaction',
    category: 'General',
    icon: 'Smile',
    fields: [
      { type: 'rating', label: 'How satisfied are you?', required: true },
      { type: 'textarea', label: 'What can we improve?', required: false },
    ],
  },
  // ── Professional ────────────────────────────────────────
  {
    id: 'job-application',
    name: 'Job application',
    description: 'Candidate submissions',
    category: 'Professional',
    icon: 'Briefcase',
    fields: [],
  },
  {
    id: 'client-intake',
    name: 'Client intake',
    description: 'New client onboarding',
    category: 'Professional',
    icon: 'UserCheck',
    fields: [],
  },
  {
    id: 'project-request',
    name: 'Project request',
    description: 'Submit a project brief',
    category: 'Professional',
    icon: 'Lightbulb',
    fields: [],
  },
  {
    id: 'support-request',
    name: 'Support request',
    description: 'Ticket submission',
    category: 'Professional',
    icon: 'Headphones',
    fields: [],
  },
  {
    id: 'lead-generation',
    name: 'Lead generation',
    description: 'Capture sales leads',
    category: 'Professional',
    icon: 'TrendingUp',
    fields: [],
  },
  {
    id: 'product-research',
    name: 'Product research',
    description: 'User research questionnaire',
    category: 'Professional',
    icon: 'Search',
    fields: [],
  },
  // ── Education ───────────────────────────────────────────
  {
    id: 'quiz',
    name: 'Quiz',
    description: 'Timed knowledge quiz',
    category: 'Education',
    icon: 'Brain',
    fields: [],
  },
  {
    id: 'course-registration',
    name: 'Course registration',
    description: 'Enroll in a course',
    category: 'Education',
    icon: 'BookOpen',
    fields: [],
  },
  {
    id: 'student-feedback',
    name: 'Student feedback',
    description: 'Course/student feedback',
    category: 'Education',
    icon: 'GraduationCap',
    fields: [],
  },
  {
    id: 'assignment',
    name: 'Assignment submission',
    description: 'Submit coursework',
    category: 'Education',
    icon: 'FileBadge',
    fields: [],
  },
  // ── Events ──────────────────────────────────────────────
  {
    id: 'event-registration',
    name: 'Event registration',
    description: 'Register for an event',
    category: 'Events',
    icon: 'CalendarDays',
    fields: [],
  },
  {
    id: 'workshop-registration',
    name: 'Workshop registration',
    description: 'Sign up for a workshop',
    category: 'Events',
    icon: 'CalendarDays',
    fields: [],
  },
  {
    id: 'conference-registration',
    name: 'Conference registration',
    description: 'Attend a conference',
    category: 'Events',
    icon: 'CalendarDays',
    fields: [],
  },
];

export function getTemplateById(id: string): FormTemplateDef | undefined {
  return FORM_TEMPLATES.find((t) => t.id === id);
}

/** Public listing shape for GET /api/templates (icon as lucide name string). */
export function listTemplates() {
  const categories = Array.from(new Set(FORM_TEMPLATES.map((t) => t.category)));
  return {
    templates: FORM_TEMPLATES.map(({ id, name, description, category, icon, fields }) => ({
      id, name, description, category, icon, fields,
    })),
    categories,
  };
}
