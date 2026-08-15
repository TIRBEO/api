/**
 * Tirbeo Flows Seed Script
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let dbUrl = '';
try {
  const envContent = readFileSync(resolve(__dirname, '../.env'), 'utf-8');
  const match = envContent.match(/^DATABASE_URL=(.+)$/m);
  if (match) dbUrl = match[1].trim();
} catch {}

const connectionString = dbUrl || process.env.DATABASE_URL || '';
if (!connectionString) { console.error('❌ No DATABASE_URL'); process.exit(1); }

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

function rId() { return Math.random().toString(36).substring(2,15)+Math.random().toString(36).substring(2,15); }
function rDate(d: number) { return new Date(Date.now()-Math.random()*d*86400000); }
function rInt(a: number,b: number) { return Math.floor(Math.random()*(b-a+1))+a; }
function rItem<T>(a: T[]) { return a[Math.floor(Math.random()*a.length)]; }

async function main() {
  console.log('🚀 Tirbeo Flows seed...\n');

  // Check existing data
  const existingTables = await prisma.dataTable.count();
  if (existingTables > 0) {
    console.log(`ℹ️  Database already has ${existingTables} tables. Checking for other data...`);
    const existingWidgets = await prisma.widget.count();
    const existingDashboards = await prisma.dashboard.count();
    const existingEvents = await prisma.analyticsEvent.count();
    console.log(`  Widgets: ${existingWidgets}, Dashboards: ${existingDashboards}, Events: ${existingEvents}`);
    
    if (existingTables >= 4 && existingWidgets >= 6 && existingEvents > 0) {
      console.log('✅ Database already seeded. Skipping.');
      return;
    }
  }

  let ws = await prisma.workspace.findFirst();
  const wsId = ws?.id || null;
  if (ws) console.log('📋 Workspace:', ws.name);
  else console.log('⚠️  No workspace — seeding without workspace association');
  console.log('');

  const wsData = wsId ? { workspaceId: wsId } : {};

  // Tables
  console.log('📊 Creating tables...');
  const t1 = await prisma.dataTable.create({ data: { name: 'Contacts', description: 'Customer contacts', ...wsData, schema: [{name:'name',type:'text'},{name:'email',type:'email'},{name:'phone',type:'text'},{name:'company',type:'text'},{name:'status',type:'text'}] } });
  const t2 = await prisma.dataTable.create({ data: { name: 'Survey Responses', description: 'NPS surveys', ...wsData, schema: [{name:'respondent',type:'text'},{name:'nps_score',type:'number'},{name:'feedback',type:'text'}] } });
  const t3 = await prisma.dataTable.create({ data: { name: 'Orders', description: 'E-commerce orders', ...wsData, schema: [{name:'order_id',type:'text'},{name:'customer',type:'text'},{name:'amount',type:'number'},{name:'status',type:'text'}] } });
  const t4 = await prisma.dataTable.create({ data: { name: 'Newsletter Subscribers', description: 'Email list', ...wsData, schema: [{name:'email',type:'email'},{name:'name',type:'text'},{name:'source',type:'text'}] } });
  console.log('  ✅ 4 tables');

  // Records
  console.log('📝 Creating records...');
  const fn=['Alice','Bob','Charlie','Diana','Eve','Frank','Grace','Henry','Iris','Jack'];
  const ln=['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis'];
  const co=['Acme','TechStart','GlobalSolutions','InnovateLabs','DataFlow','CloudNine'];
  for(let i=0;i<20;i++){const a=rItem(fn),b=rItem(ln);await prisma.dataRecord.create({data:{tableId:t1.id,data:{name:`${a} ${b}`,email:`${a.toLowerCase()}@ex.com`,phone:`555-${rInt(100,999)}`,company:rItem(co),status:rItem(['lead','prospect','customer'])},createdBy:'system'}});}
  for(let i=0;i<15;i++)await prisma.dataRecord.create({data:{tableId:t2.id,data:{respondent:`${rItem(fn)} ${rItem(ln)}`,nps_score:rInt(0,10),feedback:rItem(['Great!','OK','Needs work','Love it'])},createdBy:'system'}});
  for(let i=0;i<15;i++)await prisma.dataRecord.create({data:{tableId:t3.id,data:{order_id:`ORD-${rInt(1000,9999)}`,customer:`${rItem(fn)} ${rItem(ln)}`,amount:rInt(25,500),status:rItem(['pending','shipped','delivered'])},createdBy:'system'}});
  for(let i=0;i<25;i++)await prisma.dataRecord.create({data:{tableId:t4.id,data:{email:`${rItem(fn).toLowerCase()}${rInt(1,99)}@ex.com`,name:`${rItem(fn)} ${rItem(ln)}`,source:rItem(['web','blog','social'])},createdBy:'system'}});
  console.log('  ✅ 75 records');

  // Views
  console.log('👁️ Creating views...');
  for(const t of [t1,t2,t3,t4]){await prisma.dataView.create({data:{name:'Grid',type:'TABLE',tableId:t.id,isDefault:true}});await prisma.dataView.create({data:{name:'Kanban',type:'KANBAN',tableId:t.id}});}
  console.log('  ✅ 8 views');

  // Widgets
  console.log('🧩 Creating widgets...');
  const wTypes=['CONTACT_FORM','LEAD_CAPTURE','SURVEY','EARLY_ACCESS','FEEDBACK','POLL'] as const;
  const wNames=['Contact Form','Lead Capture','NPS Survey','Early Access','Feedback','Quick Poll'];
  const wids=[];
  for(let i=0;i<6;i++){const w=await prisma.widget.create({data:{name:wNames[i],type:wTypes[i],...wsData,config:{},status:'ACTIVE',isPublic:true}});wids.push(w);}
  console.log('  ✅ 6 widgets');

  // Dashboards
  console.log('📈 Creating dashboards...');
  const d1=await prisma.dashboard.create({data:{name:'Sales Overview',description:'Revenue tracking',...wsData,layout:{},isPublic:true}});
  const d2=await prisma.dashboard.create({data:{name:'Customer Analytics',description:'Behavior metrics',...wsData,layout:{},isPublic:false}});
  await prisma.dashboardWidget.create({data:{dashboardId:d1.id,type:'chart',config:{title:'Revenue'},position:{x:0,y:0,w:6,h:4}}});
  await prisma.dashboardWidget.create({data:{dashboardId:d1.id,type:'kpi',config:{title:'Revenue',value:'$124K'},position:{x:6,y:0,w:3,h:2}}});
  await prisma.dashboardWidget.create({data:{dashboardId:d2.id,type:'table',config:{title:'Orders'},position:{x:0,y:0,w:12,h:4}}});
  console.log('  ✅ 2 dashboards');

  // Webhooks (skip if exist)
  console.log('🔗 Creating webhooks...');
  try{await prisma.dataWebhook.create({data:{url:'https://hooks.slack.com/example',name:'Slack',tableId:t1.id,events:['record.created'],isActive:true}});}catch{}
  try{await prisma.dataWebhook.create({data:{url:'https://api.example.com/hook',name:'API',tableId:t3.id,events:['record.created'],isActive:true}});}catch{}
  console.log('  ✅ 2 webhooks');

  // Data Sources
  console.log('🔌 Creating data sources...');
  await prisma.dataSource.create({data:{name:'Google Sheets',type:'GOOGLE_SHEETS',...wsData,config:{},status:'ACTIVE'}});
  await prisma.dataSource.create({data:{name:'REST API',type:'REST_API',...wsData,config:{},status:'ACTIVE'}});
  console.log('  ✅ 2 data sources');

  // Analytics
  console.log('📊 Creating analytics...');
  let ec=0;
  for(let d=0;d<30;d++){for(let i=0;i<rInt(5,15);i++){const dt=new Date();dt.setDate(dt.getDate()-d);dt.setHours(rInt(8,22),rInt(0,59));await prisma.analyticsEvent.create({data:{...wsData,eventType:rItem(['form.view','widget.view','table.view']),targetType:rItem(['form','widget','table']),targetId:rItem([t1.id,wids[0]?.id||'',t2.id]),sessionId:rId(),country:rItem(['US','UK','CA']),device:rItem(['desktop','mobile']),browser:rItem(['Chrome','Safari']),createdAt:dt}});ec++;}}
  console.log(`  ✅ ${ec} events`);

  for(let d=0;d<30;d++){const dt=new Date();dt.setDate(dt.getDate()-d);dt.setHours(0,0,0,0);for(const tt of ['form','widget','table']){await prisma.analyticsDaily.create({data:{...wsData,targetType:tt,targetId:rId(),date:dt,views:rInt(50,500),submissions:rInt(5,50),uniqueVisitors:rInt(30,300)}});}}
  console.log('  ✅ 90 daily analytics');

  for(let i=0;i<50;i++){const w=rItem(wids);if(w)await prisma.widgetView.create({data:{widgetId:w.id,visitorId:rId(),referrer:'direct',device:rItem(['desktop','mobile']),converted:Math.random()>0.7}});}
  console.log('  ✅ 50 widget views');

  // Templates
  console.log('📋 Creating templates...');
  const temps=[{name:'Contact Form',category:'Forms',icon:'Mail'},{name:'NPS Survey',category:'Surveys',icon:'BarChart'},{name:'Lead Capture',category:'Marketing',icon:'Users'},{name:'Event Registration',category:'Events',icon:'Calendar'},{name:'Feedback Form',category:'Forms',icon:'MessageSquare'},{name:'Order Form',category:'E-commerce',icon:'ShoppingCart'},{name:'Job Application',category:'HR',icon:'Briefcase'},{name:'Bug Report',category:'Dev',icon:'Bug'}];
  for(const t of temps)try{await prisma.flowsTemplate.create({data:{...t,description:`${t.name} template`,fields:[],isPublic:true,isFeatured:Math.random()>0.5}});}catch{}
  console.log(`  ✅ ${temps.length} templates`);

  console.log('\n🎉 Seed completed!');
}

main().catch(e=>{console.error('❌',e);process.exit(1)}).finally(()=>prisma.$disconnect());
