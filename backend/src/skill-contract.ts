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
// research-methods-v1: the answer names how to compute each check; deriveAnswers applies it deterministically and the
// ordinary research-basics grading then decides. Wrong methods yield wrong numbers, so concepts stay strictly graded.
export const methodsRubric='research-methods-v1';
export const knowledgeRubrics=[skillRubric,methodsRubric] as const;
const costTerm=z.enum(['+grossProfitPaise','-grossProfitPaise','+feesPaise','-feesPaise','+slippagePaise','-slippagePaise']);
export const methodAnswers=z.object({
  costTerms:z.array(costTerm).min(1).max(3).refine(v=>new Set(v.map(t=>t.slice(1))).size===v.length,'Each amount may appear once'),
  drawdownMethod:z.enum(['running-peak-to-trough','first-to-last','first-to-minimum','maximum-to-minimum']),
  timingRule:z.enum(['event-and-availability-at-or-before-cutoff','event-at-or-before-cutoff','availability-at-or-before-cutoff','all-records']),
  action:z.enum(['research','wait']),
}).strict();
export type MethodAnswers=z.infer<typeof methodAnswers>;
export function deriveAnswers(c:Challenge,m:MethodAnswers):Answers {
  const amounts={grossProfitPaise:c.grossProfitPaise,feesPaise:c.feesPaise,slippagePaise:c.slippagePaise};
  const netProfitPaise=m.costTerms.reduce((sum,term)=>sum+(term[0]==='-'?-1:1)*amounts[term.slice(1) as keyof typeof amounts],0);
  const e=c.equityPaise,first=e[0]!,last=e.at(-1)!,low=Math.min(...e),high=Math.max(...e);
  let drawdown=0;
  if(m.drawdownMethod==='running-peak-to-trough'){let peak=0;for(const v of e){peak=Math.max(peak,v);drawdown=Math.max(drawdown,(peak-v)/peak*10000);}}
  else if(m.drawdownMethod==='first-to-last')drawdown=Math.max(0,(first-last)/first*10000);
  else if(m.drawdownMethod==='first-to-minimum')drawdown=Math.max(0,(first-low)/first*10000);
  else drawdown=(high-low)/high*10000;
  const cutoff=Date.parse(c.cutoff),eventOk=(r:{eventAt:string})=>Date.parse(r.eventAt)<=cutoff,availableOk=(r:{availableAt:string})=>Date.parse(r.availableAt)<=cutoff;
  const rule={'event-and-availability-at-or-before-cutoff':(r:Challenge['records'][number])=>eventOk(r)&&availableOk(r),
    'event-at-or-before-cutoff':eventOk,'availability-at-or-before-cutoff':availableOk,'all-records':()=>true}[m.timingRule];
  return {netProfitPaise,maxDrawdownBps:Math.min(10000,drawdown),eligibleRecordIds:c.records.filter(rule).map(r=>r.id),action:m.action};
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
