import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';

try { await access('.env', constants.F_OK); throw new Error('.env already exists; credentials will not be overwritten.'); }
catch(error) { if(error.code !== 'ENOENT') throw error; }
const roles = ['owner','researcher','evaluator','trader','treasury','market','coordinator'];
const principals = roles.map(role => ({id:'local-'+role,role,token:randomBytes(32).toString('base64url'),...(role==='trader'?{botId:'trend-bot'}:{})}));
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({type:'spki',format:'pem'}).toString();
const privateKey = keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
await mkdir('.local',{recursive:true});
await writeFile('.local/owner-signing-key.pem',privateKey,{flag:'wx',mode:0o600});
await writeFile('.local/credentials.json',JSON.stringify(principals,null,2),{flag:'wx',mode:0o600});
const lines = ['APP_MODE=paper','HOST=127.0.0.1','PORT=3000','DATABASE_PATH=.data/paper',`PRINCIPALS_JSON='${JSON.stringify(principals)}'`,`OWNER_PUBLIC_KEY_BASE64=${Buffer.from(publicKey).toString('base64')}`,'MAX_ORDER_PAISE=100000','MAX_EXPOSURE_PAISE=500000','MAX_REALISED_LOSS_PAISE=100000','PAPER_FEE_BPS=10','PAPER_SLIPPAGE_BPS=5'];
await writeFile('.env',lines.join('\n')+'\n',{flag:'wx',mode:0o600});
console.log('Created ignored local paper credentials. Secrets were not printed. Keep .local and .env private.');
