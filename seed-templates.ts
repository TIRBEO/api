import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Copy exact connection setup from prisma.ts
const base = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '';
const sep = base.includes('?') ? '&' : '?';
const connectionString = `${base}${sep}uselibpqcompat=true&sslmode=require&pgbouncer=true&pool_timeout=10&connection_limit=10`;

console.log('Connecting with:', connectionString.substring(0, 50) + '...');

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const TEMPLATES = [
  { name: 'Contact Us', description: 'Standard contact form with name, email, subject, and message fields.', category: 'Contact', icon: 'MessageSquare', isFeatured: true, fields: [{"id":"name","type":"text","label":"Full Name","required":true,"order":0},{"id":"email","type":"email","label":"Email Address","required":true,"order":1},{"id":"subject","type":"text","label":"Subject","required":true,"order":2},{"id":"message","type":"textarea","label":"Message","required":true,"order":3}], theme: {"primaryColor":"#3b82f6","borderRadius":"12px"} },
  { name: 'Customer Feedback', description: 'Collect detailed feedback with satisfaction ratings and open-ended questions.', category: 'Feedback', icon: 'Star', isFeatured: true, fields: [{"id":"name","type":"text","label":"Your Name","required":false,"order":0},{"id":"rating","type":"rating","label":"Overall Satisfaction","required":true,"order":1},{"id":"quality","type":"radio","label":"Product Quality","required":true,"order":2,"options":[{"value":"excellent","label":"Excellent"},{"value":"good","label":"Good"},{"value":"average","label":"Average"},{"value":"poor","label":"Poor"}]},{"id":"feedback","type":"textarea","label":"Your Feedback","required":true,"order":3},{"id":"recommend","type":"radio","label":"Would you recommend us?","required":true,"order":4,"options":[{"value":"yes","label":"Yes"},{"value":"no","label":"No"}]}] },
  { name: 'Event Registration', description: 'Register attendees for events with name, email, ticket type, and dietary preferences.', category: 'Registration', icon: 'UserPlus', fields: [{"id":"name","type":"text","label":"Full Name","required":true,"order":0},{"id":"email","type":"email","label":"Email Address","required":true,"order":1},{"id":"phone","type":"phone","label":"Phone Number","required":false,"order":2},{"id":"ticket","type":"select","label":"Ticket Type","required":true,"order":3,"options":[{"value":"general","label":"General Admission"},{"value":"vip","label":"VIP"},{"value":"student","label":"Student"}]},{"id":"dietary","type":"checkbox","label":"Dietary Requirements","required":false,"order":4,"options":[{"value":"vegetarian","label":"Vegetarian"},{"value":"vegan","label":"Vegan"},{"value":"gluten-free","label":"Gluten Free"}]}] },
  { name: 'Job Application', description: 'Collect job applications with resume upload and experience details.', category: 'Registration', icon: 'Briefcase', fields: [{"id":"name","type":"text","label":"Full Name","required":true,"order":0},{"id":"email","type":"email","label":"Email Address","required":true,"order":1},{"id":"position","type":"select","label":"Position Applied For","required":true,"order":2,"options":[{"value":"engineer","label":"Software Engineer"},{"value":"designer","label":"Designer"},{"value":"pm","label":"Product Manager"}]},{"id":"experience","type":"number","label":"Years of Experience","required":true,"order":3},{"id":"resume","type":"file","label":"Upload Resume","required":true,"order":4},{"id":"cover","type":"textarea","label":"Cover Letter","required":false,"order":5}] },
  { name: 'Newsletter Signup', description: 'Collect email addresses and preferences for newsletter subscriptions.', category: 'Registration', icon: 'Mail', isFeatured: true, fields: [{"id":"email","type":"email","label":"Email Address","required":true,"order":0},{"id":"name","type":"text","label":"First Name","required":false,"order":1},{"id":"interests","type":"checkbox","label":"Topics of Interest","required":false,"order":2,"options":[{"value":"tech","label":"Technology"},{"value":"design","label":"Design"},{"value":"business","label":"Business"},{"value":"news","label":"News & Updates"}]}] },
  { name: 'Product Order', description: 'Simple product order form with item selection, quantities, and shipping details.', category: 'Orders', icon: 'ShoppingCart', fields: [{"id":"name","type":"text","label":"Full Name","required":true,"order":0},{"id":"email","type":"email","label":"Email Address","required":true,"order":1},{"id":"product","type":"select","label":"Product","required":true,"order":2,"options":[{"value":"basic","label":"Basic Plan - $9/mo"},{"value":"pro","label":"Pro Plan - $29/mo"},{"value":"enterprise","label":"Enterprise - $99/mo"}]},{"id":"quantity","type":"number","label":"Quantity","required":true,"order":3},{"id":"address","type":"textarea","label":"Shipping Address","required":true,"order":4}] },
  { name: 'Support Request', description: 'Submit support requests with priority level, category, and detailed description.', category: 'Contact', icon: 'LifeBuoy', fields: [{"id":"name","type":"text","label":"Your Name","required":true,"order":0},{"id":"email","type":"email","label":"Email Address","required":true,"order":1},{"id":"priority","type":"radio","label":"Priority Level","required":true,"order":2,"options":[{"value":"low","label":"Low"},{"value":"medium","label":"Medium"},{"value":"high","label":"High"},{"value":"urgent","label":"Urgent"}]},{"id":"category","type":"select","label":"Issue Category","required":true,"order":3,"options":[{"value":"bug","label":"Bug Report"},{"value":"feature","label":"Feature Request"},{"value":"account","label":"Account Issue"},{"value":"billing","label":"Billing"}]},{"id":"description","type":"textarea","label":"Description","required":true,"order":4},{"id":"screenshot","type":"file","label":"Screenshot (optional)","required":false,"order":5}] },
  { name: 'Employee Survey', description: 'Annual employee satisfaction survey with anonymous response collection.', category: 'Surveys', icon: 'BarChart3', fields: [{"id":"department","type":"select","label":"Department","required":true,"order":0,"options":[{"value":"eng","label":"Engineering"},{"value":"design","label":"Design"},{"value":"marketing","label":"Marketing"},{"value":"hr","label":"Human Resources"}]},{"id":"satisfaction","type":"rating","label":"Overall Job Satisfaction","required":true,"order":1},{"id":"worklife","type":"rating","label":"Work-Life Balance","required":true,"order":2},{"id":"management","type":"rating","label":"Management Quality","required":true,"order":3},{"id":"improvements","type":"textarea","label":"Suggested Improvements","required":false,"order":4},{"id":"recommend","type":"radio","label":"Would you recommend this company?","required":true,"order":5,"options":[{"value":"yes","label":"Yes"},{"value":"maybe","label":"Maybe"},{"value":"no","label":"No"}]}] },
];

async function main() {
  console.log('Seeding form templates...');

  for (const t of TEMPLATES) {
    const id = t.name.toLowerCase().replace(/\s+/g, '-');
    try {
      // Use create with upsert-like logic
      const existing = await prisma.form_templates.findUnique({ where: { id } });
      if (existing) {
        console.log(`  ⏭ ${t.name} (already exists)`);
        continue;
      }
      await prisma.form_templates.create({
        data: {
          id,
          name: t.name,
          description: t.description,
          category: t.category,
          icon: t.icon,
          isFeatured: t.isFeatured || false,
          fields: t.fields as any,
          theme: t.theme as any || null,
        },
      });
      console.log(`  ✓ ${t.name}`);
    } catch (err: any) {
      console.error(`  ✗ ${t.name}: ${err.message?.substring(0, 100)}`);
    }
  }

  const count = await prisma.form_templates.count();
  console.log(`\nTotal templates in DB: ${count}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
