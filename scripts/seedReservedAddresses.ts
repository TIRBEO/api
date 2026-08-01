import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL }) });

const SEED: { address: string; category: string; level: string; reason: string }[] = [
  ...['admin','root','system','tirbeo','support','postmaster','api','auth','login','signup','www','mail','noreply','no-reply','abuse','security','help','info','contact','team','office'].map(a=>({address:a,category:'system',level:'hard',reason:'System reserved'})),
  ...['superadmin','super_admin','moderator','mod','editor','author','contributor','member','owner','ceo','cto','cfo','coo','manager','adminpanel','backoffice'].map(a=>({address:a,category:'role',level:'hard',reason:'Admin role name'})),
  ...['brand','marketing','sales','press','partners','affiliates'].map(a=>({address:a,category:'branding',level:'hard',reason:'Brand name'})),
  ...['dev','staging','beta','alpha','test','demo','status','monitor','health','uptime','metrics','cdn','static','assets','media','proxy','gateway','edge','cf','cloudflare','ops','devops','sre','platform','infra','server','node','worker','daemon','service'].map(a=>({address:a,category:'infrastructure',level:'hard',reason:'Infrastructure name'})),
  ...['smtp','imap','pop3','mx','ftp','dns','ns1','ns2','ns3','ns4','mx1','mx2','ws','wss','graphql','socket','realtime','live'].map(a=>({address:a,category:'protocol',level:'hard',reason:'Protocol/service name'})),
  ...['blog','docs','wiki','knowledge','learn','academy','community','forum','chat','messaging','jobs','careers','hiring','recruit'].map(a=>({address:a,category:'content',level:'hard',reason:'Content/community name'})),
  ...['legal','terms','privacy','cookies','gdpr','dmca','billing','payments','stripe','invoice','subscribe'].map(a=>({address:a,category:'legal',level:'hard',reason:'Legal/policy name'})),
  ...['notifications','alerts','webhooks','hooks'].map(a=>({address:a,category:'messaging',level:'hard',reason:'Messaging system name'})),
  ...['exports','imports','backup','restore','archive','search','find','query','index','config','settings','setup','init','env','dashboard','console','panel','default','public','private','internal','client','mobile','ios','android','web','app','error','errors','exception','crash','null','undefined','void','none','empty','true','false','yes','no','on','off','delete','remove','destroy','drop','purge','oauth','sso','register'].map(a=>({address:a,category:'utility',level:'hard',reason:'Utility/system name'})),
];

async function main() {
  console.log(`Upserting ${SEED.length} reserved addresses...`);
  for (const entry of SEED) {
    try {
      await prisma.reservedAddress.upsert({
        where: { address: entry.address },
        update: {},
        create: entry,
      });
    } catch (e: any) {
      console.error(`Failed: ${entry.address} - ${e?.message}`);
    }
  }
  const count = await prisma.reservedAddress.count();
  console.log(`Done. Total reserved addresses in DB: ${count}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
