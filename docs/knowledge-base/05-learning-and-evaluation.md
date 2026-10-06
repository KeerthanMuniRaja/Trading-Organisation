# Learning and Evaluation

> [Current implementation, validation and limits](../current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

[Home](README.md) · [Governance](06-governance-and-capital.md) · [Experiment template](templates/experiment-record.md)

## What learning means

The organisation can improve through several distinct mechanisms:

| Mechanism | What changes | Evidence required |
|---|---|---|
| Memory update | Retrieved facts, lessons, and applicability conditions. | Provenance, contradiction handling, and usefulness on later tasks. |
| Workflow or skill update | Instructions, tool sequences, or procedures. | Comparison with the previous workflow and failure tests. |
| Strategy selection | Which qualified candidate receives a task or allocation. | Role-specific performance and regime suitability. |
| Parameter optimisation | Strategy settings or portfolio assumptions. | Unseen evaluation and accounting for all attempted variants. |
| Model training/fine-tuning | Learned numerical parameters. | Data lineage, training cutoff, reproducibility, and independent evaluation. |
| Architecture/plugin change | Available components and interfaces. | Integration, permission, compatibility, and operational tests. |

A saved lesson does not automatically retrain a foundation model. None of these mechanisms proves improvement without evaluation.

## Proposed education lifecycle

1. **School:** source handling, tool use, market mechanics, uncertainty, and constitution.
2. **Specialisation:** forecasting, research, portfolio construction, execution, risk, or investigations.
3. **Examinations:** unseen data, realistic costs, changing conditions, and failure scenarios.
4. **Probation:** shadow decisions or paper operation with no assumed equivalence to live fills.
5. **Qualification:** a defined role, model/configuration version, market scope, and permission level.
6. **Continuing review:** performance decay, source changes, drift, operational reliability, and material updates.
7. **Requalification or retirement:** retrain, restrict, roll back, or stop a version when evidence warrants it.

A live pilot would be a separately authorised later stage, not an automatic consequence of documenting this lifecycle.

## Independent evaluation

The candidate cannot modify its own evaluator, examination thresholds, capital permission, or protected test data. Repeated tuning against an evaluation set must be recorded and may require a new untouched evaluation period.

Use appropriate chronological or walk-forward tests, leakage checks, baseline comparisons, realistic execution assumptions, and stress scenarios. Record all trials, including abandoned and failed attempts. For pretrained models, document known training overlap or uncertainty about it.

Execution examinations must cover duplicate events, delayed acknowledgements, partial fills, stale data, disconnections, and reconciliation. Risk examination must include several bots requesting the same capital concurrently.

Numerical thresholds, minimum sample sizes, evaluation windows, and approved baselines remain open decisions.

## Rewards

| Role | Appropriate evidence |
|---|---|
| Research | Reproducibility, useful rejected hypotheses, accurate uncertainty, and economical use of resources. |
| Forecasting | Out-of-sample predictive quality and calibration where probabilities are supplied. |
| Portfolio | Net results, diversification, constraint compliance, and robustness. |
| Execution | Fill quality, controlled costs, accurate state, and reliable recovery. |
| Risk | Correct interventions and justified permissions, including false-block analysis. |
| Investigation | Supported causal findings and remedies that pass tests. |
| Source verification | Timely detection of incorrect, stale, duplicated, or misleading evidence. |

Rewards can change selection priority, research compute, or bounded responsibility. They do not require feelings of motivation. Administrative authority and bank access are never rewards.

Do not reward raw profit alone. A profitable violation remains a violation; a well-supported decision can still lose money. Reward honest reporting and useful disagreement so agents are not incentivised to hide failures or agree with a dominant narrative.

## Team effects and version control

Assess contribution to the organisation, not only isolated scores. Correlated bots may add little diversity, and an accurate model may still worsen overall outcomes through cost or latency.

Keep the previous qualified version available. Evaluate proposed replacements as challengers, record promotion evidence, monitor after promotion, and define rollback conditions.

The original system may use existing models. Our eventual custom models, memory, and processes can become distinctive; exclusivity, privacy, and performance must each be addressed separately.

## Graduation and distinct contribution

School builds common competence; college develops a speciality. A graduate must show a contribution that the current team lacks or cannot provide adequately. The [graduation review](templates/graduation-review.md) records knowledge inherited from existing bots, independent examination results, overlap with peers, and approved scope.

Copying an existing bot's outputs or renaming the same strategy does not count as novelty. Reusing reliable tools and verified lessons is encouraged. Incremental value must be tested against the existing team, including similarity of errors and dependence on shared evidence.

## Fitness, cooperation, and retirement

"Fittest survives" means selection by useful, reliable, role-appropriate performance under the constitution. It does not mean the highest recent profit always wins.

Use sufficient evidence, relevant market conditions, and a role-specific baseline before deciding a bot is unfit. Include data quality, uncertainty, costs, reliability, source dependence, and team contribution. Do not punish independent reviewers for justified dissent or remove support roles because their work has no direct trading revenue.

Possible outcomes are promotion, continued service, retraining, narrower scope, reserve status, or retirement. Before active deletion, capture verified lessons, negative results, failure conditions, and reproducible evidence. Archive uncertain material as uncertain; it must not become a shared rule merely because its author retires.

## Hackathon outputs and model changes

Periodic hackathons produce competing hypotheses, new bot proposals, reusable skills, and challenger versions of existing models or workflows. Winners still pass independent evaluation. A contest prize is not permission to deploy, retrain on protected test data, or alter governing rules.

See [R&D lifecycle](11-research-development-and-bot-lifecycle.md), [hackathon record](templates/hackathon-record.md), and [knowledge transfer](templates/knowledge-transfer-and-retirement.md).

<!-- documentation-navigation -->
[Documentation index](../documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
