import 'reflect-metadata';
import { ArgumentsHost, Body, Catch, Controller, ExceptionFilter, Get, Headers, HttpException, Module, Post, Req } from '@nestjs/common';
import { APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import helmet from 'helmet';
import { json } from 'express';
import { randomUUID } from 'node:crypto';
import { Actor } from './core.js';
import { Config } from './config.js';
import { Database } from './database.js';
import { Allow, ApiGuard, OwnerAuthorization, Public } from './security.js';
import { Treasury } from './treasury.js';
import { Organisation } from './organisation.js';
import { Research } from './research.js';
import { PaperTrading } from './paper.js';
import { Operations } from './operations.js';
import { PortfolioResearch } from './portfolio.js';
import { ResearchLifecycle } from './lifecycle.js';
import { ResearchDispatch } from './dispatch.js';
import { OrganisationReport } from './organisation-report.js';
import { OrganisationalLearning } from './learning.js';
import { ResearchDevelopment } from './development.js';
import { DevelopmentExperiments } from './development-experiments.js';
import { DepartmentSessions } from './department-sessions.js';
import { AcademySkills } from './skills.js';
import { SkillRecovery } from './skill-recovery.js';
import { SkillDiagnostics } from './skill-diagnostics.js';
import { SkillExperiments } from './skill-experiments.js';

type Request = { actor:Actor; requestId:string };
@Controller('v1')
class ApiController {
  @Post('learning/workflows') @Allow('owner') learningWorkflow(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.workflows().register(r.actor,k??'',b);}
  @Post('learning/workflows/progress') @Allow('owner','researcher','evaluator') learningWorkflowProgress(@Req() r:Request,@Body() b:unknown){return this.learning.workflows().progress(r.actor,b);}
  @Post('learning/workflows/links') @Allow('researcher','evaluator') learningWorkflowLink(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.workflows().attach(r.actor,k??'',b);}
  @Post('learning/workflows/cancellations') @Allow('owner') learningWorkflowCancel(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.workflows().cancel(r.actor,k??'',b);}
  @Get('learning/sources') @Allow('owner','evaluator') sourceLearningStatus(@Req() r:Request){return this.learning.sourceLearning().status(r.actor);}
  @Post('learning/sources/requests') @Allow('researcher') sourceLearningRequest(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.sourceLearning().request(r.actor,k??'',b);}
  @Post('learning/sources/preflight') @Allow('researcher') sourceLearningPreflight(@Req() r:Request,@Body() b:unknown){return this.learning.sourceLearning().preflight(r.actor,b);}
  @Post('learning/sources/proposals') @Allow('researcher') sourceLearningSubmit(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.sourceLearning().submit(r.actor,k??'',b);}
  @Post('learning/sources/reviews') @Allow('evaluator') sourceLearningReview(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.sourceLearning().review(r.actor,k??'',b);}
  @Post('sources/observations') @Allow('researcher','market') sourceObservation(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.org.observations().ingest(r.actor,k??'',b);}
  @Post('sources/observations/query') @Allow('owner','researcher','evaluator') sourceObservations(@Req() r:Request,@Body() b:unknown){return this.org.observations().list(r.actor,b);}
  constructor(private readonly auth:OwnerAuthorization,private readonly treasury:Treasury,private readonly org:Organisation,private readonly research:Research,private readonly paper:PaperTrading,private readonly ops:Operations,private readonly portfolio:PortfolioResearch,private readonly lifecycle:ResearchLifecycle,private readonly dispatch:ResearchDispatch,private readonly report:OrganisationReport,private readonly learning:OrganisationalLearning,private readonly development:ResearchDevelopment,private readonly developmentExperiments:DevelopmentExperiments,private readonly sessions:DepartmentSessions,private readonly skills:AcademySkills,private readonly recovery:SkillRecovery,private readonly diagnostics:SkillDiagnostics,private readonly skillExperiments:SkillExperiments) {}
  @Get('skills/experiments') @Allow('owner','evaluator') skillExperimentStatus(@Req() r:Request){return this.skillExperiments.status(r.actor);}
  @Get('skills/experiments/research-approvals') @Allow('owner','evaluator') researchApprovals(@Req() r:Request){return this.skillExperiments.researchApprovals(r.actor);}
  @Post('skills/experiments/research-approvals') @Allow('owner') approveResearch(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.skillExperiments.approveResearch(r.actor,k??'',b);}
  @Post('skills/experiments/research-approvals/revocations') @Allow('owner') revokeResearch(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.skillExperiments.revokeResearch(r.actor,k??'',b);}
  @Get('skills/experiments/execution-reports') @Allow('owner','evaluator') executionReports(@Req() r:Request){return this.skillExperiments.executionStatus(r.actor);}
  @Post('skills/experiments/execution-reports') @Allow('researcher') executionReport(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.skillExperiments.reportExecution(r.actor,k??'',b);}
  @Post('skills/experiments') @Allow('owner') skillExperimentRegister(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.skillExperiments.register(r.actor,k??'',b);}
  @Post('skills/experiments/work') @Allow('researcher') skillExperimentWork(@Req() r:Request,@Body() b:unknown){return this.skillExperiments.work(r.actor,b);}
  @Post('skills/experiments/submissions') @Allow('researcher') skillExperimentSubmit(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.skillExperiments.submit(r.actor,k??'',b);}
  @Post('skills/experiments/reviews') @Allow('evaluator') skillExperimentReview(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.skillExperiments.review(r.actor,k??'',b);}
  @Post('skills/experiments/cancellations') @Allow('owner') skillExperimentCancel(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.skillExperiments.cancel(r.actor,k??'',b);}
  @Get('skills/diagnostics') @Allow('owner','evaluator') skillDiagnostics(@Req() r:Request){return this.diagnostics.status(r.actor);}
  @Get('skills/versions') @Allow('owner','evaluator') skillVersions(@Req() r:Request){return this.diagnostics.versions(r.actor);}
  @Post('skills/versions/comparisons') @Allow('owner','evaluator') skillCompare(@Req() r:Request,@Body() b:unknown){return this.diagnostics.compare(r.actor,b);}
  @Post('skills/remediation/cycles') @Allow('researcher','evaluator') skillRemediation(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.diagnostics.cycle(r.actor,k??'',b);}
  @Get('skills/recoveries') @Allow('owner','evaluator') recoveryStatus(@Req() r:Request){return this.recovery.status(r.actor);}
  @Post('skills/recoveries') @Allow('owner') recoveryApprove(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.recovery.approve(r.actor,k??'',b);}
  @Post('skills/recoveries/revocations') @Allow('owner') recoveryRevoke(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.recovery.revoke(r.actor,k??'',b);}
  @Get('skills') @Allow('owner','evaluator') skillsStatus(@Req() r:Request){return this.skills.status(r.actor);}
  @Post('skills/policy') @Allow('owner') skillsPolicy(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.skills.configure(r.actor,k??'',b);}
  @Post('skills/claims') @Allow('researcher') skillsClaim(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.skills.claim(r.actor,k??'',b);}
  @Post('skills/submissions') @Allow('researcher') skillsSubmit(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.skills.submit(r.actor,k??'',b);}
  @Post('skills/cycles') @Allow('evaluator') skillsCycle(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.skills.cycle(r.actor,k??'',b);}
  @Get('health') @Public() health(){ return {status:'ok',mode:'paper',liveExecution:false}; }
  @Get('workers') @Allow('owner') workers(@Req() r:Request){return this.sessions.status(r.actor);}
  @Post('workers/sessions') @Allow('researcher','evaluator') workerSession(@Req() r:Request,@Body() b:unknown){return this.sessions.start(r.actor,b);}
  @Post('workers/heartbeats') @Allow('researcher','evaluator') workerHeartbeat(@Req() r:Request,@Body() b:unknown){return this.sessions.heartbeat(r.actor,b);}
  @Get('development/experiments') @Allow('owner','evaluator') developmentExperimentsStatus(@Req() r:Request){return this.developmentExperiments.status(r.actor);}
  @Post('development/experiments') @Allow('owner') developmentExperiment(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.developmentExperiments.register(r.actor,k??'',b);}
  @Post('development/experiments/cycles') @Allow('evaluator') developmentExperimentCycle(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.developmentExperiments.cycle(r.actor,k??'',b);}
  @Post('development/experiments/cancellations') @Allow('owner') developmentExperimentCancel(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.developmentExperiments.cancel(r.actor,k??'',b);}
  @Get('development') @Allow('owner','evaluator') developmentStatus(@Req() r:Request){return this.development.status(r.actor);}
  @Post('development/policy') @Allow('owner') developmentPolicy(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.development.configure(r.actor,k??'',b);}
  @Post('development/requests') @Allow('researcher') developmentRequest(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.development.request(r.actor,k??'',b);}
  @Post('development/preflight') @Allow('researcher') developmentPreflight(@Req() r:Request,@Body() b:unknown){return this.development.preflight(r.actor,b);}
  @Post('development/proposals') @Allow('researcher') developmentProposal(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.development.submit(r.actor,k??'',b);}
  @Post('development/reviews') @Allow('owner','evaluator') developmentReview(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.development.review(r.actor,k??'',b);}
  @Get('organisation/report') @Allow('owner') organisationReport(@Req() r:Request){return this.report.snapshot(r.actor);}
  @Post('learning/knowledge/assessments') @Allow('evaluator') knowledgeAssessment(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.knowledgeAssessments().create(r.actor,k??'',b);}
  @Post('learning/knowledge/assessments/work') @Allow('researcher') knowledgeAssessmentWork(@Req() r:Request,@Body() b:unknown){return this.learning.knowledgeAssessments().work(r.actor,b);}
  @Post('learning/knowledge/assessments/answers') @Allow('researcher') knowledgeAssessmentAnswers(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.knowledgeAssessments().submit(r.actor,k??'',b);}
  @Post('learning/knowledge/assessments/grades') @Allow('evaluator') knowledgeAssessmentGrade(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.knowledgeAssessments().grade(r.actor,k??'',b);}
  @Post('learning/knowledge/graph') @Allow('owner','evaluator') knowledgeGraph(@Req() r:Request,@Body() b:unknown){return this.learning.knowledge().graph(r.actor,b);}
  @Post('learning/knowledge/requests') @Allow('researcher') knowledgeRequest(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.knowledge().request(r.actor,k??'',b);}
  @Post('learning/knowledge/preflight') @Allow('researcher') knowledgePreflight(@Req() r:Request,@Body() b:unknown){return this.learning.knowledge().preflight(r.actor,b);}
  @Post('learning/knowledge/proposals') @Allow('researcher') knowledgeProposal(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.knowledge().submit(r.actor,k??'',b);}
  @Post('learning/knowledge/reviews') @Allow('evaluator') knowledgeReview(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.knowledge().review(r.actor,k??'',b);}
  @Get('learning') @Allow('owner','evaluator') learningStatus(@Req() r:Request){return this.learning.status(r.actor);}
  @Post('learning/models') @Allow('owner') learningModel(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.register(r.actor,k??'',b);}
  @Post('learning/model-revocations') @Allow('owner') learningRevoke(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.revoke(r.actor,k??'',b);}
  @Post('learning/policy') @Allow('owner') learningPolicy(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.configure(r.actor,k??'',b);}
  @Post('learning/cycles') @Allow('researcher','evaluator') learningCycle(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.learning.cycle(r.actor,k??'',b);}
  @Post('learning/memory') @Allow('owner','researcher','evaluator') learningMemory(@Req() r:Request,@Body() b:unknown){return this.learning.memory(r.actor,b);}
  @Get('dispatch') @Allow('owner','evaluator') dispatchStatus(@Req() r:Request){return this.dispatch.status(r.actor);}
  @Post('dispatch/policy') @Allow('owner') dispatchPolicy(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.dispatch.configure(r.actor,k??'',b);}
  @Post('dispatch/cycles') @Allow('owner','evaluator') dispatchCycle(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.dispatch.cycle(r.actor,k??'',b);}
  @Post('dispatch/claims') @Allow('researcher') dispatchClaim(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.dispatch.claim(r.actor,k??'',b);}
  @Post('dispatch/reviews') @Allow('evaluator') dispatchReviews(@Req() r:Request){return this.dispatch.reviews(r.actor);}
  @Post('dispatch/cancellations') @Allow('owner') dispatchCancel(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){return this.dispatch.cancel(r.actor,k??'',b);}
  @Post('owner/challenges') @Allow('owner') challenge(@Req() r:Request,@Body() b:unknown){ return this.auth.challenge(r.actor,b); }
  @Post('owner/transactions') @Allow('owner') ownerTransaction(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.treasury.ownerTransaction(r.actor,k??'',b); }
  @Get('treasury') @Allow('owner','treasury') treasurySnapshot(@Req() r:Request){ return this.treasury.snapshot(r.actor); }
  @Get('treasury/ledger') @Allow('owner') ledger(@Req() r:Request){ return this.treasury.history(r.actor); }
  @Post('treasury/allocations') @Allow('treasury') allocate(@Req() r:Request,@Headers('idempotency-key') k:string){ return this.treasury.allocate(r.actor,k??''); }
  @Post('treasury/confirmations') @Allow('treasury') confirm(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.treasury.confirm(r.actor,k??'',b); }
  @Post('sources') @Allow('owner') source(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.org.sources(r.actor,k??'',b); }
  @Post('evidence') @Allow('owner','researcher','market') evidence(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.org.evidence(r.actor,k??'',b); }
  @Post('evidence/reviews') @Allow('owner','evaluator') evidenceReview(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.org.reviewEvidence(r.actor,k??'',b); }
  @Post('evidence/revocations') @Allow('owner','evaluator') revoke(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.org.revoke(r.actor,k??'',b); }
  @Get('knowledge') @Allow('owner','researcher','evaluator') knowledge(@Req() r:Request){ return this.org.knowledge(r.actor); }
  @Post('bots') @Allow('owner') createBot(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.org.bot(r.actor,k??'',b); }
  @Get('bots') @Allow('owner','researcher','evaluator') bots(@Req() r:Request){ return this.org.list(r.actor); }
  @Get('lifecycle') @Allow('owner','evaluator') lifecycleStatus(@Req() r:Request){ return this.lifecycle.status(r.actor); }
  @Get('lifecycle/community') @Allow('owner','researcher','evaluator') community(@Req() r:Request){ return this.lifecycle.community(r.actor); }
  @Get('lifecycle/archives') @Allow('owner','evaluator') archives(@Req() r:Request){ return this.lifecycle.archives(r.actor); }
  @Post('lifecycle/policy') @Allow('owner') lifecyclePolicy(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.lifecycle.configure(r.actor,k??'',b); }
  @Post('lifecycle/blueprints') @Allow('owner') blueprint(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.lifecycle.blueprint(r.actor,k??'',b); }
  @Post('lifecycle/withdrawals') @Allow('owner') withdrawBlueprint(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.lifecycle.withdraw(r.actor,k??'',b); }
  @Post('lifecycle/cycles') @Allow('owner','evaluator') lifecycleCycle(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.lifecycle.cycle(r.actor,k??'',b); }
  @Post('bots/school-completions') @Allow('owner') school(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.org.school(r.actor,k??'',b); }
  @Post('bots/retirements') @Allow('owner') retire(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.org.retire(r.actor,k??'',b); }
  @Post('lessons') @Allow('owner','researcher') lesson(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.org.lesson(r.actor,k??'',b); }
  @Post('lessons/reviews') @Allow('owner','evaluator') lessonReview(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.org.verifyLesson(r.actor,k??'',b); }
  @Post('datasets') @Allow('owner') dataset(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.research.dataset(r.actor,k??'',b); }
  @Post('portfolio/datasets') @Allow('owner') portfolioDataset(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.portfolio.dataset(r.actor,k??'',b); }
  @Post('portfolio/training') @Allow('researcher') portfolioTraining(@Req() r:Request,@Body() b:unknown){ return this.portfolio.training(r.actor,b); }
  @Post('portfolio/trials') @Allow('researcher') portfolioSubmit(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.portfolio.submit(r.actor,k??'',b); }
  @Post('portfolio/reviews') @Allow('evaluator') portfolioReview(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.portfolio.review(r.actor,k??'',b); }
  @Post('portfolio/cancellations') @Allow('owner') portfolioCancel(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.portfolio.cancel(r.actor,k??'',b); }
  @Get('portfolio/trials') @Allow('owner','evaluator') portfolioReports(@Req() r:Request){ return this.portfolio.reports(r.actor); }
  @Post('experiments') @Allow('researcher') experiment(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.research.experiment(r.actor,k??'',b); }
  @Get('experiments') @Allow('owner','evaluator') experiments(@Req() r:Request){ return this.research.reports(r.actor); }
  @Get('coordination/tasks') @Allow('coordinator') coordination(@Req() r:Request){ return this.research.coordination(r.actor); }
  @Post('coordination/status') @Allow('coordinator') coordinationStatus(@Req() r:Request,@Body() b:unknown){ return this.ops.integrationStatus(r.actor,b); }
  @Post('jobs/claims') @Allow('researcher','evaluator') claim(@Req() r:Request){ return this.research.claim(r.actor); }
  @Post('jobs/completions') @Allow('researcher','evaluator') complete(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.research.complete(r.actor,k??'',b); }
  @Post('market/quotes') @Allow('market') quote(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.paper.quote(r.actor,k??'',b); }
  @Get('paper/positions') @Allow('owner','trader') positions(@Req() r:Request){ return this.paper.positions(r.actor); }
  @Post('paper/orders') @Allow('trader') reserve(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.paper.reserve(r.actor,k??'',b); }
  @Post('paper/fills') @Allow('trader') fill(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.paper.fill(r.actor,k??'',b); }
  @Post('paper/cancellations') @Allow('owner','trader') cancel(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.paper.cancel(r.actor,k??'',b); }
  @Post('incidents') @Allow('owner','researcher','evaluator','trader','treasury','market') incident(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.ops.incident(r.actor,k??'',b); }
  @Post('incidents/resolutions') @Allow('owner') resolve(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.ops.resolve(r.actor,k??'',b); }
  @Post('operations/control') @Allow('owner') control(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.ops.control(r.actor,k??'',b); }
  @Get('operations') @Allow('owner') status(@Req() r:Request){ return this.ops.status(r.actor); }
  @Post('notifications/acknowledgments') @Allow('owner') ack(@Req() r:Request,@Headers('idempotency-key') k:string,@Body() b:unknown){ return this.ops.acknowledge(r.actor,k??'',b); }
  @Get('audit') @Allow('owner') audit(@Req() r:Request){ return this.ops.auditTrail(r.actor); }
  @Get('audit/integrity') @Allow('owner') integrity(@Req() r:Request){ return this.ops.verifyAudit(r.actor); }
}
@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost) {
    const ctx=host.switchToHttp(),request=ctx.getRequest(),response=ctx.getResponse();
    const sqlCode=(error as {code?:string})?.code;
    const status=error instanceof HttpException?error.getStatus():sqlCode==='23505'?409:500;
    const detail=error instanceof HttpException?error.getResponse():status===409?'Record already exists':'Internal operation failed';
    response.status(status).json({statusCode:status,error:detail,requestId:request.requestId});
  }
}
export async function createApp(config:Config,db:Database,quiet=false) {
  const auth=new OwnerAuthorization(db,config);
  const services=[{provide:OwnerAuthorization,useValue:auth},{provide:Treasury,useValue:new Treasury(db,config,auth)},{provide:Organisation,useValue:new Organisation(db)},{provide:Research,useValue:new Research(db)},{provide:PaperTrading,useValue:new PaperTrading(db,config)},{provide:Operations,useValue:new Operations(db)},{provide:PortfolioResearch,useValue:new PortfolioResearch(db)},{provide:ResearchLifecycle,useValue:new ResearchLifecycle(db)},{provide:ResearchDispatch,useValue:new ResearchDispatch(db)},{provide:OrganisationReport,useValue:new OrganisationReport(db)},{provide:OrganisationalLearning,useValue:new OrganisationalLearning(db)},{provide:ResearchDevelopment,useValue:new ResearchDevelopment(db)},{provide:DevelopmentExperiments,useValue:new DevelopmentExperiments(db)},{provide:DepartmentSessions,useValue:new DepartmentSessions(db)}];
  @Module({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:120}])],controllers:[ApiController],providers:[...services,{provide:AcademySkills,useValue:new AcademySkills(db)},{provide:SkillRecovery,useValue:new SkillRecovery(db)},{provide:SkillDiagnostics,useValue:new SkillDiagnostics(db)},{provide:SkillExperiments,useValue:new SkillExperiments(db)},{provide:APP_GUARD,useClass:ThrottlerGuard}]})
  class RootModule {}
  const app=await NestFactory.create(RootModule,{logger:quiet?false:['error','warn','log'],bodyParser:false});
  app.use(helmet());app.use(json({limit:'512kb',strict:true}));
  app.use((req:any,res:any,next:()=>void)=>{req.requestId=randomUUID();res.setHeader('X-Request-Id',req.requestId);res.setHeader('Cache-Control','no-store');next();});
  app.useGlobalGuards(new ApiGuard(config,app.get(Reflector)));app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();await app.init();return app;
}
