import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,researcher,evaluator,trader,key} from './helpers.js';
import {ResearchDevelopment} from '../src/development.js';
import {BotKnowledge} from '../src/bot-knowledge.js';
import {KnowledgeAssessments} from '../src/knowledge-assessments.js';
import {Challenge} from '../src/skill-contract.js';

test('resolved incident lessons retain provenance, require review, and share without cloning',async()=>{
  const f=await fixture();try{
    const evidence=await f.evidence();
    for(const id of ['student','peer'])await f.org.bot(owner,key(),{id,name:id,department:'research',specialty:id,method:'incident-learning',contribution:'Learn from reviewed failures',budgetPaise:'0'});
    const incident=await f.ops.incident(researcher,key(),{severity:'critical',description:'Stale inputs'});
    const findings=f.ops.findings();
    const input={incidentId:incident.id,evidenceId:evidence.evidenceId,rootCause:'Stale timestamps',correctiveAction:'Reject stale data',prevention:'Check age at decision time',verificationPlan:'Replay stale inputs'};
    const old=await findings.propose(researcher,key(),input);
    await findings.review(evaluator,key(),{findingId:old.id,decision:'accepted',reason:'Initial analysis'});
    const current=await findings.propose(researcher,key(),{...input,prevention:'Check age at decision and execution'});
    await findings.review(evaluator,key(),{findingId:current.id,decision:'accepted',reason:'Correction reviewed'});
    const lessonInput={findingId:current.id,botId:'student',content:'Recheck data freshness at execution; a plan alone does not prove remediation.'};
    assert.throws(()=>findings.lesson(trader,key(),lessonInput),/not permitted/);
    await assert.rejects(findings.lesson(owner,key(),lessonInput),/resolved incident/);
    await f.ops.resolve(owner,key(),{incidentId:incident.id,evidenceId:evidence.evidenceId});
    await assert.rejects(findings.lesson(owner,key(),{...lessonInput,findingId:old.id}),/Latest finding/);
    const retryKey=key();
    const lesson=await findings.lesson(owner,retryKey,lessonInput);
    assert.equal((await findings.lesson(owner,retryKey,lessonInput)).id,lesson.id);
    await assert.rejects(findings.lesson(researcher,key(),{...lessonInput,botId:'peer'}),/already has a lesson/);
    assert.equal((await f.org.knowledge(researcher)).lessons.length,0);
    await assert.rejects(f.org.school(owner,key(),{botId:'peer',lessonIds:[lesson.id]}),/Verified lesson/);
    await assert.rejects(f.org.verifyLesson(owner,key(),{lessonId:lesson.id}),/Independent lesson/);
    await assert.rejects(f.org.verifyLesson({...researcher,role:'evaluator'},key(),{lessonId:lesson.id}),/independent of finding/);
    await f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id});
    const learning=f.ops.incidentLearning(),knowledge=new BotKnowledge(f.db);
    const task='Apply this incident lesson and identify limits of the proposed prevention';
    const assignmentInput={lessonId:lesson.id,botIds:['peer'],task};
    assert.throws(()=>learning.assign(researcher,key(),assignmentInput),/not permitted/);
    await assert.rejects(learning.assign(owner,key(),{...assignmentInput,botIds:['peer','missing']}),/Active recipient/);
    assert.equal((await learning.progress(owner,{lessonId:lesson.id})).assignments.length,0);
    const assignmentKey=key(),assignment=await learning.assign(owner,assignmentKey,assignmentInput);
    assert.deepEqual(await learning.assign(owner,assignmentKey,assignmentInput),assignment);
    await assert.rejects(learning.assign(owner,key(),assignmentInput),/already assigned/);
    const assignmentId=assignment.assignments[0]!.id;
    const assignedGraph=await knowledge.graph(owner,{botId:'peer'});
    assert.ok(assignedGraph.edges.some(e=>e.from==='incident:'+incident.id&&e.to==='finding:'+current.id));
    assert.ok(assignedGraph.edges.some(e=>e.to==='assignment:'+assignmentId&&e.type==='assigned-through'));
    await new ResearchDevelopment(f.db).configure(owner,key(),{expectedRevision:0,enabled:true,model:{name:'test-model',baseUrl:'http://127.0.0.1:8000/v1'},maxPerDay:10,maxLifetime:100});
    await f.ops.control(owner,key(),{halted:false,reason:'Owner permits research after resolution'});
    const wrong=await knowledge.request(researcher,key(),{botId:'peer',lessonIds:[lesson.id],task:'Wrong task'});
    await assert.rejects(learning.link(researcher,key(),{assignmentId,requestId:wrong.id}),/exact task/);
    const ticket=await knowledge.request(researcher,key(),{botId:'peer',lessonIds:[lesson.id],task});
    await assert.rejects(learning.link({...researcher,id:'other'},key(),{assignmentId,requestId:ticket.id}),/author/);
    await learning.link(researcher,key(),{assignmentId,requestId:ticket.id});
    await learning.link(researcher,key(),{assignmentId,requestId:ticket.id});
    await knowledge.submit(researcher,key(),{requestId:ticket.id,contextHash:ticket.contextHash,proposal:{summary:'Review the failure',application:'Check timestamps at execution',lessonIds:[lesson.id],checks:['Check input age'],risks:['Remediation remains unproven']}});
    await knowledge.review(evaluator,key(),{requestId:ticket.id,decision:'accepted',reason:'Suitable for assessment'});
    const assessments=new KnowledgeAssessments(f.db),assessment=await assessments.create(evaluator,key(),{requestId:ticket.id});
    const work=await assessments.work(researcher,{assessmentId:assessment.assessmentId});
    const answers=work.cases.map((item:{id:string;challenge:Challenge})=>{
      const c=item.challenge;let peak=0,drawdown=0;
      for(const n of c.equityPaise){peak=Math.max(peak,n);drawdown=Math.max(drawdown,(peak-n)/peak*10000);}
      return {caseId:item.id,answers:{netProfitPaise:c.grossProfitPaise-c.feesPaise-c.slippagePaise,maxDrawdownBps:drawdown,
        eligibleRecordIds:c.records.filter(r=>r.eventAt<=c.cutoff&&r.availableAt<=c.cutoff).map(r=>r.id),
        action:!c.control.halted&&c.control.evidenceVerified&&c.control.budget>=c.control.required?'research':'wait'}};
    });
    await assessments.submit(researcher,key(),{assessmentId:assessment.assessmentId,answers});
    await assessments.grade(evaluator,key(),{assessmentId:assessment.assessmentId});
    const progress=await learning.progress(owner,{lessonId:lesson.id});
    assert.equal(progress.attempts.length,1);assert.equal(progress.attempts[0]!.report.outcome,'passed');
    assert.equal(progress.attempts[0]!.context_current,true);assert.equal(progress.incidentMasteryEstablished,false);
    const graph=await knowledge.graph(owner,{botId:'peer'});
    assert.ok(graph.edges.some(e=>e.from==='assignment:'+assignmentId&&e.to==='transfer:'+ticket.id));
    assert.ok(graph.edges.some(e=>e.to==='assessment:'+assessment.assessmentId));
    const nodeIds=new Set(graph.nodes.map(n=>n.id));assert.ok(graph.edges.every(e=>nodeIds.has(e.from)&&nodeIds.has(e.to)));
    for(const table of ['incident_learning_assignments','incident_learning_attempts'])await assert.rejects(f.db.transaction(tx=>tx.query('DELETE FROM '+table)));
    await f.ops.control(owner,key(),{halted:true,reason:'Pause after research test'});
    await f.org.school(owner,key(),{botId:'peer',lessonIds:[lesson.id]});
    const history=await findings.list(owner,{incidentId:incident.id});
    assert.equal(history.findings[1]!.lesson_id,lesson.id);
    assert.equal(history.findings[1]!.lesson_status,'verified');
    assert.equal((await f.ops.status(owner)).control!.halted,true);
    await f.org.retire(owner,key(),{botId:'student',reason:'Knowledge preserved',transferLessonIds:[lesson.id]});
    assert.equal((await f.org.knowledge(researcher)).lessons[0]!.id,lesson.id);
    await f.org.revoke(owner,key(),{kind:'source',targetId:evidence.sourceId,reason:'Withdraw support'});
    assert.equal((await f.org.knowledge(researcher)).lessons.length,0);
    assert.equal((await findings.list(owner,{incidentId:incident.id})).findings[1]!.support_current,false);
    const withdrawn=await learning.progress(owner,{lessonId:lesson.id});
    assert.equal(withdrawn.assignments[0]!.support_current,false);
    assert.equal(withdrawn.attempts[0]!.context_current,false);
    assert.equal(withdrawn.attempts[0]!.report.outcome,'passed');
    assert.equal((await f.ops.verifyAudit(owner)).valid,true);
  }finally{await f.db.close();}
});

test('withdrawn support prevents incident lesson creation and review',async()=>{
  const f=await fixture();try{
    const {evidenceId,sourceId}=await f.evidence();
    await f.org.bot(owner,key(),{id:'student',name:'Student',department:'research',specialty:'incidents',method:'review',contribution:'Learn',budgetPaise:'0'});
    const incident=await f.ops.incident(researcher,key(),{severity:'warning',description:'Failure'});
    const finding=await f.ops.findings().propose(researcher,key(),{incidentId:incident.id,evidenceId,rootCause:'Cause',correctiveAction:'Action',prevention:'Prevention',verificationPlan:'Check'});
    await f.ops.findings().review(evaluator,key(),{findingId:finding.id,decision:'accepted',reason:'Reviewed'});
    await f.ops.resolve(owner,key(),{incidentId:incident.id,evidenceId});
    const input={findingId:finding.id,botId:'student',content:'A reviewed hypothesis'};
    const lesson=await f.ops.findings().lesson(researcher,key(),input);
    await f.org.revoke(owner,key(),{kind:'source',targetId:sourceId,reason:'Invalid source'});
    await assert.rejects(f.org.verifyLesson(evaluator,key(),{lessonId:lesson.id}),/Verified evidence/);
    await assert.rejects(f.ops.findings().lesson(owner,key(),input),/Verified evidence/);
  }finally{await f.db.close();}
});
