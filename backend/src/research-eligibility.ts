import { Sql } from './database.js';

export async function curriculumStatus(tx:Sql,botId:string) {
  const rows=(await tx.query(`SELECT c.lesson_id,(l.status='verified' AND e.status='verified' AND s.approved=true) AS valid
    FROM bot_curriculum c JOIN lessons l ON l.id=c.lesson_id JOIN evidence e ON e.id=l.evidence_id
    JOIN sources s ON s.id=e.source_id WHERE c.bot_id=$1 ORDER BY c.lesson_id`,[botId])).rows;
  return {valid:rows.length>0&&rows.every(r=>r.valid),lessonCount:rows.length,
    invalidLessonIds:rows.filter(r=>!r.valid).map(r=>r.lesson_id as string)};
}

// Shared by the dispatcher and owner report so a reported fresh window means
// the same thing as a window the dispatcher can actually allocate.
export async function availableResearchDatasets(tx:Sql,botId:string,datasetIds:string[],limit=100) {
  return (await tx.query(`SELECT d.id FROM portfolio_datasets d JOIN evidence e ON e.id=d.evidence_id JOIN sources s ON s.id=e.source_id
    WHERE d.id=ANY($1::uuid[]) AND d.purpose='example-testing' AND e.status='verified' AND s.approved=true
    AND NOT EXISTS(SELECT 1 FROM (
      SELECT dataset_id FROM research_assignments WHERE bot_id=$2
      UNION SELECT dataset_id FROM portfolio_trials WHERE bot_id=$2
    ) used JOIN portfolio_datasets prior ON prior.id=used.dataset_id
    WHERE (prior.holdout->0->>'timestamp')<=(d.holdout-> -1->>'timestamp')
      AND (d.holdout->0->>'timestamp')<=(prior.holdout-> -1->>'timestamp'))
    ORDER BY d.holdout->0->>'timestamp',d.id LIMIT $3`,[datasetIds,botId,limit])).rows;
}
