async function main() {
  console.log('Attempting to import session module...');
  try {
    const sessionModule = await import('../features/auth/session.js');
    console.log('session module imported OK');
    console.log('Available exports:', Object.keys(sessionModule).slice(0,20).join(','));
  } catch (e) {
    console.log('session import FAILED:', e.message.slice(0,300));
  }
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
