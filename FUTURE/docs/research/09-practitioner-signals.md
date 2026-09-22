# Practitioner workflows: evidence and product tests

Research checked **2026-09-10**. The clearest opportunity for MINIMAL is reducing the human work needed to start, resume, verify, and clean up agent tasks. These sources provide concrete workflow examples; they do not establish market size, typical productivity gains, or an optimal number of agents.

## Source evidence and access quality

Dates below are publication dates unless qualified. “Full text” describes accessible original writing; video demonstrations embedded in articles were not watched. No YouTube transcript was obtained. Public access was used without login or access-control bypass.

| Original source | Date and access | Observed idea and confidence |
| --- | --- | --- |
| OpenAI, [Introducing the Codex app on YouTube](https://www.youtube.com/watch?v=HFM3se4lNiw), linked from the [official launch entry](https://learn.chatgpt.com/docs/whats-new#the-codex-app-launches-on-macos) | Exact upload date unavailable. Official entry groups the launch under **2026-02-02–06**. YouTube returned its title and footer; the official embedded URL returned a cache miss. **Partial metadata only.** | Confirms an original creator video exists. No claims about demonstrated interactions, reliability, or user preferences are derived from it. Confidence: metadata only. |
| Boris Cherny, original [workflow thread](https://x.com/bcherny/status/2007179832300581177) and [worktree post](https://x.com/bcherny/status/2025007393290272904) on X | Both direct opens returned **403 Forbidden**. Exact publication dates were not verified from the originals; secondary discovery results place them in January/February 2026. **Blocked.** | Relevant creator leads, excluded from behavioral evidence. Reposts and search snippets were not substituted for the original posts. No workflow details or agent counts attributed to Cherny here. |
| Addy Osmani, [CodeCon announcement on LinkedIn](https://www.linkedin.com/posts/addyosmani_ai-programming-softwareengineering-activity-7443182694102077440-kVUa) | **Full main-post text** publicly readable, despite sign-in furniture. LinkedIn shows “5mo Edited”; the linked author's article dates the talk **2026-03-26**. | Original post promotes task decomposition, quality gates, and verification as orchestration concerns. Useful practitioner framing, not adoption research. Confidence: high attribution; limited evidence of outcomes. Comments were not treated as a representative sample. |
| Addy Osmani, [The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/) | **2026-03-26; full article text.** Same talk as the LinkedIn post, not independent corroboration. | Describes scoped assignments, dependency handoffs, review, and bounded iterative work. Retain these as candidate patterns. Numerical throughput claims and broad claims about conflict avoidance are not adopted as guarantees. Confidence: medium for design advice. |
| Simon Willison, [Embracing the parallel coding agent lifestyle](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/) | **2025-10-05; full article text.** Historical workflow, not a claim about today's provider capabilities. | Reports parallel research, explanations, and small maintenance tasks while reviewing one substantial change at a time. Detailed specifications reduce his review burden. He used separate checkouts when isolation was needed. Confidence: high as personal experience; unknown generality. |
| Mitchell Hashimoto, [My AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey) | **2026-02-05; full article text.** | Reports early rework outweighing benefits, then gains from smaller tasks and verification tools. Describes one background coding agent, suppressed desktop notifications, and end-of-day research or triage reports. Confidence: high as first-person experience; no controlled productivity estimate. |
| Mario Zechner, [What I learned building an opinionated and minimal coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) | **2025-11-30; full article text**, including context-handoff and agent-interface sections. | Wants inspectable context, documented sessions, and alternate interfaces. Explains provider-specific tool/thinking representations make cross-provider handoff best effort. Describes event emission and headless interfaces. Confidence: strong engineering rationale from the implementer; historical feature details require current API verification. |
| Mario Zechner, [Year in Review 2025](https://mariozechner.at/posts/2025-12-22-year-in-review-2025/) | **2025-12-22; full article accessible; VibeTunnel and workflow sections read.** | Recalls building VibeTunnel with peers to control agents remotely. Their fast prototype worked, but he judged the combined architecture difficult to maintain. He also describes abandoning voice input for coding because precise paths and context were awkward. Confidence: personal retrospective, not a current product audit. |
| Wilson Lin, Cursor engineering, [Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents) | **2026-01-14; full article text.** | Reports coordination-file locks being held or bypassed, ownerless hard tasks, drift, and a separate integrator becoming a bottleneck. Describes clearer roles and periodic fresh starts helping their experiments. Confidence: primary engineering account; no independent reproduction or guarantee of production correctness. |

The YouTube and X checks satisfy platform discovery only. They contribute no unseen evidence. Seven readable practitioner/engineering entries remain, with overlap in authors and one duplicated talk. Popularity, comment counts, and promotional “levels” are not demand measurements.

## Cross-checks that constrain the architecture

Git's [worktree documentation](https://git-scm.com/docs/git-worktree), accessed 2026-09-10, confirms separate working trees but shared refs and default repository configuration. Its removal behavior protects dirty trees. **Inference for MINIMAL:** model shared repository ownership, integration, and recoverable cleanup explicitly; a worktree must not be advertised as a complete sandbox or a guarantee against merge conflicts.

The pi [handoff discussion](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) supports distinguishing a transferred task brief from native conversation resume. MINIMAL should expose the available operation and retain the original session reference. This design inference provides no evidence that Codex and Claude conversations can be translated losslessly.

Cursor's [engineering account](https://cursor.com/blog/scaling-agents) argues for testing explicit ownership and bounded execution before adding coordination layers. This inference does not endorse reproducing its experimental shared-branch setup.

## Four hypotheses to test

These are proposed experiments, not completed studies. Thresholds should be chosen before testing. Keep representative tasks, comparable model settings, and a record of failures; report small samples as small samples.

1. **A review queue improves useful concurrency.** Compare a terminal-tab workflow with a task view showing purpose, scope, artifacts, checks, and “needs my input.” Try one, two, and four active tasks with participants who already use installed agents. Measure human review minutes, interrupted focus periods, abandoned outputs, and accepted changes. Increase the default concurrency only if accepted work improves without unacceptable review delay.

2. **Visible handoff packages reduce restart work.** Give an interrupted task to a fresh session using either the user's current recovery method or a package containing goal, constraints, decisions, file references, revision, commands run, unresolved issues, and artifact links. Ask the user to correct the package before transfer. Measure repeated exploration, lost requirements, time to the next accepted change, and false assumptions after switching provider. A fluent summary is insufficient evidence of continuity.

3. **Worktree lifecycle management saves more time than it adds.** Compare manual setup/cleanup with a proposed create–run–review–retain/remove flow. Include dirty work, interrupted setup, conflicting edits, and a development service using an occupied port. Measure active setup minutes, failed launches, recovery effort, disk left behind, and whether every unmerged or untracked change remains recoverable. Keep this experiment independent of model-generated task decomposition.

4. **Bounded automation earns repeat use through inspectable results.** Pilot a user-chosen research or maintenance routine with an explicit deadline, maximum attempts, evidence requirements, and a morning results inbox. Measure the fraction of outputs actually used, correction time, missed schedules, repeated failures, and voluntary reuse. Compare against launching the same task manually. Expand scheduling only after users can reliably explain what ran, why it stopped, and what remains unresolved.

## Failure anecdotes and roadmap consequences

The source table contains failures at three different levels: individual learning costs, an overgrown prototype, and coordination failures in large experiments. They show plausible hazards, not how often those hazards occur. None supplies a failure rate for MINIMAL.

Promote **task identity, review evidence, interruption recovery, and restrained notifications** into the first agent-aware milestone. Preserve raw terminal access while adding a small amount of explicit task state. Let users choose quiet check-ins or alerts for genuinely blocked work.

Next, make **context packaging and worktree lifecycle** visible and reversible. Record where instructions and artifacts came from and which session/revision they describe. Let the user retain, correct, or discard proposed durable knowledge. Keep provider-native resume separate from a fresh task briefing in the product language.

Then trial **bounded templates and schedules** with a results inbox, failure history, and a clear stop control. Establish evidence that they save the intended user's time before investing in dynamic delegation, a model router, a remote-control surface, or an extension marketplace.

Success should be measured as useful work accepted per unit of human attention, with provider cost and recovery effort visible where available. The present evidence supports investigating that proposition; interviews and repeated task trials must determine whether users choose MINIMAL for it.
