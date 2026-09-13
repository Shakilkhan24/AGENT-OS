# 12. Commercial positioning and paid-product experiments

Research date: 2026-09-10. Seven fetched primary sources, plus the existing provider research. This is a proposal: no interviews, pilots, purchases, revenue measurements, or license clearance were conducted. Advertised packaging establishes alternatives; it does not establish customer demand.

## Recommendation and initial customer

Test MINIMAL as a specialist workspace for developers whose recurring problem is recovering and reviewing agent work across existing Linux/WSL projects. The candidate paid outcome is less human time reconstructing context, identifying the tested result, and restarting interrupted workflows.

The initial buyer hypothesis is an independent developer, consultant, or technical lead who already pays for Codex/Claude, uses several repositories each week, and can identify recent interruption or review costs. Start with one supported Linux distribution/WSL configuration and personal workspaces. A buyer requiring enterprise procurement, hosted execution, or a full IDE is outside this first cohort.

Charge, experimentally, for maintained recovery/review workflows, versioned recipes, compatibility updates, and bounded support. Later candidates are automation on customer-owned hosts and team onboarding. Provider inference remains separately purchased by the user. Provider breadth and terminal counts are weak reasons to add another subscription.

## Competitive pressure

| Observed offer | Implication for MINIMAL — hypothesis |
| --- | --- |
| Superset advertises a free local desktop/CLI tier; Pro adds remote access and integrations; Enterprise adds organizational controls and support. [Pricing](https://superset.sh/pricing) | A paid local offer needs a demonstrated workflow advantage. Remote/team tiers are already familiar packaging. |
| Emdash advertises a free macOS/Windows/Linux app with parallel work, schedules, review, reusable resources, and SSH workflows. [Product page](https://emdash.com/) | Linux support, scheduling, and templates alone do not establish differentiation. Compare directly with Emdash. |
| Conductor packages local Mac work as free and cloud workspaces, collaboration, and API access into paid plans. Its pricing FAQ anticipates future compute charges. [Pricing](https://www.conductor.build/pricing) | Cloud convenience is a competing purchase. Current inclusion of compute is not a durable pricing benchmark. |

No numerical competitor prices are proposed as MINIMAL's price. These are observed package boundaries on the research date, not promises of future availability.

One counterexample deserves attention: Bloop's founder reported on 2026-04-10 that Vibe Kanban had predominantly free users and no business model the company wanted to pursue. Its shutdown plan included export and continued local operation. This is one founder's account, not evidence that the entire category is unviable. [Shutdown announcement](https://vibekanban.com/blog/shutdown)

The defensibility hypothesis is accumulated compatibility knowledge, reliable recovery, useful review evidence, and repeat customer workflows. A longer feature list is readily copied. Validate whether users value those operational qualities enough to pay.

## Three experiment packages

All thresholds below are hypothetical decision rules, not industry benchmarks. Prototype discovery comes first; behavioral and payment checks require a later working pilot. Set a concrete price, included support, billing cadence, and cancellation terms before enrollment. Keep the quote fixed within each cohort; evaluate prices above the measured cost floor.

| Package and scope | Proposed evidence and go/no-go rule |
| --- | --- |
| **Solo recovery and review.** Per-person paid maintenance: task history, explicit handoffs, evidence-linked reviews, tested recovery, updates, and bounded support. Four-week pilot with 12 qualifying users. | Go to another cohort if at least 8 use it in both final weeks, 4 purchase continuation at the quoted price, and median human recovery/review time falls at least 25% against each user's baseline without worse accepted-result quality. Any silent lost candidate or unintended replay blocks release. Below the behavioral/payment thresholds: narrow or stop the offer. |
| **Owned-host routines.** Per-operator automation add-on covering one registered customer-owned host: recipe rehearsal, versioned schedules, run status, and reviewable outputs. Four-week pilot with 8 operators. | Go if 5 independently repeat at least 3 useful routines, 3 purchase continuation, and measured support projects below one staff-hour/operator/month while remaining profitable. Test offline hosts and missed schedules. If users mainly need managed compute, or support exceeds the quote's allowance, stop this package and reassess its scope. |
| **Small-team adoption.** Fixed-fee six-week onboarding package for 4 teams of 3–5 people: a supported setup, shared recipe versions, review conventions, and migration help; maintenance quoted separately. | Go if 2 teams buy maintenance, each has at least 2 people using the workflow weekly, and onboarding/support fits the quoted delivery budget. Require a repeatable installation and export drill without the founder operating every session. If customization dominates or a single champion does all the work, treat it as consulting rather than a scalable seat product. |

Compare equivalent tasks with native CLI plus tmux and the closest accessible competitor. Count human setup/review/recovery time, accepted outcomes, unwanted retries, and assistance; report dropouts. Small cohorts provide directional evidence only. Compliments, waitlists, downloads, and nonbinding purchase intent cannot substitute for paid continuation.

## Cost model and local versus hosted economics

Use one currency and monthly equivalents for all inputs:

    operating result ≈ N_paid × P × (1 − f)
                       − F − N_active × c_variable − C_acquisition

    price floor = (F + N_active × c_variable + C_acquisition)
                  / (N_paid × (1 − f))

P is receipts per paying user before payment/refund leakage f and excluding pass-through taxes. F covers allocated engineering, release qualification, documentation, and administration. N_active includes free users who incur costs. Variable cost includes distribution, backend services, and support; estimate support as tickets/user/month × handling hours × loaded staff cost/hour. Include amortized signing/service fees and measure onboarding separately. The formula describes a planning floor, not demonstrated profitability.

User-owned provider subscriptions/API usage and customer-owned host bills are excluded from MINIMAL revenue and costs. They still affect the customer's total willingness to pay. Track acquisition cost, paid retention, and support by cohort; a positive month does not prove sustainable lifetime economics.

Local execution avoids buying customers' runtime capacity but creates installation, environment, and compatibility work. Optional sync would add storage, credential/data handling, availability, and incident costs.

Hosted execution adds billable host-hours, persistent storage, egress, backups, idle capacity, control-plane operations, and on-call/abuse handling. Model contracted rates and measured utilization separately; do not count reserved and consumed capacity twice. Quote explicit allowances or metered compute only after measurement. An unlimited bundle is not supported by this research.

## Packaging and support are part of the offer

Electron's built-in autoUpdater supports Windows/macOS and directs Linux applications toward distribution package managers. Its macOS update path requires signing. Therefore, one update mechanism cannot be assumed across MINIMAL's proposed environments. [Electron platform notices](https://www.electronjs.org/docs/latest/api/auto-updater)

Budget packaged installation/upgrade tests, provider-version qualification, Linux/WSL filesystem variants, migration backups, recovery diagnostics, download hosting, and an emergency update path. Publish supported combinations and support response expectations. Keep the runtime's active work discoverable across GUI upgrades; validate schema compatibility before promising rollback.

Test annual paid updates/support against monthly maintenance once repeat value is observed. Any perpetual license proposal must distinguish continued use from future compatibility work. A local product should tolerate a temporary billing-service outage under a documented grace policy.

## Distribution, license, and provider decision gates

These are documented differences and concrete review questions, not a legal determination.

| Source | Documented boundary |
| --- | --- |
| [Superset LICENSE.md — ELv2](https://github.com/superset-sh/superset/blob/main/LICENSE.md) | Permits use, modification, and distribution subject to conditions. Restricts offering substantial functionality as a hosted/managed service, circumvention of license-key features, and removal of notices. Copies need the terms; modified copies need change notices. |
| [Emdash LICENSE.md — Apache-2.0](https://github.com/generalaction/emdash/blob/main/LICENSE.md) | Permits modification and redistribution subject to license/change notices and applicable attribution/NOTICE requirements. Includes a conditional patent grant. It does not generally grant trademark rights. |

Before selecting reused code or bundled components, produce a versioned artifact inventory for counsel: MINIMAL-authored code, competitor-derived code, provider binaries/SDKs, plugins, and dependencies. Identify each license and the exact distribution/hosting model; a top-level repository license does not settle every bundled component. ELv2-derived hosted functionality needs a specific assessment before that business model is chosen.

For provider confirmation, supply the actual local or hosted architecture, authentication path, account owner, credential custody, and billing flow. Resolve the distinct CLI/SDK conditions recorded in [Codex research](01-codex.md) and [Claude commercial gate](02-claude-code.md#subscription-and-commercial-product-gate). Do not infer MINIMAL's rights from another vendor's subscription integration. Recheck when introducing hosted/shared machines or changing account handling.

Before public branding, have counsel check the MINIMAL name and proposed provider-name/logo usage; confirm provider branding conditions where necessary. Before distribution, review the actual installer and notices. These gates attach to concrete packaging choices, not to an assumption that a paid wrapper is automatically allowed or forbidden.

## Portability expectation

Keep project files, already-created results, essential recovery, and export accessible after cancellation. Export readable task/recipe manifests, handoffs, artifact references, review evidence, and schema versions; exclude credentials. Document what cannot transfer, including provider-owned hidden state. Demonstrate import on a clean supported machine and continued access if MINIMAL's service disappears.

Charge for continuing maintenance and useful execution capabilities while making departure practical. This is a proposed product commitment and a test of buyer trust, not a claim about existing implementation.

## Source ledger

All seven sources above were fetched on 2026-09-10. Superset: Pricing tier cards; LICENSE.md limitations/notices. Emdash: product workflow/FAQ; LICENSE.md sections 2–4 and 6. Conductor: Pricing plans/compute FAQ. Bloop: founder shutdown notice dated 2026-04-10. Electron: autoUpdater platform notices. Provider-specific evidence remains in the linked provider notes to avoid duplicating its terms analysis.
