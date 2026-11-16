# 003 Execution

This document follows an accepted Ticket through execution, delivery and recovery. It builds on [001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md).

## Ticket stages

Each open Ticket has one stage, determined by what it is waiting for. Read the table from top to bottom; the first matching row wins.

| Stage | Condition | Panel label |
| --- | --- | --- |
| person / delivery | Delivering an Input to the Executor Session failed; it is retried after 2 seconds, then after a delay that doubles up to a minute, and a success, a new Assignment or the Ticket's end clears it | Input undelivered |
| person / answer | It has an Attention | Awaiting answer |
| person / review | The latest Report is `ready` | Awaiting review |
| person / blocked, failed | The latest Report is `blocked` or `failed`, and no person's message reached the Ticket since | Blocked · Failed |
| working / queued | No Assignment, or a pending one | Queued |
| idle | The latest Report is `waiting`, or the Assignment ended | Waiting for a Trigger |
| working | Everything else | Working |

A `person` stage means the Ticket cannot continue without human input. A new human message releases a `blocked` or `failed` Ticket to its Executor, so it moves to the next matching stage, usually `working`.

An `idle` Ticket has finished its turn without an outstanding question. A Trigger on a subscribed Thread can continue it.

## The Executor

Each Ticket gets an Executor Session named `worker-<ticket id>` and a directory named after the Ticket's short name. Directories are created under the configured execution root, which defaults to `<stateDir>/work`.

Executor Sessions run commands without approval as the operator's OS user. Their `dsh-superagent-worker` preset contains the tools needed for work and moves foreground shell commands to background jobs after 5 seconds. This lets a worker receive new messages at the next step instead of waiting for a long command to finish.

The main Session uses `dsh-superagent-router`, with the same 5-second shell and job-wait limits and a smaller tool set for routing. Sessions retain the preset selected at creation. Worker subagents use DeepSeek Harness's `standard` preset.

### Background work and worker slots

When a turn ends with shell jobs or subagents still running, the Ticket keeps its worker slot and stays working. It is not reported as waiting, and the main Session receives no waiting report. A completed job or subagent wakes the Executor with its result in the same slot. Once a turn ends with no background work, the Executor reports waiting normally.

After each turn, background work has at most 30 minutes to finish. At that limit, shell jobs are killed and the Ticket is reported waiting. The report includes the Executor's last words and which jobs were killed or subagents remain active. Subagents are allowed to continue. The Executor reads killed-job results on its next turn.

A handoff to a person frees the slot immediately and leaves the Report in effect. This applies after a `ready` Report or a question, unless another Input arrived since, and after any `blocked` or `failed` Report.

At handoff, subagents stop. Shell jobs, such as a server offered for review, may continue until the Assignment ends. They hold no slot and are exempt from the 30-minute limit, including after later turns. Their completion does not wake the Executor; it reads the results on its next turn.

A person can also start a turn by writing directly in the Executor Session. Its background work follows the same rules.

When an Assignment ends, its shell jobs are killed without waking the Session. Its subagents are released, and any completion turns they wake are dropped. The replacement Assignment and its waiting Inputs start after that shutdown finishes.

Stopping or restarting the plugin inside the DeepSeek Harness process uses the same shutdown path. Inputs not yet taken into Session history are retained. Shutdown waits up to 10 seconds for each worker's background work; a process restart ends that work outright. An Assignment interrupted while busy restarts with a recovery note.

Worker subagents, including nested ones, use DeepSeek Harness's `standard` preset with the worker's permissions. They retain only the worker's allowed work tools, and lose those tools when the Ticket ends. Under `standard`, a shell command moves to the background after 60 seconds. A subagent's jobs are killed when it ends.

### Intake progress and evidence reuse

When a worker uses `todo_write`, fixed work instructions require a real phase update before entering the next phase. TAPD intake returns `readTiming` for detail and comments separately and explicitly asks for a keyword summary before completing intake. These timings are not task duration: the Host does not automatically mark todos completed, and failed reads remain incomplete. Model compliance still needs live-run validation.

`orchestrator_tapd_item` reads one latest-comment page using `order=modified desc` and the requested limit (0–50, default 20), instead of fetching the whole comment history and cutting its oldest entries. Incremental Source polling keeps its existing ascending pagination. The tool checks the returned item type/workspace/ID, returns full requested content and does not cache results or conceal a read failure.

Intake also returns configuration-only `p4Readiness` (no server/login probe) and at most three stored `priorDelivery` CL references. Candidates are limited to the last 100 earlier tickets from the same human/source, then matched to the same receiving conversation and exact TAPD item. Only stored reviews or owned P4 threads count; a rejected report's required-CL intent is not delivery evidence. No old ticket title, directory, assignment, transcript or read pointer is exposed. Hints are not exhaustive, not current server state and never transfer CL ownership, authorize unshelving or bypass review. Missing P4 configuration should be reported before P4-dependent work; it does not block otherwise authorized local analysis. No automatic model/effort switching or real P4 configuration changes are made.

### Worker PTC pilot and tool diagnostics

Execution settings provides `workerPtc` and `toolTrace`, both off by default and panel-only. PTC is frozen in a new single-worker ticket's Execution metadata; existing tickets, the router, desk and team steps do not switch. Turning it off affects future tickets, not an existing PTC worker. The worker preset provides the official Node PTC runtime (per-call process, 30s max, 256KiB output, 128MiB V8 heap, 1MiB control messages, 4 pending bindings), but native workers do not execute programs. The executor is dynamically imported from the Host entry, not bundled from the alpha development toolchain.

PTC workers use `workspace-write`; full-access and program permission escalation are refused. Each `run_code` must explicitly provide `timeoutMs` no greater than 30000. The allowance is 64 attempts per minute of requested timeout (32 at 30s, failed calls included), with at most 4 concurrency-safe SDK subcalls and one outer call at a time. Every SDK subcall uses the official guarded invocation pipeline, including cancellation and the ticket's end guard. Configured P4 is not supported by this pilot: raw Node file/network/process I/O does not pass tool guards, and file confinement does not isolate network or process visibility. File enforcement may be partial on Windows; this is not a new security boundary. Missing runtime or policy fails visibly without silently running native tools. Programs should batch reads and filter intermediate results, not repeatedly poll or retry writes; successful side effects are not rolled back when a program fails.

Tool metadata tracing observes shared `tools/pre-execute` and `tools/result` events, covering inherited native tools and PTC inner/outer calls. `GET tools/trace` is a manual paged query. Stored rows contain session/role/ticket/step, call/root/parent IDs, duration, UTF-8 JSON byte sizes, keyed HMAC parameter fingerprints and error/cancel flags. Raw arguments, scripts, outputs, error bodies and the HMAC key are not returned or stored in trace rows. Existing DSH session logs are unchanged. Rows are retained at most 7 days/10,000 IDs; oversized input metrics and missing pre-execute timings are unknown rather than guessed. Repeated identical inputs in the displayed sample are an investigation signal, not proof that a resource is unchanged or a call redundant. No tool-result cache or write deduplication is introduced by this pilot.

### Preparing a Ticket directory

Before the first Assignment, if the Ticket directory does not exist, the prepare command runs once with `sh` in the execution root. It has ten minutes to finish. Without a prepare command, the worker starts in an empty directory.

A failed command fails the Ticket and records its output. Preparation records `preparing` before side effects and `ready` only after directory and Git-configuration checks succeed. A retry can run preparation again if a failed command left no directory; non-empty residue is preserved and blocks execution until the operator checks it and moves it aside after backup. Interrupted preparation remains uncertain and requires operator review of the directory and preparation record. A validation-only failure can be rechecked after repair without rerunning the prepare command. Legacy directories without a preparation record are adopted by non-destructive verification, not by rerunning prepare. Previously ready directories that disappear must be restored; neither retries nor worker recreation replace them with empty directories.

The execution root comes from operator settings, not incoming Trigger metadata: TAPD `workspace_id` is an item/project identity, never a filesystem path. The local `superagent` Source may set its own absolute root for per-ticket subdirectories. This is not an existing project checkout or a security sandbox. An empty prepare command still supports generic directory tasks; obtaining and validating a Git/P4/UE checkout remains the operator's responsibility. A typical prepare command uses `git worktree` to create a checkout. A pull request belongs to the Ticket when its branch's last path segment matches the Ticket's short name.

### Workspace inventory and cleanup preview

Execution settings has a manual **Inspect workspaces** action, backed by `GET executor/workspaces?offset=0&limit=10`. It is not polled and does not prepare, archive or delete directories. Pages include each ticket's stored path, preparation state, per-row check time, directory existence, logical file bytes and retention blockers. The size excludes shared Git objects; links, errors and partial scans report an unknown size, not zero. It lists ticket-bound paths only, not orphan directories.

The preview retains live or recently ended tickets (a 14-day preview window, not automatic cleanup), pending inputs, open follows, all team/P4 histories, unknown preparation/activity, unmanaged or shared directories, dirty/untracked/ignored files, dirty submodules and unpushed commits. Upstream checks use local cached remote refs; no network request proves that a backup still exists. A blocker-free managed worktree is only a **manual review** candidate, never deletion authorization. Refresh and verify backups before any later removal.

Directory enumeration is streaming, with a cooperative 2-second/2,000-entry/depth-12 budget per row and request cancellation between operations. Already pending filesystem syscalls cannot be forcibly cancelled. Static symbolic links and linked ancestors are rejected; directory identity is rechecked on opening. This is a best-effort preview, not an atomic filesystem snapshot or an anti-race security boundary. Shared existing P4/UE projects and automatic GC remain disabled until lifecycle-wide leases and recovery semantics are implemented.

### Concurrency

A Ticket holds a worker slot from the start of a launch, including preparation, or from the delivery that wakes its idle Executor. It also holds the slot throughout an active turn.

The configured concurrency limit applies to these slots, with one extra slot for a person's message or a status request. Such a wake can use the extra slot when normal slots are full, and takes the next free slot before a new launch. New work therefore cannot prevent a person from continuing an existing Ticket.

Other Inputs, such as CI results, wait for a normal slot. A launch waits in `working / queued` until a slot is free. Launches run concurrently, so a slow prepare command delays only its own Ticket.

### Execution variables

The prepare command and Executor instructions receive the same execution variables. The command reads environment variables; the Executor reads their values and descriptions in its prompt. None contains credentials.

| Variable | Registered by | Value |
| --- | --- | --- |
| `DSH_SUPERAGENT_DIR`, `DSH_SUPERAGENT_NAME`, `DSH_SUPERAGENT_TICKET` | Executor | The Ticket's directory, short name and id |
| `DSH_SUPERAGENT_BLOCKED_COMMANDS` | Executor | Commands the Executor may not run |
| `DSH_SUPERAGENT_GITHUB_REPOSITORY` | GitHub | The repository the Source watches, `owner/name` |
| `DSH_SUPERAGENT_GITHUB_ACCOUNT`, `DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL` | GitHub | The agent account and its commit email |
| `DSH_SUPERAGENT_GITHUB_NUMBER`, `DSH_SUPERAGENT_GITHUB_PR_HEAD` | GitHub | The Issue or pull request that started the Ticket, and its head ref when it is a pull request |
| `DSH_SUPERAGENT_FEISHU_BOT`, `DSH_SUPERAGENT_FEISHU_CHAT` | Feishu | The bot, and the chat that started the Ticket |

Ticket-specific values come from its directory and originating Trigger. Other values come from the current deployment settings. Only the panel can change execution environment settings; text sent to the main Session cannot change the configured shell command.

Workers reach GitHub through the agent account's `gh` and Feishu through the bot's `lark-cli`. Blocked commands fail when invoked by name.

These wrappers and directories establish defaults, not a security boundary. A worker can still execute a program by absolute path.

## Merging

Auto-merge is governed by the **Delivery requirements** prompt. The host has no merge-specific decision logic.

By default, the Executor never enables auto-merge as the agent account: GitHub attributes the merge to whoever enabled it. Delivery requirements must name another account's CLI for merging. Without one, people merge the pull request.

The default instructions allow auto-merge only for a pull request opened for the Ticket, when it is ready, the required approvals cover the head commit, and additions plus deletions total fewer than 200 lines. Before pushing another revision, the Executor withdraws auto-merge.

Reviews without a body, such as approvals, also arrive as Triggers and can wake an Executor waiting for review. These instructions govern the agent, not GitHub's merge rules. To enforce approvals, require them in branch protection and dismiss stale approvals. Omit the merge CLI or remove the auto-merge paragraph to require manual merging.

## How a Ticket ends

- **Ready without a pull request:** a `ready` Report ends the Ticket as completed.
- **Nothing to do:** an Executor that finds no work for a person to act on, such as a request that does not reproduce or is superseded, reports `dropped`. The Ticket ends without a message, unless a matched rule asks for one, and a person's later message on its Threads resumes it.
### Pull requests

A Ticket follows the pull request it started from once its Executor reports it. It also follows each pull request opened from its branch once reported by the Executor or found by the GitHub Source. Reopened pull requests are followed again.

The Ticket is done when none of the pull requests it opened remain open. If it opened none, all pull requests it follows must be closed. It then ends with the outcome of the last relevant close and keeps its Subscriptions, allowing a later human comment to resume it.

A close does not end the Ticket while resumed, retried or recovered work is unfinished. It also waits if the Executor acknowledged or answered a follow-up it owns but has not since made a non-progress Report or ended a turn after reading that message. A later `ready` Report ends the Ticket once the same pull-request completion rule is satisfied.

Chat Channels receive one final notice about the pull-request outcome. GitHub already displays the outcome on the pull request itself. Removing a Ticket's Subscription to a pull request also stops it following that pull request.

"Awaiting review" therefore means a `ready` Report with a pull request.

### Follow-ups and context Threads

The Executor decides human follow-ups on its Ticket's own Threads. It handles in-scope requests and hands back requests beyond its scope or for another Ticket. Once no Executor owns the message, it becomes a candidate for the main Session. The main Session may otherwise act on the follow-up only to stop work at the person's request.

An Input counts as read after the Session takes it into a step and subsequently reports or ends a turn. When a Ticket ends, unread messages that were not acknowledged, answered or handed back return to Eval, as described in [002 Authorization](002-authorization.md). Read messages left without action, such as thanks, do not.

Threads followed only for context still deliver messages, but do not give the Ticket ownership of human follow-ups or resume ended Tickets. Those messages can be assessed independently.

Sources poll subscribed Threads while a live Ticket subscribes, and for two weeks after the later of the last Trigger and the subscribing Tickets' end. Afterwards, messages arrive only through ordinary intake: GitHub notifications or Feishu live events.

## Failure and recovery

### Required P4 delivery and report artifacts

When P4 is enabled, its `requireDelivery` setting defaults to true for newly accepted TAPD bug requests without a Git project mapping. The choice is frozen in `Execution.delivery`, including TAPD bug URLs in local/Feishu requests; existing tickets are not silently rebound. Only the operator panel can change this policy. A P4-marked ticket must report a verified ticket-owned shelved CL; omitting the CL or reporting `dropped` does not complete it. Another ticket's CL is evidence, not this ticket's delivery. If no new change is needed, report `blocked` for explicit operator disposition rather than calling the original repair completed.

P4 supports `workspaceMode=ticket` (legacy independent client) and an explicitly authorized `workspaceMode=current`. Current mode freezes `executionClient`, `workspaceRoot`, port and user on new tickets and runs the worker directly in that Root. It does not require or run a prepare command; a missing Root blocks instead of creating an empty checkout. Root, owner, login and real synchronized files are still checked. Before a P4 worker starts, the Host (not the worker shim) brings only the allowed depot paths to head when `syncBeforeWork` is **explicitly enabled (default off)**. A read-only benchmark on the real UE client found `sync -n` previewing 16283 updates; the following full-tree `diff -se` over the two `...` allowed paths ran past the Host's 10-minute timeout, so the ticket stayed `blocked` and no worker session was ever created. With sync off the worker starts from the current workspace and the operator owns keeping it at head. Enable it only after narrowing `paths`. It previews with `p4 sync -n`; only when files would change does it compare them with `p4 diff -se`, so an up-to-date workspace triggers no full-tree difference scan. A planned update to a file with an unopened local edit is a conflict: the ticket is stopped, nothing is overwritten. Otherwise `p4 sync -q` runs without `-f`, then `p4 resolve -am` merges automatically and skips conflicted files (never `-af`/`-at`/`-ay`). `p4 fstat -Ru` then reports anything still unresolved; such a merge conflict also stops the ticket. A `P4ConflictError` ends the ticket as `stopped` with the conflicting files and uses the existing `ticket.ended` path for the Feishu result notice and local report. It does not retry, revert, force-accept or relaunch the worker. No `sync` permission is added to the worker p4 guard; the panel-only switch and its history record are the only operator controls. P4 tagged-output parsing and resolve behaviour have been checked with stand-ins and read-only CLI probes, not a live conflicted sync.

Current mode always refuses other tickets'/human opened files rather than reverting or adopting them. It does **not** scan unopened local differences by default: `allwrite` clients constantly produce such differences from Python caches, build binaries and editor-saved assets, and they never enter a shelf or CL. The operator can enable `checkUnopenedDiffs` (panel-only, recorded in config history) for strict preflight; that mode runs `p4 diff -se` over allowed paths and blocks with the count, a generated-vs-source breakdown and up to eight example files. Neither mode ignores real modifications automatically nor cleans them up. Per-ticket mode keeps its original prepare and name-suffix validation. `fstat -Rh -m 1` is minimum readiness, not proof that a full UE project is synced/buildable.

Current-mode execution and outstanding P4 reviews are serialized by configured Root inside this Host, including automated and human wake paths. Only single-worker tickets are supported; use a single-worker flow rather than team steps. Separate Hosts, external editors and alias/symlink roots are not OS-isolated by this in-process reservation: operators must avoid concurrent access. Worker CLI guard pins the configured client, preserves no-submit, and refuses sync/revert/unshelve/client reconfiguration on shared workspaces. Existing CLI guardrails are not a filesystem security boundary. Each reported CL needs its exact `[dsh-superagent:<ticket-id>]` marker; same client alone never proves CL ownership. Another ticket's CL remains evidence only.

If the execution client equals the configured Host submit client, automated approval does not unshelve over opened files in that same client; it refuses with an explicit manual-submission action. Inspect the shelf and submit manually, or separately configure a safe submission client. The install never submits, resyncs, changes or migrates existing client/task directories. New selection fields are panel-only and only affect new tickets. A historical blocked ticket retaining an independent-workspace snapshot is not silently rebound by changing settings.

Recorded `blocked`, `failed`, review-waiting `ready` and terminal results independently queue `reportLocal`. This writes a local versioned HTML snapshot even with Feishu delivery disabled or absent. It does not change the ticket or transmit data. The existing `ticketReport` effect remains opt-in (automatic switch or explicit manual send); generation and delivery keys cannot overwrite one another. Each upload uses immutable version-specific HTML/XML; changed outcomes stop stale sends before the next external operation. Document URL caching does not prove message delivery: a versioned receipt records sent, target-gone or partial; a queued effect may be retrying. Already accepted external operations cannot be rolled back.

The ticket detail page offers an on-demand report status and download. `GET tickets/:id/report` and `GET tickets/:id/report/content` only read generated artifacts; POST remains an explicit send operation. A current report without an artifact is shown as missing/queued, never as an older version's result. Report HTML is escaped, but its plain text may contain private request details; inspect it before sharing. Historical bug reports and task completion states are not rewritten by installation; recovering an old task or sending its report requires explicit operator action.

### Background cleanup and runtime compatibility

A report can commit before its asynchronous background cleanup fails. The `worker` health error does not roll back that report or prove that its code change failed; inspect the Ticket's report and delivery references separately. Never repeat a completed fix just to clear health.

SuperAgent supports the legacy `waitForChildren/listChildren/drainChildren` service and rc.2's `waitForTreeWork/listDescendants/interrupt` service by capability. The rc.2 stop path interrupts only that worker's descendants under its exact ancestor authority, then waits with a bounded deadline. It preserves the persistent worker's admission for later follow-ups/recovery; a Ticket ending is not disposal of its Agent. The runtime's `drainDescendants` permanently closes admission until that exact root leaves the registry, so ordinary ticket stops and Host recovery do not use it. This is a best-effort interrupt of discovered descendants, not an atomic teardown of concurrent startup or a verified shutdown of every descendant process. Missing capabilities, unreadable catalogs and stop timeouts remain errors.

Cleanup still attempts jobs and subagents even when one fails. Health details now include bounded nested aggregate/cause messages rather than just the outer `AggregateError`; credential assignments are redacted. A successful unrelated event can clear an earlier health error under the existing recovery rule, so a green health entry alone is not proof that an earlier stop succeeded. No finished Ticket/report is rewritten during this fix.

### Pending-only P4 delivery and reconcile exclusions

`submit` defaults to `pending`: a named pending changelist is the delivery. It is frozen on each ticket as `Execution.p4Delivery`, so a later settings change cannot make an existing ticket submit. On a `ready` report the Host reads `p4 opened`, moves files from the default or another CL into the reported CL with `p4 reopen -c`, renames the CL from `pendingName` (always keeping `[dsh-superagent:<ticket-id>]`), and re-shelves it. No review is created, nothing is submitted or unshelved, and `Assignments.report` ends the ticket as `completed` instead of waiting for the CL thread to close. The report summary and Feishu result notice name the CL; a person inspects and submits it in P4V. Legacy `pipeline`/`host` modes keep their per-CL review and submit, and `Reviews.approve` refuses any ticket frozen as pending.

**No tree walk by default.** A worker must `p4 edit` before editing, so `p4 opened` already lists the delivery. A read-only benchmark on the real UE client measured `p4 reconcile -n` on the two full allowed paths at over 240 s (both the raw wildcards and a `p4 dirs`-narrowed list), and `reconcile -n -e` on `Engine/Source/...` alone at over 90 s; `p4 diff -se` on the full paths also exceeded 90 s. Explicit file lists were fast (3 files 0.37 s, 66 files 1.46 s). Therefore delivery makes no `dirs`, no wildcard argument and no `reconcile -n` preview; the only calls are `opened`, `reopen`, `change -o`/`-i` and `shelve`, all sub-second server metadata operations. `reconcileFallback` (panel-only, default off, recorded in config history) optionally runs `reconcile -e -a -d -c` on the exact, non-ignored, in-scope files `p4 opened` reported, in batches of 100, and never passes `...` or `*`.

`reconcileIgnore` defaults to `Binaries`, `Intermediate`, `DerivedDataCache`, `Saved`, `__pycache__`, `Logs`, `.vs`, `obj`, `*.pyc`, `*.pdb`, `*.obj`, `*.ilk`, `*.exp`, shared by the schema and the settings panel (`defaults` rows are shown explicitly even before the field is saved; an explicit empty list stays empty). It accepts a directory name, a file suffix or a full `//depot/...` pattern, and filters `p4 opened` results before any `reconcile`/`reopen` so generated files never enter the CL. The same filter excludes generated files from the pre-work `sync -n` conflict check. P4 command shapes were verified with read-only CLI probes; the write path is covered by stand-ins, not a live CL.

### Feishu status notices for terminal worker reports

`ticketResultNotices` fires only on `ticket.ended`. A `ready` report does not necessarily end a ticket: with a
`p4:` follow still open (submit-mode delivery) it waits for a person's CL review, so `ticket.ended` never fires
and the originating Feishu conversation hears nothing. The 2026-11-16 incident showed exactly this: a worker
reported `ready` with a shelved CL at 15:12, the ticket stayed at `stage=person/review` with `ended=null`, and
`outbox` had no message after the two setup acknowledgements at 14:38. `reportRelay` only steers the main
Session, whose handoff rules keep routine results internal, so it is not a guaranteed IM delivery.

`ticketStatusNotices` closes the gap: on `assignment.reported` the Host deterministically sends one notice per
Feishu channel for a terminal report (`ready`, `blocked`, `failed`, `dropped`) when the ticket has **not** ended.
Ended tickets skip it, so `ticketResultNotices` remains the only end notice; a report with an open `attention`
question skips it too, because that question has its own message. The id carries the report's `at` and the channel
thread, so repeated events are swallowed by Outbox receipts. Text is clipped to the IM word budget, which matters
here: the incident's report summary was 2180 characters.

### Imported TAPD filter and daily automatic intake

The TAPD Source card accepts the JSON exported by the platform's bug page (`source: "TAPD筛选条件"`). The Host compiles the display-oriented Chinese `conditions` into `/bugs` query fields, using the workspace's own `bugs/custom_fields_settings` and `workflows/status_map` when reachable, with verified built-in maps as a fallback. Field mapping was confirmed with read-only probes against workspace 68880148: 发布计划 → `release_id` (from `state.releases`), 优先级 → `priority_label`, 所属分支 → `custom_field_10`, 是否必现 → `custom_field_7`, BUG类型 → `custom_field_19`, 状态（属于）→ `v_status` (Chinese names), 状态（不属于）→ `status=<>suspended` (via status codes), 创建时间 → `created=from~to`. Multi-value fields use `|`. An import reports every condition as `api`, `local`, `skipped` (disabled) or `manual`, and never silently narrows the result.

Three conditions cannot be expressed by TAPD's query syntax and are applied locally to fetched items: 标题「不包含」(no not-like; `NOT_EQ` only excludes an exactly equal title), 标签「不属于」(`label=<>x` also drops all unlabelled bugs) and multi-value status exclusion. A 处理人 group name is not an account name: unless the operator maps the group to person names in `ownerGroups`, the condition is reported as `manual` and left out rather than returning zero results.

Import adds one `type=bug` watch marked `sweepOnly` (a schedule container, skipped by normal polling) and one `filterSchedules` entry. Schedules are **off by default**; a person enables one in the panel, sets the local time, per-run cap and a recent-changed window, and may preview the match count first. At or after that time each day the Host fetches matching bugs, applies the local rules, skips IDs already dispatched, caps the batch, and hands the new ones to the Engine as operator-authorized Triggers (`machineGate` admits only the `filterSweep` marker). A failed sweep does not mark the day as done and retries on the next poll; a capped sweep is reported as a Source health error. The compiled filter matched 18573 bugs in total on the real workspace, so the defaults (cap 20, window 2 days, disabled) are deliberate.

### Executor blocked or failed

When an Executor Session reports `blocked` or `failed`, or fails to start or errors, which records `failed`, the Ticket takes no automatic Input.

A passing failure of the model provider or the network, an HTTP 408, 429 or 5xx or a refused, reset or timed-out connection, is tried again first, three times with a growing backoff: a launch runs again, and a worker whose turn failed is told to go on; a failed prepare command is not tried again.

Once failed, CI and bot messages are recorded on it, but they are not delivered and do not wake the Session.

Its tools stay available, so a person can continue in the Session directly.

A launch that failed is not tried again on its own.

A person's message, a later Report that is neither `blocked` nor `failed`, or a retry ends the hold.

It is worked out from the stored Reports and Inputs, so a restart keeps it.
### Retry

Available while an open Ticket is in `person / delivery`, `person / blocked` or `person / failed`: a new Assignment, which starts its worker again and takes the Inputs that wait, is the remedy for each.

Once a person's message reached a blocked or failed Ticket, the Executor has the message, so the Ticket shows as working, or as queued when a failed launch starts again, and offers no retry, unless delivering that message failed.

A retry ends the current Assignment and starts a new one in the same Executor Session, directory, branch and pull request.

The Executor model applies only when a Session is created; an existing Session keeps its model.
### Restart

Running Assignments end with "host restarted" and new ones start with a recovery note that tells the Executor to check its directory, git history and GitHub before repeating any outside action, oldest Ticket first.

Assignments that are waiting, ready, blocked or failed stay as they are, unless an Input reached them after that Report, in which case they start again too.

Sessions, directories, Subscriptions, pending messages and the stored work below survive a restart, and so does the record of which messages each Executor Session took into its history, which a step does once it claimed them and before its model call: a message taken by a turn the restart cut off counts as read once a Report or the end of a turn follows, while one a step claimed but a cancel or error cut off before the history counts as unread.

A retry or a restart gives the new Assignment again the messages delivered to the Assignment it replaces that its Executor Session did not take, which a cancel or a cut-off step may have dropped; a copy still waiting in the Session, kept by a restart or persisted across a crash, is taken out before the new Assignment's first message, so the new delivery is the only copy.
### Stored work

What dsh-superagent does after a decision, such as relaying a candidate, a follow-up or a report to the main Session, launching an Assignment or delivering an Input, is stored first and done afterwards.

A relay or a delivery that fails, such as when its Session cannot be reached, is retried after 2 seconds, then after a delay that doubles up to a minute; a launch that fails fails its Ticket, unless the failure was a passing one, as above.

Each kind of work reports an error among the overview's system problems only after one item failed three times in a row; a failed Input delivery shows on its Ticket instead.

Relays to the main Session keep their order, and so do notices; a failed one holds back the later ones of its kind.
### Source failure

The GitHub Source reads each Issue, pull request and Thread on its own: a failed read keeps its error on its Thread, is read again on the next poll, and counts towards an error of the Source, which it reports after three failed polls in a row by default; any successful poll resets the count.

GitHub answers 404 also when the agent lost access to a private repository, so a 404 is retried.

A notified Issue or pull request whose reads keep failing is dropped a day after its first failed read, and at once when GitHub reports it as deleted; it then no longer fails the poll, its Thread keeps the error, and the Source's state names it.

Its read position stays where it was, so a later notification or a poll of its Thread reads what the failed reads missed.

The Feishu event consumer reports every failure, and polling of subscribed topics keeps each failure on its Thread.

A malformed item in a GitHub list or a Feishu page is skipped, and the Source's state counts it.
### Channel failure

Outgoing messages are stored and sent as stored work, retried with backoff from 5 seconds, doubling up to 300.

A Ticket's messages to one conversation go out in the order they were queued, so its acknowledgement comes before its later answer or result: a message waits while an earlier one of the same Ticket to the same conversation has not gone out, until that one has failed three times in a row and shows as a problem.

Messages of other Tickets, and messages of no Ticket, do not wait for it.

A message with failed attempts is a system problem until it goes out or is withdrawn.

A message is dropped only when its Source no longer listens to the conversation, or when the Source answers that the conversation can never receive it; while its Source is off, it waits.

The Sources answer that for a deleted Issue or a locked conversation on GitHub, and for a recalled message or one Feishu no longer finds on Feishu.

A reply to a review comment that no longer exists goes to the pull request's conversation instead.

A dropped message keeps its record, with when and why it was dropped and the Ticket it was for, so it is never queued again; a dropped acknowledgement reads as dropped, not sent.
### Pause processing

Stops dispatch, new Evals, Eval timeouts, Input delivery and replies; a launch already under way waits until processing resumes.

Sources keep recording Triggers, and a running Executor turn is not interrupted.

A person's message to an ended Ticket waits: the first pass after the pause resumes the Ticket, if its Mandate holds under the Policy then.

An Eval in progress does not expire during a pause; its deadline moves later by the pause's length.
### Invalid configuration

A stored Source configuration that its kind rejects disables that Source instance.
