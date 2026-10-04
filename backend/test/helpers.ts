import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Config } from '../src/config.js';
import { Actor } from '../src/core.js';
import { Database } from '../src/database.js';
import { OwnerAuthorization } from '../src/security.js';
import { Treasury, journal } from '../src/treasury.js';
import { Organisation } from '../src/organisation.js';
import { Research } from '../src/research.js';
import { PaperTrading } from '../src/paper.js';
import { Operations } from '../src/operations.js';

export const owner:Actor={id:'owner',role:'owner'};
export const researcher:Actor={id:'researcher',role:'researcher'};
export const evaluator:Actor={id:'evaluator',role:'evaluator'};
export const trader:Actor={id:'trader',role:'trader',botId:'bot-one'};
export const treasuryActor:Actor={id:'treasury',role:'treasury'};
export const market:Actor={id:'market',role:'market'};
export const key=()=>randomBytes(16).toString('hex');
export function config() {
  const pair=generateKeyPairSync('ed25519');
  const coordinator:Actor={id:'coordinator',role:'coordinator'};
  const cfg:Config={mode:'paper',host:'127.0.0.1',port:3000,databasePath:':memory:',principals:[owner,researcher,evaluator,trader,treasuryActor,market,coordinator].map(a=>({...a,token:randomBytes(32).toString('base64url')})),ownerPublicKey:pair.publicKey.export({type:'spki',format:'pem'}).toString(),maxOrder:10000000n,maxExposure:50000000n,maxLoss:1000000n,feeBps:0,slippageBps:0};
  return {cfg,privateKey:pair.privateKey};
}
export async function fixture() {
  const {cfg,privateKey}=config(),db=await Database.open();const auth=new OwnerAuthorization(db,cfg),treasury=new Treasury(db,cfg,auth),org=new Organisation(db),research=new Research(db),paper=new PaperTrading(db,cfg),ops=new Operations(db);
  const approval=async(request:unknown)=>{const c=await auth.challenge(owner,request);return {request,proof:{challengeId:c.challengeId,signature:sign(null,Buffer.from(c.message),privateKey).toString('base64url')}};};
  const deposit=async(amountPaise:string)=>treasury.ownerTransaction(owner,key(),await approval({action:'deposit',payload:{amountPaise,bankReference:key()}}));
  const result=async(amount:bigint)=>db.transaction(tx=>journal(tx,'test-result','test:'+key(),{},[['W1',amount],['PNL',-amount]]));
  const evidence=async()=>{
    const sourceId='source-'+key();await org.sources(owner,key(),{id:sourceId,name:'Synthetic fixture',url:'https://example.org/fixture',approved:true});
    const e=await org.evidence(researcher,key(),{sourceId,kind:'dataset',content:'Synthetic fixture '+key(),publishedAt:'2025-01-01T00:00:00Z'});
    await org.reviewEvidence(evaluator,key(),{evidenceId:e.id,status:'verified'});return {evidenceId:e.id as string,sourceId};
  };
  return {cfg,db,auth,treasury,org,research,paper,ops,approval,deposit,result,evidence};
}
export function bars(count:number,start:number,offset=0){return Array.from({length:count},(_,i)=>({timestamp:new Date(Date.UTC(2025,0,1+i+offset)).toISOString(),closePaise:String(start+i*100)}));}
