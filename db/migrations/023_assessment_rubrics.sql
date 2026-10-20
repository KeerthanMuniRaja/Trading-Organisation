-- Method-based knowledge assessments: the model chooses computations and rules; the backend derives the numbers.
ALTER TABLE knowledge_assessments ADD COLUMN rubric text NOT NULL DEFAULT 'research-basics-v1'
  CHECK (rubric IN ('research-basics-v1', 'research-methods-v1'));
ALTER TABLE learning_workflows ADD COLUMN assessment_rubric text NOT NULL DEFAULT 'research-basics-v1'
  CHECK (assessment_rubric IN ('research-basics-v1', 'research-methods-v1'));
