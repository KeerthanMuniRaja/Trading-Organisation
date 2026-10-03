import { randomInt } from 'node:crypto';
import { z } from 'zod';

export const skillRubric='research-basics-v1';
export const skillAnswers=z.object({
  netProfitPaise:z.number().int().min(-1000000).max(1000000),
  maxDrawdownBps:z.number().finite().min(0).max(10000),
  eligibleRecordIds:z.array(z.string().regex(/^record-[0-9]$/)).max(6).refine(v=>new Set(v).size===v.length),
  action:z.enum(['research','wait']),
}).strict();
export type Answers=z.infer<typeof skillAnswers>;
export type Challenge={
  grossProfitPaise:number;feesPaise:number;slippagePaise:number;equityPaise:number[];
  cutoff:string;records:{id:string;eventAt:string;availableAt:string}[];
  control:{halted:boolean;evidenceVerified:boolean;budget:number;required:number};
};
export function makeChallenge():Challenge {
  const day=randomInt(10,21),stamp=(offset:number)=>new Date(Date.UTC(2020,0,day+offset)).toISOString();
  const records=Array.from({length:6},(_,i)=>({id:'record-'+i,eventAt:stamp(randomInt(-3,3)),availableAt:stamp(randomInt(-3,3))}));
  // Availability can never precede the event it describes.
  for(const record of records)if(record.availableAt<record.eventAt)record.availableAt=record.eventAt;
  return {grossProfitPaise:randomInt(-5000,10001),feesPaise:randomInt(1,501),slippagePaise:randomInt(1,501),
    equityPaise:[10000,...Array.from({length:6},()=>randomInt(5000,15001))],cutoff:stamp(0),records,
    control:{halted:randomInt(0,2)===1,evidenceVerified:randomInt(0,2)===1,budget:randomInt(0,100),required:randomInt(1,100)}};
}
export function gradeSkill(challenge:Challenge,answers:Answers) {
  let peak=0,drawdown=0;
  for(const value of challenge.equityPaise){peak=Math.max(peak,value);drawdown=Math.max(drawdown,(peak-value)/peak*10000);}
  const eligible=challenge.records.filter(r=>Date.parse(r.eventAt)<=Date.parse(challenge.cutoff)&&Date.parse(r.availableAt)<=Date.parse(challenge.cutoff)).map(r=>r.id).sort();
  const c=challenge.control,action=!c.halted&&c.evidenceVerified&&c.budget>=c.required?'research':'wait';
  return {
    costs:answers.netProfitPaise===challenge.grossProfitPaise-challenge.feesPaise-challenge.slippagePaise,
    drawdown:Math.abs(answers.maxDrawdownBps-drawdown)<=0.0001,
    informationTiming:JSON.stringify([...answers.eligibleRecordIds].sort())===JSON.stringify(eligible),
    abstention:answers.action===action,
  };
}
