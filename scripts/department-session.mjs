import { randomUUID } from 'node:crypto';

export function supervisorTransport(env) {
  const base=new URL(env.API_URL);
  if(base.username||base.password||base.search||base.hash||base.pathname!=='/'||
    !(base.protocol==='https:'||(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))))throw new Error('Invalid supervisor API origin');
  return async(route,body)=>{
    const response=await fetch(new URL('/v1'+route,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
      headers:{Authorization:'Bearer '+env.API_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok){const error=new Error('Supervisor session HTTP '+response.status);error.retryable=response.status>=500;throw error;}
    return response.json();
  };
}

export class DepartmentSession {
  constructor(transport,{onLost=()=>{},heartbeatMs=20000}={}) {
    this.transport=transport;this.onLost=onLost;this.heartbeatMs=heartbeatMs;this.id=randomUUID();
    this.sequence=0;this.tail=Promise.resolve();this.active=false;this.lost=false;this.closing=false;
    this.state={state:'waiting',completedCycles:0,failedCycles:0};
  }
  async send(route,body,stopping=false) {
    let result;
    for(let attempt=0;attempt<2;attempt++){
      try{result=await this.transport(route,body);break;}
      catch(error){if(attempt||error.retryable===false)throw error;}
    }
    if(result?.sessionId!==this.id||result.sequence!==(body.sequence??0)||
      (!stopping&&(!Number.isFinite(result.remainingSeconds)||result.remainingSeconds<=20)))throw new Error('Supervisor lease acknowledgement is not current');
    return result;
  }
  async start() {
    await this.send('/workers/sessions',{sessionId:this.id});this.active=true;
    if(this.heartbeatMs)this.timer=setInterval(()=>{if(!this.busy&&!this.closing)this.pulse().catch(()=>{});},this.heartbeatMs);
  }
  pulse(change={}) {
    if(this.closing||this.lost)return Promise.reject(new Error('Supervisor session is closing or lost'));
    // Snapshot changes within the serial queue, so a retry keeps exactly the same counters/body.
    const operation=this.tail.then(async()=>{
      if(this.lost)throw new Error('Supervisor session lost');
      this.busy=true;
      try{
        this.state={...this.state,...change};
        const body={sessionId:this.id,sequence:this.sequence+1,...this.state};
        await this.send('/workers/heartbeats',body);this.sequence++;
      }catch(error){this.lost=true;clearInterval(this.timer);this.onLost();throw error;}
      finally{this.busy=false;}
    });
    this.tail=operation.catch(()=>{});return operation;
  }
  async stop() {
    this.closing=true;clearInterval(this.timer);await this.tail;
    if(!this.active||this.lost)return;
    const body={sessionId:this.id,sequence:this.sequence+1,...this.state,state:'stopped'};
    await this.send('/workers/heartbeats',body,true);this.sequence++;this.active=false;
  }
}
