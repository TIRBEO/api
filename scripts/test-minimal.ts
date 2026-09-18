console.log('starting');
const mod = require('@/features/auth/session');
console.log('session module loaded, exports:', Object.keys(mod).slice(0,10).join(','));
