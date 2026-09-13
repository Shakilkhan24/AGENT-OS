# Evaluation and productivity

Research and proposed evaluation design · accessed 2026-09-10

MINIMAL should measure accepted outcomes per human hour against the user's existing agent workflow. Treat 10×, 20× and 50× as hypotheses requiring evidence for a specified workflow, population, period, quality bar and resource budget. The studies below establish neither a universal slowdown nor a universal multiplier. The actual MINIMAL application has not been run; this document reports no product measurements.

The evidence ledger contains eight fetched primary URLs. The evaluation design that follows is a MINIMAL proposal.

| Primary evidence | Sample, setting and observation | Limits on interpretation |
| --- | --- | --- |
| [METR original report, July 10, 2025](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/), [original RCT paper](https://arxiv.org/abs/2507.09089) | February–June 2025: 16 experienced maintainers completed 246 randomized tasks in familiar mature repositories, mainly using Cursor with Claude 3.5/3.7. AI permission increased completion time by 19%; participants retrospectively believed it saved 20%. | A particular population, tool generation and workflow; it does not establish today's effect across developers. Self-reported benefit did not match measured time. |
| [METR update, February 24, 2026](https://metr.org/blog/2026-02-24-uplift-update/) | Follow-up begun August 2025: 57 developers, 143 repositories, 800+ tasks. Completion-time estimates were −18% for 10 returning developers, interval −38% to +9%; −4% for newcomers, interval −15% to +9%. | METR considers the magnitude unreliable: adopters and promising tasks select out, pay fell, completion differs by assignment, and concurrent agents complicate time accounting. Neither interval excludes no effect. The update weakens extrapolation from 2025 without validating a new headline multiplier. |
| [Cui et al., February 2025](https://economics.mit.edu/sites/default/files/inline-files/draft_copilot_experiments.pdf) | Three corporate randomized Copilot rollouts in 2022–2023, lasting 2–8 months; analytic sample 4,867 developers. Preferred pooled instrumental-variable estimate: 26.08% more weekly completed tasks among users, standard error 10.3 percentage points. | Code-completion assistance differs from agent management. Imperfect adoption required estimation adjustments; individual experiments were noisy. Task/PR counts and limited quality proxies do not directly measure review hours, long-term maintenance or MINIMAL's incremental value. |
| [SWE-bench original paper, 2023; revised 2024](https://arxiv.org/abs/2310.06770) | Introduced 2,294 issue-resolution problems drawn from 12 Python repositories, pairing issue descriptions with repository changes. | A useful bounded capability sample; its language/repository mix and issue-resolution task do not represent an entire working week. Benchmark resolution is not a measurement of developer productivity. |
| [SWE-bench evaluation guide](https://www.swebench.com/SWE-bench/guides/evaluation/) | The harness applies patches and runs repository tests in containers. Documentation separates resolved, unresolved, incomplete and error cases; cached results depend on run and instance IDs, requiring a new run ID for changed predictions. | A completed harness invocation does not imply a resolved issue. Cached success can describe an earlier patch. This is implementation guidance, not a productivity experiment. |
| [Anthropic evaluation guidance, January 9, 2026](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Distinguishes final environment state from an agent's account of success; recommends repeated trials and suitable executable, human or calibrated model graders. At-least-one success across attempts differs from success on every trial. | Provider engineering guidance, not a controlled productivity estimate. Model judging requires calibration; selecting a successful attempt can conceal inconsistent behavior and extra expense. |
| [Anthropic infrastructure study, February 5, 2026](https://www.anthropic.com/engineering/infrastructure-noise) | Six resource configurations with the same Claude model, harness and Terminal-Bench 2.0 tasks produced a six-percentage-point success spread. A SWE-bench experiment used 227 problems with ten samples each; fivefold RAM produced a 1.54-point increase. | Measures infrastructure sensitivity, not human speedup. Resource ceilings can change both failures and viable solution strategies. Other providers were not rigorously tested, so the magnitude is not universal. |

The proposed comparison asks what the workspace adds. A MINIMAL-versus-no-AI experiment would combine the agent's contribution with the application's contribution. Use a separate AI-versus-no-AI arm only when that distinct question matters.

1. Establish three conditions: the user's current terminal/provider workflow; the strongest supported native provider workflow, including available background work, worktrees and subagents; and MINIMAL using that same provider/model. Record unavailable capabilities on Linux/WSL. Match accounts, quota, tools, total concurrency and compute budgets; separately test expanded concurrency. Count observable native children as well as managed runs. Test each provider separately before pooling results.
2. Create 20 versioned fixtures, four in each family below. This is a starting proposal, not a powered sample. Each fixture records the base revision, acceptance rules, reference outcome, allowed scope, context inputs, environment image, hardware allocation and ceiling, timeout, attempt budget and grader version. Protect hidden checks and reference patches from agent retrieval. Pin the MINIMAL/provider builds, model identifier, settings and task manifest; preserve missing version information explicitly.
3. First check lifecycle contracts using a scripted provider. Later run three independent live trials per fixture/condition from clean state, distributed across times and days. Record every attempt and failure category. Publish first-attempt acceptance and acceptance within the fixed retry budget separately, with all retry costs. These repeats estimate system variability; they do not create additional independent human participants.
4. Observe 6–8 users after comparable onboarding, using different matched tasks and counterbalanced condition order to limit learning effects. Follow voluntary use for two weeks. Pre-register the task backlog and log refusals, exclusions, withdrawals and unfinished assignments. Interviews identify friction and demand; this pilot cannot establish population effects. Before confirmatory research, estimate variance and developer/repository clustering, specify a meaningful effect and quality margin, calculate sample size, and publish confidence intervals and missing-data sensitivity.

| Fixture family | Required outcome |
| --- | --- |
| Routine change | Fix a known bug or bounded feature; required checks pass and existing behavior survives. Include simple tasks where management overhead may dominate. |
| Context and handoff | Continue an unfamiliar repository task using a recorded handoff; preserve constraints, identify missing context and avoid cross-project leakage. |
| Parallel work and integration | Finish independent changes, then test their combined candidate; include a conflicting edit and a dependency that must wait. |
| Interruption and recovery | Inject GUI closure, runtime restart, WSL shutdown or lost acknowledgement after an action; reconcile identity, preserve artifacts and expose uncertain effects. |
| Recipe and review | Run a pinned routine; handle unavailable credentials/quota, changed configuration, failed verification and a stale reviewed candidate without false acceptance. |

Use opt-in local instrumentation with stable task, attempt, candidate and condition IDs. Record timestamps and human activity intervals; collect task stage labels without requiring screen recordings or raw prompt telemetry. Validate inferred activity against participant annotations. Overlapping agent runs must not multiply one person's working time.

| Metric | Operational definition |
| --- | --- |
| Acceptance rate | Accepted assigned tasks / all assigned tasks at a fixed horizon; publish rejection, abandonment, timeout and unknown counts. Acceptance requires the agreed outcome and review on the actual candidate tree. |
| Human effort | All participants' active minutes for setup, context preparation, prompting, monitoring, edits, review, integration and recovery, including unsuccessful attempts. Use the union of overlapping intervals per person. |
| Productivity multiplier | Compare accepted tasks / total human hours between conditions within the predeclared task mix. Count an integrated deliverable once; splitting it into child tasks must not inflate output. Publish absolute counts and effort alongside ratios. |
| Elapsed time | Assignment to accepted result, including queues, waiting and review. Retain unfinished tasks as censored observations at the declared horizon; report their number. |
| Quality | Acceptance-criteria violations and severity-graded defects/reopens within a proposed 14-day follow-up, assessed with the same rubric. Report denominators and review disagreement. |
| Review and recovery | Human minutes and interventions spent checking, correcting, merging, restoring context and recovering failures; these are subsets of total effort. |
| Cost per accepted task | All attempts' provider and compute costs / accepted tasks. Show subscription allocation separately; unavailable charges remain unknown. Include child runs and operator recovery effort in separate cash/time totals. |

A proposed internal advancement rule is at least 20% fewer human minutes per accepted task against the native baseline, no observed deterioration in acceptance or defect outcomes, and costs within a declared budget. These are illustrative product choices, not research-derived thresholds or proof of quality equivalence. Use the pilot to decide whether a larger trial is worthwhile. Public multiplier claims require the confirmatory design and uncertainty to support their precise scope.

Release acceptance must additionally demonstrate:

- A changed candidate cannot inherit an earlier check or reviewer acceptance; combined changes require fresh evidence.
- Reopening the GUI or losing a dispatch acknowledgement must not trigger implicit replay; unknown external effects remain unresolved until reconciled.
- Failed, skipped or unobserved required checks prevent successful acceptance; missing usage never becomes zero cost.
- Shared concurrency limits and writer ownership hold during nested native/managed work; capacity failures remain visible.
- Reports include failures, all attempts, resource settings, uncertainty and the native baseline. A successful demo or agent count cannot satisfy these tests.

Zero violations in these injected cases is a release gate, not evidence of zero real-world incident risk. Expand the fixture bank from observed failures and reassess the comparison when provider behavior or task mix materially changes.

