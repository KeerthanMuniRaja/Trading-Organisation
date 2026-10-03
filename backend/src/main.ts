import { loadConfig } from './config.js';
import { Database } from './database.js';
import { createApp } from './app.js';

async function main() {
  const config=loadConfig();const db=await Database.open(config.databasePath,config.databaseUrl);
  try {
    const app=await createApp(config,db);
    app.getHttpAdapter().getInstance().disable('x-powered-by');
    await app.listen(config.port,config.host);
    let closing=false;
    const shutdown=async()=>{if(closing)return;closing=true;await app.close();await db.close();};
    process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
    console.log(JSON.stringify({event:'backend.ready',mode:'paper',host:config.host,port:config.port}));
  } catch(error) {await db.close();throw error;}
}
void main().catch(error=>{console.error('Startup failed:',error instanceof Error?error.message:'unknown');process.exitCode=1;});
