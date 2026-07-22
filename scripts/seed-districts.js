const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const districts = [
  ['Kathmandu',3],['Lalitpur',3],['Bhaktapur',3],['Kaski',4],['Morang',1],
  ['Sunishchitapur',1],['Jhapa',1],['Rupandehi',5],['Kailali',7],['Bara',2],
  ['Parsa',2],['Rautahat',2],['Saptari',1],['Siraha',1],['Dhanusha',2],
  ['Mahottari',2],['Sarlahi',2],['Udayapur',1],['Ilam',1],['Panchthar',1],
  ['Taplejung',1],['Bhojpur',1],['Dhankuta',1],['Terhathum',1],['Sankhuwasabha',1],
  ['Solukhumbu',1],['Okhaldhunga',1],['Khotang',1],['Dolakha',3],['Sindhupalchok',3],
  ['Rasuwa',3],['Nuwakot',3],['Dhading',3],['Makwanpur',3],['Gorkha',4],
  ['Lamjung',4],['Tanahu',4],['Nawalparasi',5],['Syangja',4],['Parbat',4],
  ['Myagdi',4],['Baglung',4],['Gulmi',5],['Palpa',5],['Kapilvastu',5],
  ['Arghakhanchi',5],['Rolpa',5],['Rukum West',5],['Salyan',5],['Dang',5],
  ['Pyuthan',5],['Banke',5],['Bardiya',5],['Surkhet',6],['Jumla',6],
  ['Kalikot',6],['Dailekh',6],['Achham',7],['Doti',7],['Bajhang',7],
  ['Bajura',7],['Darchula',7],['Baitadi',7],['Dadeldhura',7],['Humla',6],
  ['Mugu',6],['Dolpa',6],['Bardia',5],['Kanchanpur',7],['Manang',4],
  ['Mustang',4],['Rukum East',5],['Nawalparasi East',5]
];

async function seed() {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS districts (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    province INTEGER NOT NULL
  )`);
  for (const [name, province] of districts) {
    await prisma.$executeRawUnsafe(
      'INSERT INTO districts (name, province) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      name, province
    );
  }
  const count = await prisma.$queryRawUnsafe('SELECT COUNT(*) as count FROM districts');
  console.log('Districts seeded:', count[0].count);
  await prisma.$disconnect();
}

seed().catch(e => { console.error(e); process.exit(1); });
