# 007 Architecture

This is the developer guide to the implementation. It maps the concepts in [001 Domain model](001-domain.md) through [006 Deployment](006-deployment.md) to classes, interfaces and files. Start with the runtime and Engine, then use the module and test tables as a code index.

In VsSaros the plugin is the built-in `dsh-plugins/vssaros-superagent`: what ships (`lib/`, `cordis.patch.yml`, `prompts/`, `skills/`, `locale/`) is at its root, and this `dev/` workspace (never shipped) holds the source, tests, documents and build tools. Paths in the tables are relative to `dev/`. `scripts/build.mjs` writes `../lib`, which is committed (`--check` tells when it lags the source); `scripts/upstream-patches.mjs` keeps `vssaros-patches.diff`, the changes against the upstream in its own layout.

## Core classes and glue

Core classes own domain concepts and external boundaries behind small interfaces. Glue translates tool arguments, HTTP requests, Source payloads and DeepSeek Harness events into calls to those classes, then turns results into cards, views and messages.

```mermaid
flowchart TB
  plugins[Source plugins] -->|SourceContext| engine
  tools[Session tools] --> engine
  http[Management routes] --> engine
  engine[Engine] -->|Repositories| store[Store]
  engine -->|Policy| policy[Policy]
  engine -->|SourceScope| registry[SourceRegistry]
  engine -->|Assessor| assessor[MasterAssessor]
  engine -->|Executor| executor[DshExecutor]
  assessor -->|decide| engine
  engine -->|Outbox| outbox[Outbox]
  executor -->|assignmentStarted, inputsDelivered, report| engine
  settings[Settings] -->|policyChanged| engine
  assessor & executor & sessions[Sessions] & outbox -->|enqueue| effects[Effects]
  effects --> store
```

`Runtime` (`src/app/runtime.ts`) constructs the application, supplies dependencies, and owns startup and shutdown. `Engine` constructs its own internal parts. The Executor and Assessor call back into the Engine, so Runtime gives them getters rather than requiring construction in a circular order.

### Runtime

`Runtime` is the composition root; it contains no domain rules. Its constructor locks the state directory, opens the Store and builds each component. If construction fails, it closes the Store and releases the lock.

Startup registers management routes and runs Setup. After setup resolves, it installs Session and Executor hooks, ensures the main Session exists, starts Policy syncs, resumes interrupted Assignments, and starts passes and effects. `ready` marks completion of startup.

Shutdown cancels turns, waits for passes, effects and agents, restores the process environment, closes the Store and releases the lock. Source plugins inject Runtime as the `orchestrator` service through the narrow `SourceHost` interface.

| Part | Module | Does |
| --- | --- | --- |
| Setup | `src/app/setup.ts` | Resolves the repository and the accounts by probing their CLIs the way worker shells run them, writes and applies the workers' environment and command shims, and keeps the setup problems; Settings checks a changed account through it, and restarts through it, which runs setup again |
| Passes | `src/app/passes.ts` | One pass at a time, every two seconds and whenever a command asks: the due effects, then `Engine.evaluateDue`; a Source's Trigger reaches the Engine through it |
| Outbox | `src/app/outbox.ts` | The Engine's `Outbox` port, and the only writer of the receipts: `send` keeps a message's receipt and queues its `reply` effect in one transaction, and the effect's handler sends it through `SourceRegistry.send`; a message waits while its Source is off, and is dropped when the conversation is gone or not listened to |
| Notices | `src/app/notices.ts` | Converts domain events and worker activity into main-Session messages. `eventNotice` handles domain notices; `reportRelay` forwards questions immediately, keeps ordinary progress on its Ticket, and relays other reports; `followupRelay` names the Tickets that own a human follow-up. Relays arriving during a turn are delivered together at its next step through the DeepSeek Harness inbox |

### Engine

`Engine` (`src/core/engine.ts`) is the only writer of Triggers, Threads, Decisions, Tickets and Assignments. It receives these ports from `src/core/ports.ts`: `Repositories`, a current-Policy getter, `SourceScope`, `Assessor`, `Executor` and `Outbox`. Optional dependencies are `prepareTicket`, `now` and `emit`.

All Engine methods are synchronous. Each command changes its aggregates in one transaction. `evaluateDue` uses a separate transaction for each Eval or Ticket it changes. Ports enqueue external work inside the transaction; adapters perform it after commit. Invalid requests throw `UserError`.

The Engine exposes one entry point and delegates to five internal parts. It owns each command's transaction. Commands spanning parts, such as `attach`, `evaluateDue` and `policyChanged`, call the parts in sequence.

Each part extends `EnginePart` (`src/core/part.ts`), which provides options and shared reads. Dependencies between the parts flow in one direction:

| Part | Responsibility | Depends on |
| --- | --- | --- |
| `Intake` | A Source's Trigger: stored once with its disposition, recorded on its Threads and their correlations, fanned out to the subscribed Tickets and, unless it is a person's message that reached one, queued for Eval on its primary Thread | Tickets |
| `Evals` | The Evals of Threads: batching, the gate's strength, actor and basis with the Trigger that gave them (`primary`), the deadline from the candidate's delivery and its shift by a pause, the requeue of an expired Eval, candidates, replays and hand-backs, the requeue on a Policy change, and the Decision each ends with: accept, stop, ignore or unavailable | Tickets |
| `Tickets` | The Ticket lifecycle: creation from an accept with its Mandate, Subscriptions and first Assignment, the Threads it follows and their closes (`followsDone`), attached Threads and Threads followed for context, Inputs and notes, resume and the messages a resume refuses, retry, restart, stop and end, the Subscriptions it drops, and the notice of a Policy change to the Tickets it bears on | Replies |
| `Assignments` | What the Executor and its workers report: an Assignment started, Inputs reached it or failed to, a restart interrupted it, and a worker's Report with its question for a person | Tickets, Replies |
| `Replies` | Channel writes through the `Outbox`: the acknowledgement, the answer, the result and the attention message, each by the rule that allows it | Nothing |

Commands use imperative names such as `stopTicket`; facts reported by adapters use past-tense names such as `assignmentStarted`. The query `candidate` uses a noun.

Callers receive only their role's `Pick` of the Engine: `EngineForSources`, `EngineForMainSession`, `EngineForPeople`, `EngineForSettings` or `EngineForExecutor`.

| Role | Method | Effect |
| --- | --- | --- |
| Sources | `receive(trigger)` | Stores a Trigger once and answers `stored`, `duplicate`, or `filtered` when no Source receives it; fans it out to the Tickets subscribed to its Threads, where a person's message resumes an ended Ticket at once unless processing is paused, and queues it for Eval on its primary Thread, unless it is a person's message that reached a Ticket, which stays that Ticket's |
| Sources | `bindThread(ticketId, thread, own)` | Makes an open Ticket follow one of the Source's Threads, such as a pull request's, `own` when the Ticket opened it; a closed Thread bound again is open again. The Threads' closes, not a `ready` Report, end the Ticket |
| Sources | `threadClosed(thread, outcome, at)` | A Thread closed: each open Ticket that follows it records the close, and ends once it is done with the Threads it follows (`followsDone`): no Thread it opened is open, or, when it opened none, every Thread it follows closed. It ends `merged` or `closed` as the latest of those closes did, unless work resumed after the close has not reported `ready`, or its Executor took up, by acknowledging or answering it, a person's follow-up it decides after its latest Report other than `progress`, or the end of its last turn; a `dropped` Report then ends it as the close did |
| Main Session | `candidate(triggerId)` | The Eval that holds a Trigger, as its assessor sees it |
| Main Session | `candidateDelivered(evalId)` | The Eval's candidate reached the main Session: its deadline counts from now |
| Main Session | `decide(triggerId, outcome)` | Records an Eval Decision, or a direct Decision for an explicit request. Accept creates the Ticket, Mandate, Assignment, Subscriptions and acknowledgement atomically. An inferred candidate ignored from its card records `ignoredFromCard` before the supplied reason. While `followupOwners` still owns a human follow-up, only stop is allowed |
| Main Session | `attach(ticketId, triggerId, note?)` | Routes a Trigger to a Ticket it points at, whose Executor then decides it as a follow-up, and ends the Eval that holds it, whose other Triggers wait for a fresh Eval; an ended Ticket resumes under its Mandate at once unless processing is paused. A follow-up an Executor still decides is refused, as is one routed back to the Ticket that handed it back |
| Main Session | `requestStatus(ticketId)` | Asks a waiting Executor Session for its status, and answers whether it asked |
| Main Session | `note(ticketId, text)` | Gives a Ticket's Executor a fact from other work as a text Input, which grants nothing |
| Main Session, Executor | `reply(request)` | Queues a message for the Channel its purpose names: `acknowledgement`, `answer`, `result` or `attention` |
| People | `stopTicket(ticketId, reason?)` | A person's stop, which withdraws the Mandate |
| People | `retryTicket(ticketId)` | Ends the stalled Assignment of a Ticket that waits for a person after a `failed` or `blocked` Report, or whose Input delivery failed (`canRetry`), and starts a new one |
| People | `reevaluate(triggerId)` | Queues a stored Trigger for a fresh Eval |
| People | `unsubscribe(thread)` | Drops every Subscription on a Thread, and the Tickets that followed it follow it no more; each keeps deciding the follow-ups it received there |
| People | `dismiss(decisionId)` | Dismisses the problem an `unavailable` Decision shows, which the Decision records |
| Executor | `assignmentStarted(ticketId, assignmentId)` | An Assignment runs; its waiting Inputs go out |
| Executor | `inputsDelivered(ticketId, assignmentId, inputIds)` | Inputs reached the Assignment's Executor Session, where each waits for a step to take it |
| Executor | `inputsRead(ticketId, inputIds)` | The Executor Session took the messages that carry these Inputs into its history (a `user/message` Session event), from which its model has them; a step that claimed them and was cancelled or failed before does not count. Each counts as read once a Report or the end of a turn follows, also after a restart, and its Ticket's end does not let go of it; an Input delivered before reads were recorded counts as read once a Report or the end of a turn followed its delivery |
| Executor | `turnEnded(ticketId, assignmentId)` | A turn of the Executor Session ended, also after a Report, once nothing runs for it in the background or as it hands off to a person. What a step took before, it read (`inputsRead`) |
| Executor | `deliveryFailed(ticketId, assignmentId, error)` | Delivering Inputs failed; the Ticket shows it until a delivery succeeds, a new Assignment starts or the Ticket ends |
| Executor | `report(ticketId, report)` | Records a Report and its question for a person; `dropped` ends the Ticket, and `ready` completes one that follows no Thread, and ends one done with the Threads it follows as they ended |
| Executor | `markUnrelated(ticketId, thread, reason)` | Drops only that Ticket's Subscription to an attached Thread it found unrelated, and hands back, with the reason, the follow-ups there that the Ticket decides |
| Executor | `followForContext(ticketId, thread)` | Subscribes an open Ticket to a related Thread for context: its messages reach the Ticket but lend it no follow-up strength and do not resume it |
| Executor | `handback(ticketId, triggerId, reason)` | Records that the Ticket hands back a Trigger that reached it, with the reason its candidate carries, and queues it for a fresh Eval once no other Ticket decides it, if this Ticket did; it answers whether it queued it. A Ticket hands back each Trigger once and keeps its Subscription |
| Executor | `assignmentInterrupted(ticketId, assignmentId)` | An Assignment was running when the host stopped: one interrupted mid-work, or one that received an Input after its latest Report, starts again with a recovery note and the Inputs delivered to it that its Executor Session did not take, as a retry does; one that had reported since keeps its Session. The DshExecutor reports each at start (`resume`), oldest Ticket first, and queues again a launch that waits |
| Passes | `evaluateDue()` | Unless processing is paused: starts the Evals of the Threads whose queued Triggers wait, one per Thread with the Triggers queued meanwhile as one batch; queues the Triggers of an Eval past its deadline again, twice in a row, and records it `unavailable` the third time; and resumes the ended Tickets a person's message reached during a pause, if their Mandates still hold. An Eval whose candidate has not reached the main Session does not expire. While processing is paused, no Eval expires, and once it resumes each deadline moves later by the pause's length |
| Settings | `policyChanged(from, to, effects)` | Tells each live Ticket the change bears on how (`policyEffects` in `src/policy.ts`: a rule it was accepted under changed or no longer applies, its requester may no longer start work, or proactive work is no longer accepted), and restarts the Evals in progress under the new version |

The Engine keeps batching, authorization, fan-out, resume and attention lifecycle rules private. Several shared predicates make these rules consistent:

- `waitsForPerson` (`src/core/model.ts`): the latest Assignment reported `blocked` or `failed`, and no human message has arrived since. Automatic Inputs and failed launches remain held while this is true.
- `followupOwners`: the Tickets still responsible for a human follow-up received on their own Threads. A Ticket can be live or ended without a human stop and waiting to resume. Handing back the message ends that ownership.
- `settled`: a Decision resolved the request; stop, unavailable, routed and refused-stop Decisions do not count.
- `ticketStage` (`src/core/stage.ts`): implements the stage table in [003 Execution](003-execution.md).

When a Ticket ends, unread follow-ups return to Eval unless another Ticket still owns them or another disposition settled them. Acknowledged, answered and handed-back messages are excluded. For older records without acknowledgement dispositions, the outbox receipt supplies that fact. A final Report also covers messages waiting when the Assignment began, including the message that resumed it. The message that stopped a Ticket is not automatically re-evaluated.

After a change, the Engine emits an event from `DomainEvents` in `src/core/ports.ts`:

`trigger.received`, `eval.started`, `decision.recorded`, `ticket.created`, `ticket.resumed`, `ticket.ended`, `assignment.started`, `assignment.ended`, `thread.subscribed`, `thread.unsubscribed`, `trigger.requeued`, or `policy.changed`.

Runtime turns `ticket.ended`, `trigger.requeued` and `thread.unsubscribed` into notices. A human `trigger.received` delivered to Tickets becomes a follow-up relay. `pullEndNotices` sends one chat notice, using a stable id, when a Ticket ends merged or closed. Other events currently have no consumer.

### Model

`src/core/model.ts` holds the domain types, and `src/core/stage.ts` the Ticket stages. A Decision records why as `reason`, a list of `Reason`s (`src/core/reasons.ts`): each a `code` with its `values` and, for one Trigger of a batch, its `triggerId`.

The core's codes, such as `timeout`, `policyChanged`, `routed` and `startedTicket`, are `REASONS`, with the English that agents read through `reasonText`; a gate or a Source scope gives its own, such as `not_a_member`; and `said` carries words an assessor or a person wrote. The panel words each code by `reason.<code>`, and a Trigger a Source filtered records the Source's code the same way.

A Ticket keeps each fact once. It is open while it has no `ended`, which records when, by whom, why and with what outcome it ended; what it last said is its latest Assignment Report (`latestReport`); and its Executor Session is named after it (`workerSessionId` in `src/executor/dsh.ts`).

Its fields are typed: `origin`, the admissible Trigger that gave its Eval's batch its strength and the batch itself (`triggerId`, `triggerIds`); `execution`, what the Executor chose (`name`, `directory` and `assignment`); `delivery`, the last failed Input delivery (`error`, `at`), until a delivery succeeds, a new Assignment starts or the Ticket ends; and `follows`, the Threads a Source made it follow, each `{thread, own, closed?}`: `own` when the Ticket opened it, and `closed` with `at` and `outcome` once it closed. Tickets alone writes `follows`; the GitHub Source reads its pull requests with `pullsOf` and `pullOf` (`src/sources/github-pull.ts`).

An Input that carries a Trigger records whether a person wrote it, which `waitsForPerson` reads. A Thread also lists in `context` the subscribed Tickets that follow it only for context, and counts in `expired` the Evals of its queued Triggers that expired in a row; an Evaluation records its `primary` Trigger and when its candidate was `delivered`.

A Trigger's disposition records the Tickets it reached, by fan-out or attachment, a person's requeue, each Ticket that handed it back, with the reason, and each Ticket whose Executor acknowledged or answered it.

A Mandate's `basis` (`MandateBasis`) records how the gate admitted its Trigger. Revalidation reads the receiving `source`, `scope` and `row`, the listed `sender`, matched `rules`, and `via`:

| `via` | Admission basis |
| --- | --- |
| `addressed` | An allowed sender addressed the agent |
| `followup` | A message arrived on a Thread with Tickets |
| `admission` | An admission-table cell; `observation` marks an inferred candidate |
| `bot` | A listed bot produced an inferred candidate |

Trigger and Thread `meta` belong to the Source. The core does not interpret them.

### Policy

`src/policy.ts` defines settings schemas, authorization and assessment rules. `settingsPolicy(settings, scope)` returns a fresh, stateless `Policy` on each use:

- `version`, `paused` and `evalTimeoutMs` describe its current state.
- `gate(trigger, thread, tickets)` returns admission strength and basis.
- `revalidate(mandate)` checks whether an existing Mandate still holds.
- `admitsInferred(rules)` permits proactive acceptance only in auto mode with enabled matching rules.

`assessmentOutcome(assessment, settings, strength)` converts the model's assessment to an Engine outcome. It requires a judgement for every enabled rule, settled direction, a matching rule and evidence of intent. Outside auto mode, an inferred accept becomes a “would accept” record.

`policyEffects(tickets, old, now, scope)` identifies which open Tickets a change affects and how. `Engine.policyChanged` notifies only those Tickets. `policyVersion` hashes rules, accept mode and the Sources' Policy parts, including bot lists.

### Store

`Store` (`src/app/store.ts`) owns one SQLite database. Runtime acquires the directory lock before opening it, preventing a second process from migrating or writing the same state.

Its interfaces are grouped by purpose:

- **Domain repositories:** `atomic`, plus `triggers`, `threads`, `tickets` and `decisions`, each with `get`, `save` and list queries. Indexed working sets are `threads.active()`, `tickets.open()`, `tickets.active()` and `read.subscribedThreads`.
- **Read queries:** `read` serves views, tools and Source polls through methods such as `threadTriggers`, `triggerStats`, `search` and `droppedReplies`. These methods never write.
- **Source metadata:** `threads.describe` and `threads.patchMeta` update Source-owned Thread metadata.
- **Settings:** `settings`, `saveSettings`, `blockRevision` and `settingsHistory`. Settings and prompts use numbered `Versions` (`src/app/versions.ts`).
- **Outbox receipts:** `replyStatus` and `receipts`, written only by Outbox. Receipt operations are `get`, `waiting`, `behind`, `add`, `settle` and `withdraw`. `behind` checks whether an earlier message for the same Ticket and conversation is waiting with fewer than three failures. A withdrawn message settles with `channelGone` or `channelIgnored`. Read queries expose failed and dropped replies through `failingReplies`, `droppedReplies` and `droppedSince`.
- **Typed key-value records:** `get`, `set`, `delete` and `keys`, using entries from `KV`.

`afterCommit` runs an action only after the transaction commits, never after rollback. Runtime reads records in their stored shape; the schema 11 migration converts older supported records at startup.

### Effects

`Effects` (`src/app/effects.ts`) is the durable side-effect queue. A command calls `enqueue(kind, key, payload)` inside its transaction; execution begins only after commit.

Each kind/key pair has one row. Enqueuing the same waiting key replaces its payload and makes it due immediately without changing queue order. `handle(kind, run, options)` registers one handler per kind. It processes due rows oldest first, up to the concurrency limit.

Failures retry with exponential backoff. Throwing `Later` defers work without counting a failure, for example when no worker slot is available. `start` begins processing after setup, `drain` stops it during shutdown while preserving pending rows, and `pending`/`idle` expose queue state.

| Kind | Handler | Does | At once | Retry |
| --- | --- | --- | --- | --- |
| `assessment` | MasterAssessor | Steers an Eval's candidate card into the main Session's turn, then tells the Engine it was delivered, which starts the Eval's deadline | 4, none while paused | 2 s doubling to 60 s |
| `launch` | DshExecutor | Launches a pending Assignment: prepare command, Executor Session, assignment message | The free worker slots, none while paused | A passing failure of the model provider or the network runs again after 5 s doubling to 300 s, three times; any other failure, and a failed prepare command, fails its Ticket. One held by a pause or by full worker slots tries again after 5 s |
| `delivery` | DshExecutor | Hands a Ticket's waiting Inputs to its running Assignment, in order | 4, none while paused | 2 s doubling to 60 s; one that waits for a worker slot tries again after 2 s |
| `relay` | Sessions | Steers a worker's report or question, or a person's follow-up, into the main Session's turn | 1, in queue order | 2 s doubling to 60 s |
| `notice` | Sessions | Injects a notice into the main Session without waking it | 1, in queue order | 2 s doubling to 60 s |
| `reply` | Outbox | Sends a message for a Channel through its Source, after the earlier messages of its Ticket to its conversation that have not failed three times; withdrawing the message cancels it | 1, none while paused | 5 s doubling to 300 s; one whose Source is off, or behind an earlier message, tries again after 5 s |

Each kind has a health entry under its name. It reports an error once one of its effects failed three times in a row, except `delivery`, whose failures show on their Ticket instead. Relays keep their order, and so do notices; a failed one holds back the later ones of its kind.

### Sources

Sources extend the host through `SourceKind`, defined in `src/sources/kind.ts`. A kind declares its identity, title, description, configuration `schema` and `fields`, derived `facts`, and `health` entries. Optional behavior includes `scope`, a `channel` (`allowed`, `send`, `link`), `threadContext`, `find`, `policy`, `environment` and `refreshLabels`.

`SourceRegistry` (`registry.ts`) owns registered kinds and stored instances, and implements the Engine's `SourceScope`. Registration claims health entries on `HealthBoard`; duplicate claims and reserved `sync:` names are refused. A SourceContext writes only through its registration's claimed entries, so reports after unregistration do nothing.

Registry configuration methods include `kind`, `instances`, `instance`, `validate`, `validatePolicy`, `policyPart`, `channelAllowed`, `declarations`, `environments`, `find` and `scope`. `find` asks each kind that supports search.

Generic code accesses Source behavior through the registry. `send(message, commands)` calls the kind's Channel and returns `sent`, `gone` or `waiting` if the kind is not installed. `link` resolves its Channel link. `threadContext` pairs a kind's reader with its configuration, or returns nothing when the kind has no reader. Invalid stored configuration disables the instance.

Plugins receive `SourceHost`: the registry and `context(kind)`. The kind itself uses a narrower `SourceContext`, built by `sourceContextOf` in `src/app/source-context.ts`.

That context supplies deployment and commands, setup readiness (`ready`, `configured`, `problem`), configuration, `receive`, `atomic`, and typed `state`. It also exposes Thread reads and metadata writes, Ticket reads and binding/closure commands, Trigger reads, `notify` through Outbox, and `report` for declared health entries.

### DshExecutor

`DshExecutor` (`src/executor/dsh.ts`) provides one Session and directory per Ticket. `start` and `deliver` enqueue `launch` and `delivery` effects. `stop` cancels the turn through `Store.afterCommit`, so a rolled-back end does not stop the worker.

`prepare(ticket, outcome)` supplies the Engine's `prepareTicket` hook: short name, directory and `ticketExecution` assignment text. `workerSessionId(ticket.id)` derives the Session id.

`WorkerSlots` reserves capacity before a launch or a delivery that wakes an idle worker. A human message can use one slot beyond `maxWorkers`, and wakes have priority over launches. `activeCount` supplies panel load.

Transient provider and network failures get three retries. Launches use effect backoff; failed turns receive continuation messages after 15, 30 and 60 seconds. `inputMessage` renders each Input from current Ticket state, and `mandateInstructions` adds the matched-rule limits for inferred work.

`install` subscribes to Session events; `dispose` unsubscribes. A turn end normally reports waiting, except after readiness or while human action is required. Errors report failed. At startup, `resume` reports interrupted Assignments through `assignmentInterrupted` and requeues pending launches that do not wait for a person, oldest Ticket first.

### MasterAssessor

`MasterAssessor` (`src/app/assessment.ts`) lets the main Session assess proactive candidates. `request` queues an assessment effect; `release` drops cached state when its Eval ends.

Its `context`, `read` and `decide` methods serve `orchestrator_eval`, `orchestrator_eval_read` and `orchestrator_eval_decide`. They provide bounded Thread context through `SourceRegistry.threadContext`, repository context, and decision submission. A kind without a context reader supplies only the Trigger and batch.

`assessmentOutcome` converts the model's answer for `Engine.decide`. Evals checks inferred acceptance against the current Policy again.

### Settings

`Settings` (`src/app/settings.ts`) reads and writes revisioned settings blocks. `current` and `view` read them; `save(block, value, revision, origin)` validates a save; `pause(paused, origin)` changes the separate `paused` setting.

Every save declares its origin: `panel`, `tool` or `sync`. Only `panel` can change the execution environment or fields listed in `SETUP_FIELDS` (`src/deployment.ts`).

A Policy-version change calculates `policyEffects`, records which Tickets were notified, and calls `Engine.policyChanged`. `syncable` and `sync(id)` refresh a Source's Policy part. `refreshLabels(id)` refreshes display names.

### Prompts

`Prompts` (`src/app/prompts.ts`) stores configurations as `Versions`. `current`, `version` and `history` read them; `validate`, `preview` and `save(value, baseRevision, source)` check and save them. `compose` and `skills` build Session text.

`builtInParts` lists override keys, roles, default text and required template placeholders. Each override stores team `text` and a `base`: the `builtInBase` key of its original default. Saves preserve that default under `KV.prompts.builtIn`. `defaultChanged` then reports changed defaults, their old text when available, and removed parts.

Validation inherits an omitted base from the saved override, drops removed parts already present in saved data, and rejects blank text or other unknown keys. This allows the save tool to round-trip a configuration it read. `environmentSection` and `policySection` substitute template values once, using own keys only. Configurations without overrides use defaults.

### Sessions

`Sessions` (`src/app/sessions.ts`) manages DeepSeek Harness Sessions for both roles. `ensure` creates a Session with its role's model. `install` follows agent events and registers prompts, skills and tools for managed Sessions.

`prompt` delivers once per request id. `relay` and `notify` enqueue main-Session messages handled by the `relay` and `notice` effects. `src/app/notices.ts` defines their content; `delivery` checks whether a message arrived.

Each model request binds the Session to the current prompt revision. The revisions it used are stored durably: `promptVersion` identifies the active one and `mayRead` restricts which versions a worker can inspect. Registrations are tracked in one map per agent.

`status` and `promptVersion` serve prompt pages. Saves go through `Prompts.save` and notify the main Session. `modelRetry` exposes model-budget retry state.

### Glue

| Glue | Translates |
| --- | --- |
| `src/app/runtime.ts` | The composition root: builds the parts with the interfaces they use, registers the routes and the Source host, and starts and stops dsh-superagent |
| `src/app/notices.ts` | Domain events and worker reports into notices and relays for the main Session |
| `src/app/tools/main.ts`, `src/app/tools/executor.ts` | Tool arguments of the main Session and the Executor Sessions into calls of the core classes, and their results into cards |
| `src/app/http.ts`, `src/app/views/`, `src/app/api.ts` | HTTP requests into calls, and Store reads into the panel's views; `api.ts` types every route for the panel |
| `src/app/resources.ts`, `src/app/links.ts`, `src/app/cards.ts` | Resource names into reads, source messages into links, records into compact cards for models |
| `src/sources/github*.ts`, `src/sources/feishu*.ts`, `src/sources/poll.ts` | GitHub and Feishu payloads into Triggers and Thread facts, and messages into CLI calls |
| `src/deployment.ts`, `src/setup.ts`, `src/infra/` | Setup probes and problems, CLI transport, the agent's process environment |

## Dependency rules

- **Explicit, narrow dependencies.** Each class receives an interface that names what it uses, mostly as `Pick` types of other classes: `ExecutorHost`, `AssessorHost`, `SessionsHost`, `SettingsHost`, `SetupHost`, `PassesHost` and `OutboxHost` for the core classes, and `HttpHost`, `MainToolsHost`, `ExecutorToolsHost`, `ResourceHost`, `LinkHost` and `SourceContextDeps` for the glue, with the Engine as the `Pick` of the role that calls it. The Runtime passes itself only behind such an interface. A Source plugin injects the `orchestrator` service, which its type names as a `SourceHost`: the registry and `context(kind)`; its kind's code sees only its `SourceContext`.
- **What may import what.** `src/core` imports nothing outside itself apart from Node's hashing, and does no I/O. `src/sources` imports nothing from `src/app`. The panel imports only types from the host side, and the plain values of `src/admission.ts`, `src/limits.ts`, `src/setup.ts`, `src/navigation.ts`, `src/sources/host.ts`, `src/core/errors.ts`, `src/core/reasons.ts` and the filter lists of `src/app/api.ts`.
- **One writer per state.** Each kind of state has one writer, and the others read it or ask that writer.

  | State | Writer |
  | --- | --- |
  | Triggers, Threads, Decisions, Tickets, Assignments | Engine |
  | A Source's read positions, and the meta it keeps on its Threads (`label`, `url`, `facts` and its own keys) | That Source, through `SourceContext` |
  | Settings and their history | Settings |
  | Prompt versions | Prompts |
  | Effect rows | Effects |
  | Outbox receipts | The Outbox: the Engine's messages and Sources' `notify` go through its `send`, and its `reply` effects mark them |
  | A health entry | The part that claimed it on the `HealthBoard` (`src/infra/health.ts`), which refuses a second claim: `runtime` the Runtime, which Passes report through, `evals` the Runtime after each pass, `models` Sessions, each effect kind Effects, `worker` the DshExecutor, a Source kind's entries the SourceRegistry for that kind's Source, `sync:<id>` Settings |

  A Source changes a Ticket only through `SourceContext.tickets.bindThread` and `threadClosed`, which call the Engine.
- **Requests and facts.** A method that asks for something is named by an imperative verb and its object, such as `stopTicket` or `bindThread`, and may be refused; a method that records what an adapter did is named in the past tense, such as `assignmentStarted` or `deliveryFailed`. Each host receives the Engine as the role type it needs.
- **Typed fields, and Source data under the Source.** The code reads typed fields of Tickets and Mandates. A Source keeps nothing on a Ticket: which of its Threads a Ticket follows is the Ticket's `follows`, and what it keeps about a Trigger or a Thread is in their `meta`.
- **Fixed refusals.** A refusal a person or an agent can cause is a `UserError(code, values)` from `USER_ERRORS` in `src/core/errors.ts`. The management API answers a `missing` code with 404 and the others with 400, and the panel words each code in its language. Setup problems are `SetupError` codes (`src/setup.ts`) and fixed health texts `HealthCode`s (`src/sources/host.ts`), worded the same way.
### Source-specific dependencies

Some generic modules still refer directly to GitHub or Feishu:

- Outbox applies the Feishu chat word limit.
- `src/app/links.ts` resolves Feishu message links and `repliedTo`. It and Runtime read settings with `feishuSettings`.
- `src/app/resources.ts` reads the `feishu/` and `github/` originals; `src/app/cards.ts` uses `pullOf` for Ticket cards.
- Runtime sends `pullEndNotices` for merged or closed Tickets.
- Executor tools bind reported pull requests with `readPull` and `claimPull`, using the GitHub context exposed by Runtime.
- MasterAssessor reads repository files with `readRepositoryPath`.
- Sessions and Prompts register built-in skills only for GitHub and Feishu. Migration converts their schema-10 records.
- Setup probes only GitHub and Feishu account fields (`SETUP_FIELDS`). Only those Sources receive account setup problems through `SourceContext.problem`.


## Modules

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | The main plugin entry: reads the machine settings, starts the Runtime, and gives it the restart that a save of a Source's account uses |
| `src/deployment.ts` | The plugin `Config` and `Machine`; `resolveDeployment` and `resolveFeishuBot` read the repository and the accounts from the Source settings, each CLI run as Executor shells run it; `SETUP_FIELDS` lists the Source fields setup reads. The code names no person, account or organization |
| `src/setup.ts` | Setup problems: `SetupError`, with a code, the place that fixes it and the English text the log, the main Session and the panel share |
| `src/policy.ts` | The Policy: the settings schemas by block, the Policy version, the gate and Mandate revalidation |
| `src/admission.ts` | The admission table's values, each cell's options and defaults, shared with the panel |
| `src/limits.ts` | The limits of the values a person sets, which the settings schemas check and the panel's fields offer |
| `src/kv.ts` | `KV`: every family of `kv` records with its key, its value's type and its owner, and the `Key` and `Family` types the Store and `SourceContext.state` take |
| `src/navigation.ts` | Opens a DeepSeek Harness Session from the panel once the host's catalog lists it |
| `src/core/model.ts` | The domain types, among them the typed Ticket and `MandateBasis`, with `threadKey`, `ticketOutcome`, `reached`, `followupOwners`, `settled`, `waitsForPerson`, `liveTicket`, `runningAssignment`, `latestAssignment` and `latestReport`. VsSaros (2026-11-06): `AssignmentRole` / `assignmentRole` — a ticket with an agreed team is coordinated by its Assignment (`coordinator`: it does no step, relays answers, reports once every step finished), any other is worked on (`worker`) |
| `src/core/ports.ts` | The ports: `Repositories`, `Policy`, `SourceScope`, `Assessor`, `Executor`, `Outbox`, and the domain events |
| `src/core/engine.ts` | The Engine, the core's entry point, and the role interfaces `EngineForSources`, `EngineForMainSession`, `EngineForPeople`, `EngineForSettings` and `EngineForExecutor` |
| `src/core/part.ts` | `EnginePart`, the base of the Engine's parts, and `EngineOptions` |
| `src/core/intake.ts` | `Intake`: Triggers from Sources, to their Tickets and, unless a person's message reached one, to Eval. VsSaros fix (2026-11-06, real run): on a conversation Thread (`EngineOptions.conversation`, the supervisor desk, one Thread for every request) a person's message reaches only live tickets and resumes no ended one; a message the group paths take (`receive(trigger, { tickets: false })`) reaches no ticket |
| `src/core/evals.ts` | `Evals`: the Evals of Threads and their Decisions |
| `src/core/tickets.ts` | `Tickets`: the Ticket lifecycle, the Threads a Ticket follows, Subscriptions and Inputs |
| `src/core/assignments.ts` | `Assignments`: the Executor's facts and its workers' Reports |
| `src/core/replies.ts` | `Replies`: the Engine's Channel writes |
| `src/core/stage.ts` | `ticketStage` and `canRetry`: the Ticket stages of [003 Execution](003-execution.md) |
| `src/core/errors.ts` | `UserError` and `USER_ERRORS` |
| `src/core/reasons.ts` | `Reason`, `REASONS` and `reasonText`: why the core recorded a Decision or set a Trigger aside, by code |
| `src/core/ids.ts` | `key`: ids derived from their inputs, equal for equal inputs |
| `src/core/memory.ts` | `MemoryRepositories`: the Store's repositories in memory, in the Store's order and with its nested rollback, for domain tests |
| `src/core/index.ts` | The core's exports |
| `src/app/runtime.ts` | The Runtime, the composition root, with its start and stop |
| `src/app/state-lock.ts` | VsSaros addition: `acquireStateLock`, the state-directory lock that reclaims a lock a killed Host left behind |
| `src/app/steps.ts` | VsSaros addition: `TeamSteps`: the steps of an agreed team in `team_step`, each done by its VsSaros Bot in a Session `step-<ticket>-<key>` under the Bot's preset with `orchestrator_step_report`; scheduled once the ticket's worker (the team's lead) runs, by dependencies, at most `parallel` at once and one writing step at a time, a failed step tried once more, turns counted; each end and the last reach the lead as notes, and the lead may not report ready before every step finished; plan C: a person may stop one step (`POST tickets/:id/steps/:key/stop`), and the panel's view of each step carries its Bot, what it does now, since when, and its request waiting for a person. 2026-11-06: a step may send a step it waits for back (`rework`, at most `STEP_REWORKS`); a write step this machine cannot sandbox, or one whose permission DSH refuses (`StepPermissionError`), is blocked (`needs`) until a person lets it run unsandboxed (`POST tickets/:id/steps/:key/unsandboxed`) — it never falls back to full access by itself — and `unsandboxed` stays on the step once it ran so. Token budget (2026-11-06): `stepUsageStream` meters step Sessions' `usage` chunks on `llm/stream` (`meter`, `tokens` / `tokensCap`); at 90% the lead is told once, at the cap no new step starts (`overBudget`) until a person raises it (`raiseBudget`, `POST tickets/:id/steps/budget`); each step carries its Bot's `tools` from the roster |
| `src/app/step-approvals.ts` | VsSaros addition (plan C): what a team step may do and the approvals it asks for. A read step runs `read-only`, a write step `workspace-write` in its ticket's directory (where this Windows machine cannot write the sandbox's integrity label, probed once per directory or by `Machine.sandboxProbe`, the step waits for a person instead, see `steps.ts`). 2026-11-06: waiting requests are kept in `step_approval_pending`, so after a restart they are listed (`restored`) and answerable — an answer is told to the step's Bot and an allow passes its next same call once (`step_approval_grant`); each is reminded of after `APPROVAL_REMIND_MS` (30 min) and refused after `APPROVAL_EXPIRE_MS` (60 min). `StepApprovals` answers step Sessions' `approval/request` ahead of DSH: refused for a read step, allowed by a remembered rule (`step_approval_rule`: Bot, tool, command head or folder), else waiting for a person in the panel or, for a Feishu ticket, on its thread (「同意 / 同意并记住 / 拒绝 #code」 from a listed person, after the request); `StepActivity` keeps each step's latest tool call |
| `src/app/feed.ts` | VsSaros addition (plan C): changes pushed to open pages over one `text/event-stream` response each (`GET /orchestrator/api/stream`, answered outside the JSON route table): `change` events name the topics that changed in the last 120 ms (`steps`: steps, their Bots' work and requests; `tickets`: every domain event; `desk`: desk replies), with a comment every 20 s; `no-transform` and `flush` keep a compressing server from buffering it |
| `src/app/desk-flow.ts` | VsSaros addition (plan C): where one desk message stands (`GET desk/flow/:id`), for its key-node card in the desk's DSH conversation: evaluating, filtered, declined, a ticket, or (2026-11-06) `group` when a group chat took it (read from `group_route`, so a deliberate `ignore` no longer reads as a refusal); for the message that started the ticket, its latest proposal, its team's steps and the requests waiting for a person; a later message only names its ticket |
| `src/app/desk-outbox.ts` | VsSaros fix (2026-11-05): the supervisor's messages that wake the desk (`wakesDesk`: every reply, a team proposal, a step's request, a group made for the person and (2026-11-06) a desk ticket's end), written to `desk_outbox` as `pending` before they are delivered (`followup`) and marked `recorded` only when the desk's `user/message` event with their id says its conversation has them; what is pending is delivered again, oldest first, on every start, a second after the desk Session closes and before each new message, never twice (delivery is once per id). Other messages (acknowledgements, progress) are only logged in `desk_log` for the panel |
| `src/app/groupFastPath.ts` | VsSaros P0 (2026-11-05): a deterministic group-chat request typed at the desk makes the group at intake time instead of waiting for an orchestrator LLM round. `isGroupCreationRequest` / `fastGroupPlan` choose up to three Bots and derive a name and notice; `handleDeskMessage` stores the Trigger, calls `Team.createGroup` with `originTriggerId` (the Bots plugin reuses an existing room), and settles it: the group route, the `ignore` decision and the `group-created` notice in one transaction. `GROUP_REFERENCE_KIND` / `groupReferenceOf` / `groupByNameMention` / `handleDeskGroupCommand` also recognise `@已有群` plus DSH's paired `session-reference` event and settle it as routed, leaving the actual relay to the Bots plugin. Only a message that starts with `@` waits for that event (`GROUP_REFERENCE_WAIT_MS`); one that arrives later, within the Bots plugin's own window (`GROUP_REFERENCE_LATE_MS`), still settles it, so the supervisor and the group never both take the message; other messages and failures follow the original intake path |
| `src/app/group-routes.ts` | VsSaros addition (2026-11-06): the `group_route` table, which group chat a desk Trigger went to (`created` or `routed`, with the person's DSH message id). It links the two models: `deskFlow` reads it to show the group instead of a refusal, and the card follows the group's run by that message id |
| `src/app/staffing.ts` | VsSaros addition: `Staffing` and `StaffingStore`: a ticket's team in `person/staffing`, proposed by the main Session as versions with a fingerprint in `team_proposal`, sent to the conversation the ticket started in, agreed or refused only by a listed person's own later message on its Threads (or the panel); agreeing creates the drafted Bots and starts the worker with the team as its first note |
| `src/app/cli-check.ts` | VsSaros addition: `CliCheck`, local `lark-cli` diagnostics and confirmed maintenance for the Feishu Source |
| `src/client/cli-check.tsx` | VsSaros addition: the Feishu card's local/version checks and its two confirmed maintenance buttons |
| `src/app/setup.ts` | Setup, and `setupChanged`, whether a save changes a field setup reads |
| `src/app/passes.ts` | Passes, the pass scheduler |
| `src/app/outbox.ts` | The Outbox: the Engine's `Outbox` port, the receipts and the `reply` effects that send them. VsSaros fix (2026-11-06, as DeepSeek-Bot's durable outbox intents): a send's intent (`attempt`) is written before it starts; a send that timed out, was cut off (`maybeSent`) or was left half-done by a stop settles `unknown` and is never sent again by itself, only by a person (`POST replies/:id/redeliver`, listed per Source as `uncertain`) |
| `src/app/notices.ts` | The main Session's notices and relays: `eventNotice`, `reportRelay`, `resultRelay` and `followupRelay` |
| `src/app/store.ts` | The Store, and `Receipt`, a message of the outbox |
| `src/app/store-read.ts` | `storeReads`: the Store's read queries for the views, the tools and the Sources' polls, which never write |
| `src/app/migration.ts` | The schema 11 migration: one step from schema 10 that writes every stored record in its current shape |
| `src/app/effects.ts` | Effects |
| `src/app/versions.ts` | `Versions`: a record kept as numbered snapshots with a pointer to the current one, for the settings and the prompts |
| `src/app/cache.ts` | `TextCache`: texts kept in memory within a size, the least recently used dropped first |
| `src/app/settings.ts` | Settings |
| `src/app/review.ts` | VsSaros addition: `Reviews`, the gate in front of every P4 submit: a ready CL's review, its fingerprint check, the two submit modes, rejecting, discarding and the audit; only the management routes call it |
| `src/app/retrospective.ts` | VsSaros addition: `Retrospective` and `RetroStore` (`team_workflow`): reusable team workflows — a ticket's agreed team that succeeded as a workflow draft (or a credit to the saved workflow it reused), a person's save, a match score against a new request, a saved workflow's prefill of a proposal, and its TeamFlow export and import. 2026-11-06: the template skills a finished plan wrote (`onPlanEnd`, `team_skill`) are retired; skills are written only through `team_distill` → the memory system |
| `src/app/team.ts` | VsSaros addition: `Team` and `TeamStore` (`team_bot`, `team_approval`): the in-process team bus of VsSaros Bots (which also registers SuperAgent as an external Bot in the Bots roster), the roster ranked by need, group chats of Bots, and the Bots the supervisor creates (quota 3 per ticket, 20 in total) with high-risk drafts waiting for a person. 2026-11-06: the team plans it also ran are retired (`team-archive.ts`) |
| `src/app/usage.ts` | VsSaros addition (2026-11-06, P2, after DS Bot's usage ledger): `UsageLedger` records every model call of SuperAgent's own Sessions (main, desk, worker, step) in `usage_call` for 30 days, through one `llm/stream` listener (`meteredStream`, a re-sent call counted once) that also meters team steps for the token budget; `GET usage` |
| `src/app/steward.ts` | VsSaros addition (2026-11-06, P2, after DS Bot's steward): `ContextSteward` compacts the main Session and the desk with DSH's `compactNow` when they go idle past a check line (60% of the usable window, read from the ledger's last call and DSH's model info), then waits 10 minutes; DS Bot's switch-to-a-new-part branch is not taken (these Sessions keep their ids) |
| `src/app/coexist.ts` | VsSaros addition (2026-11-06, P3 · co-install): `coexistenceOf` reads the cordis loader for an enabled `ds-bot` entry; the overview says DS Bot shares the Host and which of its hooks reach SuperAgent's Sessions (secrets redaction, image reading, skills), and the log says so once |
| `src/app/team-archive.ts` | VsSaros change (2026-11-06, P1 · one track): `TeamArchive`: the retired team track — plans with their steps, Bots and exchanges, and template skills — copied once into `team_archive` and its five tables (`RETIRED_TEAM_TABLES`) dropped; read-only views for the panel (`GET team/plans`, `GET team/retrospective`) |
| `src/app/teamflow.ts` | VsSaros addition: the TeamFlow adapter: TeamFlow's project key (its `slugPath`), steps mapped onto its seven fixed stages with what is lost, an export that replaces only its own `sa-*` team in `teams.json` (with a backup, never over an unreadable file), and TeamFlow's teams imported as workflow seeds. It never runs a step: delegating a step to TeamFlow (`executor: "teamflow"`) is not done (decision 14 of `doc/superagent-framework-v2.html`, 2026-11-07), as such a step would bypass step approvals, the token budget, the distill evidence and the usage ledger |
| `src/app/settings-history.ts` | `policyHistory`: each saved settings revision with what it changed from the one before |
| `src/app/prompts.ts` | Prompts, `builtInParts`, the built-in parts a team may override, and `promptParts`, the order of a role's prompt sections |
| `src/app/context.ts` | The built-in prompt text, read from `prompts/`, and the transcript entries Sessions read |
| `src/app/skill-files.ts` | Packaged text: `promptFile`, which joins a file's one-sentence lines into paragraphs, and the bundled skills |
| `src/app/sessions.ts` | Sessions. VsSaros (2026-11-06): a step Session may use `WORK_TOOLS ∪` its Bot's tools (`stepToolAllowed`; masked when the Bot names them exactly, always guarded) and only report once the team's token budget is used; a coordinator Session (core `AssignmentRole`) gets its section and has `COORDINATOR_REFUSED` refused while a step is unfinished. A step that reported ready has every tool refused until it is sent back (real-machine run 2026-11-06: a message steered in after the report woke it to work again) |
| `src/app/delivery.ts` | `AgentDelivery`: delivers a message to a DeepSeek Harness agent once per request id, also across a restored Session |
| `src/app/distill.ts` | VsSaros addition: `Distiller`: each team step that ended ready or failed hands its evidence, once, to the VsSaros memory system through `Symbol.for('vssaros.memory')` (provided by @vssaros/dsh-agents): `skill` for a step of at least 3 turns, a failure or a retry, else `facts`; records in `team_distill`, retried while the memory system is absent or busy, and relays a person's decision on the skill draft it wrote |
| `src/app/desk-chat.ts` | VsSaros addition: `DeskChat`: the desk conversation the panel's Chat tab shows, a person's messages from the desk Thread's Triggers and SuperAgent's replies logged in `desk_log` as they are delivered to the desk, and a message from the panel received as a desk Trigger; the composer's attachments kept under `<stateDir>/desk-files` (10 MB each), and scheduled messages in `desk_schedule` (once, every day or weekdays) sent as the person's when due |
| `src/app/desk.ts` | VsSaros addition: the supervisor desk, a Session where a person talks to SuperAgent: its prompt, its one tool `superagent_submit` (which hands the person's latest message over word for word), and replies written back into the desk or an asking Bot's Session. 2026-11-06: a desk ticket's end comes back to the desk, as DeepSeek-Bot's answer comes back to whoever asked: on `ticket.ended` the Runtime sends a `ticket-ended:<ticket>:<at>` notice (`ticketEndedNotice`) through the desk outbox, and `deskReceiptStream` (`llm/stream`) answers a desk turn of nothing but such notices without the model: a call of `superagent_ticket_result`, drawn as the ticket's end card (`FlowCard receipt`), then one line (`receiptText`) that stays when DSH folds the turn. 2026-11-07: a desk turn of nothing but the person's own messages needs no model either (it cost ~6.8万 tokens a message): `deskReceiptStream` waits for the fast path to have handed the message over (`handedOver`, so it never races the group paths), makes the `superagent_submit` call itself (`SUBMIT_CALL_PREFIX`, which keeps the flow card), and after its result says where the message went (`submitLine` → `submitText`: the group it went to, the live ticket it reached, or that the supervisor has it). SuperAgent's news still goes to the desk's model |
| `src/app/retry-health.ts` | `RetryHealth`: which Sessions wait on a model budget retry, for the `models` health entry |
| `src/app/role-models.ts` | Resolves the Eval and Executor models, and seeds a new Session with its role's model |
| `src/app/assessment.ts` | The MasterAssessor, the assessment schema and the window `orchestrator_eval` answers. VsSaros fix (2026-11-06): an Eval's reads (cursors, message and image references, read pages) are kept in `eval_reads` until the Eval ends, so what the main Session was given still works after a restart |
| `src/app/execution-environment.ts` | The execution environment: its variables, a Ticket's values, the directory root and the lines of the prompt section, which `src/app/prompts.ts` fills into its template |
| `src/app/source-context.ts` | `sourceContextOf`: each Source kind's `SourceContext` |
| `src/app/links.ts` | `sourceLink`, the page of a Trigger's message, and `candidateCard` |
| `src/app/cards.ts` | Compact cards of Triggers, Tickets, Threads and Decisions for models, the closed set of ticket card states `TICKET_STATES`, and `textPage` |
| `src/app/resources.ts` | `RESOURCES` and `readResource`: what `orchestrator_read` reads, for each role |
| `src/app/tools/tool.ts` | The `Tool` type, `readTool`, the `orchestrator_read` of both roles, and `AcknowledgementSchema` |
| `src/app/tools/main.ts` | The main Session's tools, including the VsSaros team tools |
| `src/app/tools/team.ts` | VsSaros addition: the main Session's `orchestrator_team_*` tools: list Bots (and saved workflows fitting a ticket), make a group chat, create a Bot (kept from the main Session: `CONSENTLESS_TOOLS`), and a ticket's team: propose (prefilled from a saved workflow), confirm, refuse. 2026-11-06: `orchestrator_team_plan`, `_status` and `_stop` are removed |
| `src/app/tools/executor.ts` | An Executor Session's tools |
| `src/app/http.ts` | The `/orchestrator/api` routes: the same-origin check, request limits and one status per kind of failure |
| `src/app/tapd-webhook.ts` | VsSaros addition: the optional TAPD Webhook ingress: event records, the shared-secret check, replay deduplication, rereading an item and matching it to a watch |
| `src/app/api.ts` | `Api`, every route with its parameters, query, body and response, and the filters of the lists; it imports only types, so the panel bundles it |
| `src/app/views/text.ts` | The two forms of a view's text: `preview`, plain text on one line, and `markdown` without HTML; `plain` and `readable` |
| `src/app/views/records.ts` | The rows the views share: Triggers, Tickets, Threads, Decisions and Channel links, and `ownersOf`, the owners of follow-ups as one request reads them |
| `src/app/views/tickets.ts` | The Ticket lists by stage, a Ticket's page, the Mandate basis facts and the Executor's load |
| `src/app/views/threads.ts` | The Thread lists, a Thread's timeline, the search and the Decision list |
| `src/app/views/sources.ts` | The Source status: each Source instance's state, its last day's counts, and what it filtered and dropped in that day |
| `src/app/views/settings.ts` | The settings page's view: each block with its revision, each Source's settings with its kind's form, and the execution environment |
| `src/app/views/overview.ts` | The overview: Tickets that need a person, problems, the last day's flow and the Executor's load |
| `src/executor/dsh.ts` | The DshExecutor, `WorkerSlots`, `ticketExecution`, `inputMessage` and `mandateInstructions` |
| `src/executor/background.ts` | A worker's background work in DeepSeek Harness, the shell jobs its Session owns (`ctx.jobs`) and its subagents (`ctx.subagents`): `runningJobs`, `untilQuiet`, `killJobs`, `collectJobs`, `stopSubagents`, `stopBackground`, `until`, and `cancelled`, the workers whose turn a stop of their subagents cancelled |
| `src/infra/commands.ts` | `Commands`, the CLI transport: `run`; `api` and `pages`, limited to the configured repository and validated; `lark` as the bot; `git`. `CliError` carries the code a command's output reports, such as a GitHub HTTP status, and a command that prints nothing fails with how it ended, never with its arguments; `validItems` skips and counts the malformed items of a list |
| `src/infra/environment.ts` | The agent's process environment: command shims, the git configuration and credential helper, `runAsWorker`, and the checks of the environment and of a Ticket's directory |
| `src/infra/paths.ts` | The package's root, where packaged files are (`@vssaros/dsh-superagent`, or the upstream `dsh-superagent`) |
| `src/infra/host.ts` | VsSaros addition (built-in packaging): what is taken from DSH at run time without importing DSH packages at load: Cordis's `Service` base rebuilt on its `Symbol.for` keys, dsh-llm's `MessageId`, `ReasoningEffortId` and `freezeMessage`, and the Host's own `@deepseek-ai/dsh-scope` (`scopeParentOf`), loaded by `apply` from the Host's entry script; the build (`scripts/build.mjs`, writing the shipped `../lib` of the built-in `dsh-plugins/vssaros-superagent`) bundles zod, proper-lockfile and schemastery |
| `src/infra/text.ts` | Word counts and the chat message limit, `fill` and `sameName` |
| `src/infra/health.ts` | The `HealthBoard`, every part's health entry, each claimed by its one writer. VsSaros fix (2026-11-06): entries are written to `health_entry`; an error reported before a restart is shown after it (`restored`) until its part reports again |
| `src/sources/kind.ts` | The `SourceKind` protocol |
| `src/sources/registry.ts` | `SourceRegistry` |
| `src/sources/host.ts` | `SourceHost`, `SourceContext`, `Health`, `health` and the fixed health texts |
| `src/sources/poll.ts` | What GitHub and Feishu polling share: `POLL_HORIZON_MS`, `polled`, `cursorAt`, and `pollThreads`, which keeps a failure on its Thread as `pollError` |
| `src/sources/github.ts` | The GitHub kind and plugin entry, exported as `./github-watch`: a poll round of notifications, the pull requests of open Tickets with their CI, and subscribed Threads |
| `src/sources/github-trigger.ts` | GitHub comments, reviews, Issue bodies and CI changes as Triggers, and GitHub addresses |
| `src/sources/github-pull.ts` | The pull request rules: which pull requests a Ticket follows (`claimPull`, `observePull`), the closes it reports to the Engine, and `pullEndNotices`, the chat notice of a Ticket that ended merged or closed |
| `src/sources/github-channel.ts` | The GitHub Channel: comments and review thread replies, `sent` or `gone` |
| `src/sources/github-read.ts` | CI snapshots, repository reads, the `github/` resources, and `githubThreadContext`: an Issue's or pull request's conversation by page |
| `src/sources/feishu.ts` | The Feishu kind and plugin entry, exported as `./feishu-watch` |
| `src/sources/feishu-trigger.ts` | Feishu messages as Triggers, by one rule for live events, history pages and topic pages |
| `src/sources/feishu-loops.ts` | The Feishu loops: the event consumer, history recovery, chat names and polling of subscribed topics |
| `src/sources/feishu-channel.ts` | The Feishu Channel: topic replies, `sent` or `gone` |
| `src/sources/tapd.ts` | VsSaros addition: the TAPD kind and plugin entry, exported as `./tapd-watch`: watches of single items and lists, their Triggers, comment polling of subscribed items, and comment replies |
| `src/sources/tapd-api.ts` | VsSaros addition: `TapdApi` over TAPD's Open API or the `tapd` MCP server through `mcporter-internal`, the envelopes it strips, and TAPD times and links |
| `src/sources/tapd-members.ts` | VsSaros addition: WeCom alias to TAPD Chinese name mapping, trailing-semicolon cleaning, and a 12-hour cache of saroasis-platform's member table |
| `src/sources/tapd-auth.ts` | VsSaros addition: TAPD Open API credentials aligned with SaroasisStudioSystem — five credential sources by priority, a lazily-read whitelisted `tapd.env`, a configurable request timeout, and the masked status and save the TAPD card's credentials panel uses (written to that file, never to the settings) |
| `src/client/tapd-credentials.tsx` | VsSaros addition: the TAPD card's Open API credentials panel — status (environment / file / none, credential in use, masked account, file path), kind (API account, API user, token), save and confirmed clear |
| `src/sources/feishu-profile.ts` | VsSaros addition: a lark-cli profile per Feishu app — when the Feishu Source names an app (`appId`) that has no profile, setup adds a bot-only one from the secret the VsSaros Bots keep for it, passing the secret on stdin only; every Host call and the workers' shim then select that profile with `--profile` |
| `src/sources/feishu-share.ts` | VsSaros addition: one Feishu connection per app — a read-only check that the app is not already held by the VsSaros Bots inbound in another process (per-app and legacy `~/.vssaros-im-feishu*.lock`), recognition of lark-cli's exit code 2 when another event bus holds it, and the in-process event bus of vssaros-agents (`Symbol.for('vssaros.feishuEvents')`) with the conversion of its raw v2 events into the `event consume` shape, so the Source listens through the Bots connection when both run in one Host |
| `src/sources/p4.ts` | VsSaros addition: the p4 kind and plugin entry, exported as `./p4-watch`, which polls the changelists open Tickets follow |
| `src/sources/superagent.ts` | VsSaros addition: the `superagent` kind, which the Runtime registers itself: the supervisor desk (a listed person's message is explicit; the person at this machine is listed by default) and VsSaros Bots asking for help (inferred, from the `bots` list only), with replies back into their Sessions |
| `src/sources/p4-change.ts` | VsSaros addition: the changelist rules, a CL as a Ticket's own Thread (`claimChangelist`, `observeChange`), `p4 -Mj` reads and the shelf `fingerprint` |
| `src/sources/feishu-read.ts` | The `feishu/` reads of a Trigger's message, its root, parent and topic, and `feishuThreadContext`, which gives them to assessments with their images |
| `src/sources/admission-context.ts` | The bounded window an assessment starts from: the first pages of a Trigger's Thread, read through its kind, and the messages around the Trigger |
| `src/sources/feishu-image.ts` | Reads a Feishu message's image as an attachment for the assessing Session |
| `src/client/index.tsx` | The client plugin entry: the sidebar entry, the main panel and the page in DeepSeek Harness's Plugin Manager |
| `src/client/app.tsx` | The panel: header, search, glossary, tabs and the page of the current route; VsSaros change: beside it the side panel with the Overview, opened from the header |
| `src/client/chat.tsx` | VsSaros addition: the Chat tab, the supervisor desk's conversation: in a VsSaros workbench, DSH's own chat of the desk Session that the workbench host docks (`props.conversation`, `service.ensureSession`), whose messages reach the supervisor as they arrive; elsewhere the panel's own drawing, with the person's messages (and why one was not handed over), SuperAgent's replies, quick replies on a team proposal that waits, and the composer |
| `src/client/composer.tsx` | VsSaros addition: the Chat tab's composer after DeepSeek-Bot's: one rounded row with a "+" menu (add files, which go to `desk/files`; reference a chat, which names a Thread; a scheduled message), the draft, dictation through the browser's speech recognition, and the voice-chat button the send button replaces; and voice chat, which listens, sends, reads the answer aloud and listens again |
| `src/client/side.tsx` | VsSaros addition: the side panel with the Overview: open state and width kept across loads, resized from its left edge, and opened by itself when the supervisor starts new work (a new proposal version, a team's steps beginning, or a step's request for the person) unless that work was shown before |
| `src/client/work.tsx` | VsSaros addition (plan C): the teams at work, kept current by the change stream (polled every 2 s while a step runs and the stream is down): a step's request card (allow once, allow and remember, refuse), each team's members with their Bot marks, what they do now, for how long and a stop button, a small flow chart, and the Workbench tab with a team's dependency graph (pan, zoom, glow on what runs, attempts on one card), a board by state, a list, and a step's details; it also mounts the live group-run section below |
| `src/client/group-runs.tsx` | VsSaros addition (2026-11-05): a read-only live section for group-chat relays in the Workbench and Execution tabs. It reuses the chat-surface `vssaros-group-progress` window event and `window.__vssarosGroupProgress`, maps `?active=1` rounds into group name/state/member pills/reply count/elapsed/latest status, and does not alter orchestrator Ticket, Step, Executor or SSE semantics |
| `src/client/feed.ts` | VsSaros addition (plan C): the change stream on the page: one `fetch`-read connection while anything listens, reconnecting with backoff; `useLive` reads data again when its topics change, polls while the stream is down (every minute while up), and reads everything again after a reconnect. 2026-11-07: `disposeFeed` ends the stream, its reconnect timer and its listeners when DSH disposes the client plugin (`apply` → `ctx.effect`; DSH's client has no `import.meta.hot`, a reload loads a new copy of the module) |
| `src/client/characters.ts`, `src/client/mark.tsx` | VsSaros addition (plan C): the Bots' marks, ported from DS Bot (Apache-2.0; see NOTICE): 20 characters with eyes cut out, a look from the Bot id, the supervisor's whale; states idle, thinking, searching, working, sending, waiting, alert and done, each with its motion (`dt-bm-*` keyframes), blinks and fidgets at rest on list marks, a settle squash, and the "?" and working badges |
| `src/client/flow-card.tsx` | VsSaros addition (plan C): the key-node card that DSH's chat of the desk draws for the desk's `superagent_submit` call (`tool.call.toolview`): from the trigger in its result, the message's state live from the change stream: evaluating, declined, the ticket, the proposal with agree and refuse, the team at work with its flow, requests and members, and how it ended. `CardProvider` (in `provider.tsx`) gives a card outside the panel the API and translator and adds the panel's styles to the page once |
| `src/client/provider.tsx` | What every page reads from its host: copy, calls, navigation, notices, the state poll, and `restart`, which reads the state quickly while dsh-superagent restarts |
| `src/client/api.ts` | Calls and polls of the management API, typed by `src/app/api.ts`, and the Decision filters of the Eval status |
| `src/client/route.ts` | The tabs, the settings groups, the typed routes that `parseRoute` reads, and the route memory with the settings group opened last |
| `src/client/overview.tsx` | The overview |
| `src/client/source.tsx`, `trigger.tsx`, `eval.tsx`, `execution.tsx` | One file per stage: its status, and its settings where it has some |
| `src/client/thread.tsx`, `ticket.tsx` | The record pages: a Thread with its timeline, and a Ticket with its authorization, Inputs and Assignments |
| `src/client/review.tsx` | VsSaros addition: a ticket's changelist review (every file's difference, the confirmation, approve, send back and discard) and the Overview's waiting reviews |
| `src/client/team-plans.tsx` | VsSaros addition: the Overview's team work: steps' requests and teams waiting for a person, open team tickets' steps, the memory system's skill drafts, saved workflows (save, run as a desk request, TeamFlow), the high-risk Bot drafts a person approves or rejects, and, read-only, the archived team plans and the count of archived template skills |
| `src/client/usage.tsx` | VsSaros addition (2026-11-06): on the execution page, the usage ledger's last day and week by role, model and Bot with the context steward's last work, and team Bots' approval rules: templates given to a Bot at once, and each rule deleted |
| `src/client/settings.tsx` | The Settings tab: the group navigation and the group on screen |
| `src/client/settings-kit.tsx` | The building blocks of settings blocks: the settings the stage groups share, `useBlockDraft`, the fields, among them a Source kind's, and the history of saves |
| `src/client/prompts.tsx` | The Prompts settings: the page owns the view it read and its editor the draft, and the Edit, Full prompt and History tabs render from them; a built-in part's editor shows a changed default and keeps or drops the override |
| `src/client/prompt-config.ts` | The prompt configuration by section, by the team sections, skill names, built-in parts (`part/<key>`, with `withOverride`) and part headings the prompt views give, and the line diff of the full prompt, as pure functions |
| `src/client/deployment.tsx` | The Deployment settings, also shown in DeepSeek Harness's Plugin Manager |
| `src/client/draft.tsx` | Settings drafts: `draftReducer`, their states and their merge with a newer saved revision, `saveBarText`, the save bar's line, and the save bar |
| `src/client/controls.tsx` | Local copies of DeepSeek Harness's controls, which follow its markup, keyboard behaviour and design tokens, since the bundle does not import `@deepseek-ai/dsh-client-ui-primitives`; they read no context |
| `src/client/widgets.tsx` | The small components the pages share, which read the panel's context: sections, page heads, load states, times, links, confirmed actions, the setup check and Markdown |
| `src/client/rows.tsx` | The rows the pages share: a Ticket, a Thread and a Decision, a Thread's chip, and the folding of runs of automated messages |
| `src/client/markdown.ts` | The Markdown subset of reports and questions, and the bare addresses in messages, as blocks and inline parts |
| `src/client/text.ts` | Copy by key and the wording of domain values, reasons, senders and times |
| `src/client/marks.ts` | The marks of the states the views classify: a Ticket's or a Thread's stage, a Source's state and a Decision's outcome, each as a dot, an icon, a tone and a label |
| `src/client/locales.ts` | All copy in both languages, and the glossary of [001 Domain model](001-domain.md) |
| `src/client/client.css`, `css.d.ts` | The panel's stylesheet, loaded as text |

`src/sources/github.ts` and `src/sources/feishu.ts` are also the entries of the two Source plugins, built by `tsdown.config.ts` and exported in `package.json` as `./github-watch` and `./feishu-watch`. The bundle's `cordis.patch.yml` inserts the three plugins, with Feishu disabled.

### TAPD Webhook ingress (VsSaros addition)

TAPD's Open Platform can POST a flat event record (`event`, `workspace_id`, `id`, `event_id`/`queue_id`, `secret`, `created`) as JSON or form data. `src/app/http.ts` splits `/orchestrator/webhook/tapd` off from `/orchestrator/api/` before the same-origin check: it is a server-to-server call authenticated by the configured shared secret, not a browser call. `src/app/tapd-webhook.ts` verifies that secret in constant time, takes `event_id` (else `queue_id`, else a digest) as the idempotency key bounded by `KV.tapd.webhookSeen`, rereads the item through `TapdApi.items(..., { id })` because the event carries only IDs, and receives one Trigger only if the item still matches a watch's workspace, type, item ID, status, owner and iteration. Deletions, comments and every unsupported event answer 200 with an `ignored` reason so TAPD does not retry them. The item is recorded in an existing watch state but the read cursor is left to polling: TAPD's Webhook does not replace `pollRound` or `pollComments`, which still own comment follow-up and recovery after a missed delivery. The Web server listens on `127.0.0.1`, so a cloud TAPD needs an intranet gateway or reverse proxy; the switch is off by default and a half-configured secret is reported as `tapdWebhookUnset` health. TAPD's developer console probes a configured URL before saving it: GET, HEAD and empty bodies answer 200 `{ok: true}` without reading the Source, while every request carrying event fields still goes through the secret check. The console accepts `application/json` (recommended, since a 19-digit ID stays a string) or `application/form` (x-www-form-urlencoded); its optional gateway Token belongs to the application gateway, not to this endpoint. TAPD documents that the event carries IDs only and recommends rereading the item through the API, which is what the ingress does.

### TAPD Open API credentials (VsSaros addition)

`src/sources/tapd-auth.ts` mirrors SaroasisStudioSystem's `.env` contract (`lib/tapd.js`, `.env.example`). `TapdOpenApi.authorization()` accepts five sources in priority order: `DSH_SUPERAGENT_TAPD_BEARER`; `DSH_SUPERAGENT_TAPD_USER` + `DSH_SUPERAGENT_TAPD_PASSWORD`; `TAPD_CLIENT_ID` + `TAPD_CLIENT_SECRET` (the recommended enterprise API account: full permissions, no token exchange and no IP allowlist); `TAPD_API_USER` + `TAPD_API_PWD`; `TAPD_API_TOKEN`. The first two are native to this Host, the last three let an existing platform `.env` be reused. Credentials may also live as `KEY=VALUE` in `<DSH_HOME>/tapd.env`, or `DSH_SUPERAGENT_TAPD_ENV_FILE` points at an existing file; the file is read lazily (never at module load), only whitelisted TAPD keys are taken, and it never overrides the process environment. Requests carry `Accept: application/json` and use `TAPD_HTTP_TIMEOUT_MS` / `DSH_SUPERAGENT_TAPD_TIMEOUT_MS` with a 3s floor. None of these values reach the Executor's worker environment.

## Tests

VsSaros (2026-11-06): each test and hook may take 15 s (`vitest.config.ts`), and `scripts/test-gate.mjs` (in the repository's
`check:dsh-plugins`, run alone) runs every spec below in parallel and fails on any failed test, any error outside a test, any
spec that did not run, or a checkout without `dev/node_modules`. Runtime tests answer the sandbox probe themselves
(`testMachine` → `sandboxProbe`), so write steps behave the same on every machine.

| Test | Covers |
| --- | --- |
| `tests/usage.spec.ts` | VsSaros addition (2026-11-06): the usage ledger (own Sessions only, sums, 30 days, one listener for ledger and token budget), the context steward's idle compaction (check line, cooldown, unknown window), and approval rule templates with chained lines never covered |
| `tests/coexist.spec.ts` | VsSaros addition (2026-11-06): DS Bot found through the loader's `ds-bot` entry and said on the overview; a step call another listener sends again is metered once |
| `tests/dsb-coexist.spec.ts` | VsSaros addition (2026-11-07, P0 · co-install semantics): with a DS Bot made as ds-bot 0.2.7 acts on every Session (`tests/fixtures/ds-bot.ts`), loaded before or after SuperAgent: ① each model call is counted once in `usage_call` and a team's token budget, a call DS Bot sent again (`resent`) or made on the side (`side`, its OCR) is marked and shown on GET usage and a ticket's page, and `executor.sideCalls` off refuses side calls in SuperAgent's Sessions only; ② a step's tool call is still decided by `step_approval_rule`, never by DS Bot; ③ its global skills stay out of SuperAgent's prompt sections and skills and out of every desk request (`deskWithoutCatalog`), and add at most 800 characters to a catalog; ④ `team_distill` evidence is of the step that ran. Its real-machine case: `dev/scripts/e2e-dsb-coexist.mjs` |
| `tests/notice.spec.ts` | VsSaros addition (2026-11-06): every source file naming a `ds-bot/src/` file it adapts is listed in NOTICE, NOTICE names only existing files, and the package declares `MIT AND Apache-2.0` |
| `tests/schema-tables.spec.ts` | VsSaros addition (2026-11-06): the 25 tables the orchestrator database holds after a start, none of the retired team track; its plans read-only through `GET team/plans`, no `POST team/plans` |
| `tests/core-engine.spec.ts` | Domain rules on in-memory repositories: receiving, Eval, fan-out, resume and stop, interrupted Assignments, the pause, Policy changes, reports and outcomes, attaching, replies, failed deliveries and dismissed problems |
| `tests/state-lock.spec.ts` | VsSaros addition: reclaiming an orphaned state-directory lock, refusing a second Runtime, and falling back to a stale mtime |
| `tests/cli-check.spec.ts` | VsSaros addition: CLI discovery, partial probe failures, the update check and the confirmation gate on write actions |
| `tests/stage.spec.ts` | The Ticket stages, row by row |
| `tests/vssaros-patches.spec.ts` | VsSaros patch set: Windows state directories, PATHEXT lookup, `.cmd` worker shims run through cmd.exe and PowerShell, Git for Windows origins, and a deployment without a GitHub account |
| `tests/cli-argv.spec.ts` | VsSaros addition: resolving an npm `.cmd` launcher to `node <script>` with real temporary files, the TAPD MCP resolver's error type, and guards that the Feishu consumer and `Commands.lark` never spawn the launcher directly |
| `tests/p4.spec.ts` | VsSaros addition: `p4 -Mj` records and errors, reading changelists, depot path patterns, the shelf fingerprint, and binding and ending a Ticket's CL |
| `tests/tapd.spec.ts` | VsSaros addition: TAPD envelopes, times and links; the Open API and MCP access with stand-ins; the TAPD Source's watches, comments, replies and variables in the runtime; the notice of a submitted CL; workspace inheritance, alias mapping and the `current_owner`/`page`/semicolon/Hello-world guards |
| `tests/tapd-webhook.spec.ts` | VsSaros addition: TAPD Webhook event records (flat, nested, form), the secret and replay checks, watch matching, rereads, idempotent intake and the unchanged poll cursor, all against stand-ins |
| `tests/tapd-auth.spec.ts` | VsSaros addition: five TAPD Open API credential sources by priority, a real temporary `tapd.env` with quotes/comments/whitelist, no override of the process environment, JSON accept header and the timeout floor |
| `tests/tapd-credentials.spec.ts` | VsSaros addition: the panel's TAPD credentials against real temporary files — masked status without secrets, the environment winning, every credential key replaced while other lines stay, a kept secret, refused values, clearing, and the panel and route wiring |
| `tests/feishu-profile.spec.ts` | VsSaros addition: the Feishu Source's app as a lark-cli profile against an in-memory lark-cli (active profile when unnamed, existing profile by app then name, a profile added from the Bots' secret, missing app, failed add, wrong app, user identities), `--profile` in the Host argv and the worker shim, the secret on stdin only through a real child process, and where the Bots keep secrets |
| `tests/feishu-share.spec.ts` | VsSaros addition: the Bots inbound holder of a Feishu app from real temporary lock and credentials files (same app, other app, stale, dead, unreadable, release fallback, per-app lock, read-only), lark-cli's bus-taken exit, the shared bus shape, raw v2 events converted into the consumer shape, and that the checks run before the consumer starts |
| `tests/p4-guard.spec.ts` | VsSaros addition: the workers' p4 guard run for real against a stand-in p4, and on Windows through the `p4.cmd` shim from cmd.exe and PowerShell |
| `tests/panel-review.spec.tsx` | VsSaros addition: the panel's changelist review, from the Overview and the ticket's page: every file opened before approving, the fingerprint sent, refused approvals, sending back and discarding |
| `tests/review.spec.ts` | VsSaros addition: the review gate through the management routes against a simulated P4 server: requests, fingerprint checks, both submit modes, rejecting, discarding, and no agent tool that submits |
| `tests/retrospective.spec.ts` | VsSaros addition: the retired team track archived once into `team_archive` (its five tables dropped, a running plan archived as cancelled, idempotent), one path that writes skills, and a saved workflow's match and prefill |
| `tests/team.spec.ts` | VsSaros addition: the team bus against real temporary databases and a fake bus: its shape, one track (no plan tools, two `team_*` tables, an older subscription disposed), creating Bots (duplicate, high-risk approval, quota) and group chats |
| `tests/policy.spec.ts` | Source scope, the gate, the admission table, Mandate revalidation, the Policy version, settings migrations and assessment outcomes |
| `tests/registry.spec.ts` | `SourceRegistry`: instances, validation, Policy parts, Channels and Thread context |
| `tests/sources.spec.ts` | The Feishu and GitHub Sources on a `SourceContext`: translation, polls and read positions, the pull request rules, health |
| `tests/staffing.spec.ts` | VsSaros addition: team staffing on the fake Host: an accepted ticket waits in person/staffing with no worker, proposals as versions sent to the conversation, agreement only from a listed person's later message to the current version, refusal as dropped, the panel's agreement, drafted Bots created only once agreed, low-risk auto-approval off by default, and invalid proposals refused |
| `tests/steps.spec.ts` | VsSaros addition: an agreed team's steps on the fake Host: step Sessions under their Bots' presets once the lead runs, dependencies and upstream reports, one writing step at a time, a read-only step's guard, a failed step tried once more then skipping what waits for it, a turn ended without a report, the lead's message to a blocked step, the lead's ready refused until every step finished, and every step stopped with its ticket |
| `tests/step-approvals.spec.ts` | VsSaros addition (plan C): replies, command heads and paths; the Windows sandbox probe; a read step read-only and its requests refused; a write step's request waiting in the panel and on Feishu, answered there and by a Feishu reply, remembered, and cancelled with its turn; one step stopped from the panel |
| `tests/superagent-desk.spec.ts` | VsSaros addition: the Runtime's supervisor desk on the fake Host: the desk Session with its one tool, the registered superagent Source, and a desk message that reaches the main Session only from a listed person; the panel's Chat messages taken as the desk's, replies to the desk logged once, and why a message was not handed over |
| `tests/superagent-source.spec.ts` | VsSaros addition: the superagent Source and the supervisor desk: switches and admission rows, desk and Bot Triggers, the gate for the listed person, listed and unlisted Bots, the channel, the desk's one tool and replies back into Sessions |
| `tests/commands.spec.ts` | CLI calls as the deployment's accounts, the Channels' answers, and repository-scoped GitHub calls |
| `tests/feishu-read.spec.ts`, `tests/github-read.spec.ts` | Feishu and GitHub reads |
| `tests/admission-context.spec.ts`, `tests/feishu-image.spec.ts` | The Thread window of assessments, and Feishu image reads |
| `tests/assessment.spec.ts` | What the MasterAssessor keeps per Eval, and when it lets go |
| `tests/background.spec.ts` | Waiting for a worker's shell jobs and subagents: an end that woke it, and a host that stops |
| `tests/bundle-patch.spec.ts` | The bundle's patch, read as DeepSeek Harness reads it, and the agent preset of Executor Sessions it defines |
| `tests/effects.spec.ts` | The effect queue: coalescing, limits, retries with backoff, health and shutdown |
| `tests/passes.spec.ts` | Passes: one at a time, the ones asked for during a pass run as one after it, and the runtime health a failed pass reports |
| `tests/outbox.spec.ts` | The Outbox on a running Runtime: messages wait while processing is paused or their Source is not installed |
| `tests/cache.spec.ts` | `TextCache` |
| `tests/queue.spec.ts` | The Runtime's work through the effect queue, and what earlier versions stored |
| `tests/followups.spec.ts` | A person's follow-up on a Ticket's Thread: its notice to the main Session, the tools that act on it, what a burst costs; a worker's hand-back and context follow, and the main Session's note |
| `tests/health.spec.ts` | One health entry per part, each cleared by its own next success |
| `tests/delivery.spec.ts` | `AgentDelivery` |
| `tests/distill.spec.ts` | VsSaros addition: team step evidence on the fake Host with a fake memory bus: the skill/facts thresholds, one handover per finished step with its Bot, failures and request, evidence kept while the memory system is absent or busy and delivered later, none for a stopped ticket's unfinished steps, and a person's decision on a skill draft relayed from the panel |
| `tests/retry-health.spec.ts`, `tests/role-models.spec.ts` | Model budget retries, and the models of the two roles |
| `tests/runtime.spec.ts` | The whole application on a simulated DeepSeek Harness host, through tools and HTTP |
| `tests/tools.spec.ts` | The Sessions' tools: what `orchestrator_read` reads for each role, and the shapes and checks of the other main Session tools |
| `tests/runtime-concurrency.spec.ts` | Work that overlaps: Triggers during a pass, Tickets that change during deliveries and launches |
| `tests/http.spec.ts` | The same-origin and loopback checks, the status of each kind of failure, the body limit, path parameters and queries |
| `tests/settings.spec.ts` | Settings saves that race a model or account check, a Policy sync that a save outran, and the refusals of the pause, a sync and a block |
| `tests/views.spec.ts` | What the management views derive from the Store, such as the Thread a dropped message belongs to |
| `tests/workflows.spec.ts` | VsSaros addition: team workflows: TeamFlow's project key and stage mapping with what is lost, an export that keeps every other team and never overwrites an unreadable file, TeamFlow's teams imported as seeds; on the fake Host a succeeded ticket's team as a draft, a saved one offered and prefilling a matching ticket's proposal that still needs agreement and is credited when it ends, and the refusals |
| `tests/timeline.spec.ts` | A Thread's pages and a Trigger's neighbours by time and then id, with every received Trigger's time in one form |
| `tests/migration.spec.ts` | The schema 11 migration: every stored record in its current shape, and the refusal of older schemas |
| `tests/store.spec.ts` | Repositories and their working sets, in SQLite as in memory, the kv area, with every key of `KV` spelled only in `src/kv.ts` and the migration, settings history and queries |
| `tests/prompts.spec.ts` | Prompt validation, assembly and versions |
| `tests/cards.spec.ts` | The rules the built-in text must state, file by file |
| `tests/model-surface.spec.ts` | Everything models read: tools, prompts, skills and inputs, checked against the tool schemas, the execution environment and the glossary, within a size budget per role |
| `tests/deployment.spec.ts`, `tests/environment.spec.ts`, `tests/index.spec.ts` | The plugin configuration and setup, the agent's process environment, the plugin entry |
| `tests/service-script.spec.ts` | `scripts/dsh-superagent` against fake `ps`, `tmux` and `dsh` |
| `tests/client.spec.tsx`, `tests/navigation.spec.ts`, `tests/controls.spec.tsx` | The client plugin's registration and polling, Session navigation and route memory, the local controls, and the panel's imports, which have no cycle |
| `tests/panel-overview.spec.tsx`, `panel-source.spec.tsx`, `panel-trigger.spec.tsx`, `panel-eval.spec.tsx`, `panel-execution.spec.tsx` | Each page of the panel, against a fake management API answered by route |
| `tests/panel-chat.spec.tsx` | VsSaros addition: the Chat tab and the side panel: Chat first, the Overview in the side panel and its header buttons, open state and width kept, the desk conversation with quick replies and the composer, and the side panel opening by itself for new work only |
| `tests/panel-work.spec.tsx` | VsSaros addition (plan C): a team laid out by its dependencies; the side panel opening for a step's request, first, and answered there, with members' current work; the Workbench tab's flow, board and list, a step's details, its Bot's Session and stop |
| `tests/panel-flow-card.spec.tsx` | VsSaros addition (plan C): the trigger read from the hand-over result, stream frames, marks from what a Bot does; the key-node card evaluating, then the ticket and its proposal live from the stream, agreed from the card; the team at work with marks, a request answered from the card, and the ending; a follow-up and a declined message; the Workbench read again when the stream says steps changed |
| `tests/feed.spec.ts` | VsSaros addition (plan C): change events gathered per moment, the open comment and heartbeat, closed pages dropped, and every stream ended on stop |
| `tests/desk-outbox.spec.ts` | VsSaros fix (2026-11-05): which messages wake the desk; a message written down first and counted delivered once the desk's conversation records it; delivered again, oldest first, after a restart or the desk closing, never what it has; a failed delivery kept pending and not overtaken |
| `tests/group-fast-path.spec.ts` | VsSaros P0 (2026-11-05): group requests are distinguished from commands to an existing group; suitable Bots and a derived name/notice; the desk makes the group and settles it (route, `ignore`, notice) in one step, then drives a pass; duplicates keep one `originTriggerId`; a failed Bots plugin falls back to the model path; `session-reference` / plain `@群名` are recognised and settled as routed at intake (a late reference is marked), while unrelated references fall back; only `@` messages wait for a reference |
| `tests/group-contract.spec.ts` | VsSaros addition (2026-11-06): the group-run contract (`dsh-plugins/contracts/group-activity.schema.json`) read the way this panel reads it: version, status words and labels, a contract example kept intact, and every field the panel reads named by the contract. The writer side is checked against the same file in `dsh-plugins/check-bots-rooms.mjs` |
| `tests/panel-composer.spec.tsx` | VsSaros addition: the Chat tab's composer: the voice button the send button replaces, the "+" menu, a chat reference, attachments kept and named in the message, a scheduled message listed and deleted, dictation and its notes, and voice chat on faked speech recognition and synthesis |
| `tests/panel-settings.spec.tsx`, `panel-prompts.spec.tsx`, `panel-deployment.spec.tsx`, `panel-panel.spec.tsx` | The settings groups, drafts and history, the prompts, the Deployment page, and the panel's search, glossary and route memory |
| `tests/draft.spec.ts`, `tests/prompt-config.spec.ts`, `tests/markdown.spec.ts`, `tests/marks.spec.ts` | Draft states, merges and the save bar's line; the prompt configuration by section and the line diff; the Markdown subset and its links; the mark of every state the views classify |
| `tests/locales.spec.ts`, `tests/styles.spec.ts` | The copy in both languages, the stylesheet |
| `tests/class-docs.spec.ts` | Every class in `src` has a JSDoc block before it |
| `tests/docs.spec.ts` | Numbered documents link only to earlier ones, every local link resolves, no document has merge conflict markers, and this document's tables list every module and every test |

`tests/fixtures/` holds what several tests share: `host.ts`, a simulated DeepSeek Harness host; `panel-server.ts` and `panel.tsx`, the fake management API and the panel around a page; `deployment.ts`, a resolved deployment; `git.ts`, the environment of every git the tests start, which names no repository; and `async.ts`.

## Persistence

One SQLite file, `<stateDir>/orchestrator.sqlite`, which only the Store opens.

| Table | Holds | Written by |
| --- | --- | --- |
| `trigger` | Each Trigger, its time `at` in the one form `Date#toISOString` gives, set when the Engine receives it, so times compare as text | Engine |
| `disposition` | Where each Trigger went: `filtered` with the Source's reason code, its Eval and Decision, the Tickets it reached, by fan-out or attachment, whether it was requeued, the Tickets that handed it back with their reasons, and those whose Executor acknowledged or answered it | Engine |
| `trigger_thread` | Which Threads each Trigger is on, with its time and whether a person wrote it, so a Thread's Triggers are read without scanning every Trigger, in order of time and then id: a page of a Thread's timeline continues from a `<at>|<id>` cursor, and Triggers that share a time are not skipped | Store, with each Trigger |
| `thread` | Threads: Subscriptions, the Tickets that follow it for context, queued Triggers, the Eval in progress, the count of its expiries and `meta`; the generated columns `active`, set while Triggers are queued or an Eval runs, and `subscribed`, its Source while a Ticket subscribes to it | Engine; Sources write `meta` |
| `ticket` | Tickets with their Mandate, origin, execution, Assignments, Channels, Inputs and the Threads they follow; the generated columns `open`, set while it has not ended, and `active`, set while Inputs are undelivered or the latest Assignment is pending or running | Engine |
| `decision` | Decisions, by Thread | Engine |
| `effect` | The effect queue: per kind and key, the payload, its order, failed attempts with the last error, and when it is due | Effects; the schema 11 migration queues what earlier versions kept for the main Session |
| `outbox` | The receipt of each message for a Channel, by id, with the Ticket it is for and its `status`, `pending`, `sent` or `dropped`, kept so an id is never queued twice; for a dropped message, when and why, as the generated column `dropped`, its time, and a reason code. A message that waits has a `reply` effect, which holds its attempts | The Outbox |
| `kv` | Every other record, by key | The part that names it |

A generated column is computed from its row's JSON and is empty outside its set, and each has an index over its set, so a pass reads only active work. A database that predates a column gets it when the Store opens it.

`KV` (`src/kv.ts`) defines each key-value record's owner, key and type. All readers and writers use these entries; only migration code names older keys.

| Records | Keys or contents |
| --- | --- |
| Schema | Current schema version |
| Settings versions | `settings-revision`, `settings-version:<n>`, `settings-block-revision:<block>`; snapshots include origin, Policy version and affected Tickets |
| Prompt versions | `prompt-revision`, `prompt-version:<n>` |
| Main Session | `master-id` |
| Session prompt history | `session-prompts:<session id>` |
| Source state | Read positions such as `github-cursor:<number>`, PR CI fingerprints and seen Feishu-topic messages; keys begin with the kind or `thread-` plus a Thread key |
| Display names | `source-labels:<source id>` |

Dismissal is stored on its Decision. Input text is rendered from the Ticket when read, so neither needs a separate key-value record.

Read caches use bounded in-memory `TextCache` instances and are lost on restart. A Session paging through an original Source record or prompt preview must reread offset 0 after a restart. Feishu links resolved after intake are cached the same way; link-based search finds them only after that link has been read during the current process lifetime.

Nothing deletes old records yet, so these grow without bound: the `trigger`, `disposition` and `decision` rows; ended Tickets and their Threads; the outbox's receipts; and in `kv`, every saved settings revision and prompt version, the prompt revisions each Session worked under, and the Sources' records per Thread and per Issue or pull request.

`SCHEMA_VERSION` only increases. A database of a newer version refuses to start; `src/app/migration.ts` upgrades a database of the pre-release schema 10 once, at start, and refuses an older one.

## Model-facing interfaces

### Main Session tools

The main Session has 14 application tools:

| Purpose | Tools |
| --- | --- |
| Read and route | `orchestrator_read`, `orchestrator_route` |
| Manage Tickets | `orchestrator_ticket_retry`, `orchestrator_ticket_request_status`, `orchestrator_ticket_note` |
| Re-evaluate | `orchestrator_trigger_requeue` |
| Assess proactive work | `orchestrator_eval`, `orchestrator_eval_read`, `orchestrator_eval_decide` |
| Communicate and unsubscribe | `orchestrator_reply`, `orchestrator_thread_unsubscribe` |
| Configure | `orchestrator_settings_save`, `orchestrator_policy_sync`, `orchestrator_prompts_save` |

`orchestrator_route` accepts 1–20 decisions in order. Each accept, attach, stop or ignore runs as a separate Engine command. It also permits ignoring an inferred candidate directly from its card. `orchestrator_ticket_note` sends a fact as context, not authority.

Settings saves select `policy`, `eval`, `executor`, `pause`, or `source`; the last also names its Source id. A prompt save with `preview: true` composes text without saving.

The main Session also has DeepSeek Harness's `skill`, `bash`, `read`, `read_image`, `job_output`, `job_list` and `job_kill`. Avoiding code reads is a prompt rule, not a tool restriction.

### Presets and wait limits

New main Sessions use `dsh-superagent-router` (`ROUTER_PRESET`). Shell commands and job waits return after 5 seconds. If the Web UI selects another preset before the first turn, `Sessions` restores this preset, or `WORKER_PRESET` for a worker.

The `noWait` guard in `src/app/sessions.ts` refuses main-Session shell commands that invoke `sleep` at a command position, shell `timeoutMs` above 30 seconds, and `job_output` waits above 5 seconds. Reports and job results arrive automatically, so waiting only delays incoming candidates.

Existing main Sessions on `standard` also need explicit timeouts for foreground commands and job waits; otherwise that preset's defaults hold the step for 60 and 30 seconds respectively. The host determines the current preset through `presetForSession`, falls back to the Session projection or header, and assumes `standard` if it cannot read the value.

### Executor tools

Each Executor has six application tools:

| Tool | Purpose |
| --- | --- |
| `orchestrator_read` | Read resources available to its own Ticket |
| `orchestrator_ack` | Acknowledge a request |
| `orchestrator_report` | Report progress or an outcome, binding a pull request under the pull-request rules |
| `orchestrator_thread_unrelated` | Drop an unrelated attached Thread, hand back its owned follow-ups and tell the main Session why |
| `orchestrator_thread_follow` | Subscribe to a related Thread for context and tell the main Session |
| `orchestrator_trigger_handback` | Hand back a message once, with a reason carried by its candidate |

A hand-back returns `queued: false` if another Ticket still owns the message, or this Ticket never owned it. For example, a bot message went to Eval independently.

The worker preset is defined in `cordis.patch.yml` and selected through `WORKER_PRESET`. `WORK_TOOLS` in `src/app/sessions.ts` retains available file, search, shell, job, web, skill, todo and subagent tools. Workers do not receive tools for asking or presenting to a person, changing the profile, scheduling work outside worker slots, starting or messaging other Sessions, or editing external documents. Tool calls are refused after the Ticket ends.

### Result shapes and assessment context

Routing results use `{decision?, reason, ticket?}`. `orchestrator_route` returns `{results}`, preserving item order and adding each item's `trigger_id` and `kind`. Invalid or refused items return `refused` and a reason without stopping the batch.

Settings and prompt saves return the saved configuration. Policy sync returns the Source, allowed-list size, and `added` and `removed` names.

`orchestrator_eval` returns context rather than instructions. Assessment instructions live in `runtime/admission` (`prompts/admission.md`), and rules in `runtime/policy`. Its context includes:

- The Trigger text, up to 4,000 characters, with image ids and other Triggers in the batch.
- Up to eight `related_tickets`, open ones first, and `tickets_total`.
- The Eval's `policy_version`.
- A Thread window: the first five messages and five on either side of the Trigger. Messages use `{id, from, at, text}`, normally limited to 400 characters, or 1,200 for the two on either side. Truncated messages include `chars`; image references use `images`.
- Other loaded messages as `{id, from, preview}` stubs of 50 characters. `orchestrator_eval_read` expands them by id.

Ticket cards use the closed `TICKET_STATES` set from `src/app/cards.ts`: an open stage such as `person/review` or `working/queued`, or an ended outcome. Acknowledgements are limited to 100 words whether submitted through accept, assessment or `orchestrator_ack`.

### Read resources

`RESOURCES` in `src/app/resources.ts` defines the resources and generates the tool's `resource` description.

| Resources | Content |
| --- | --- |
| `tickets`, `triggers`, `threads`, `decisions` | Paged lists as `{items, next_offset}`; activity lists put newest first |
| `decision/<id>` | One Decision |
| `thread/<key>` | Label, Tickets, recent Decisions and a page of Triggers |
| `trigger/<id>` | Message text, replied-to Trigger and neighboring messages, excluding CI runs |
| `ticket/<id>` | Related ids, source-batch Triggers, Threads, and first pages of Assignments and Inputs |
| Ticket subresources | `/assignments`, `/inputs`, `/assignment`, `/result`, `/report/<assignment id>`, `/transcript`, `/message/<n>`, `/input/<id>` |
| `settings`, `settings/<block>` | Revisions and summaries, or a complete block ready to save |
| `prompts`, `prompts/<revision>`, `prompts/current`, `prompts/defaults`, `prompt-preview/<id>` | Prompt configurations and composed text |
| `models`, `models/<provider>` | Available models |
| `feishu/<trigger id>/…`, `github/…` | Original Source records, described in the Source skills |

Ticket Threads are marked `context` for context-only follows and `bound` for Source bindings. Assignment pages are newest first and include report previews. Continue lists with `next_offset`. `/input/<id>` accepts an Input's name or id. `settings` includes small blocks in full and summarizes Policy and Source blocks.

Source resources include message neighborhoods, `github/pulls/<n>/thread/<comment id>` and `github/commits/<sha>/checks`.

An original's messages read in one compact shape, `{id, from, at, text, reply_to?, path?, line?, url?}`, not as GitHub or Feishu records them.

An Executor Session reads only its own Ticket, its Threads, the Triggers that reached it or that its request held, the prompt versions it worked under and the originals, and its pages leave out the ids of what it cannot read, Decisions and other Tickets.

Every id a page shows reads through one of these, so a Session walks from one object to the next; hashes nothing reads by, such as an Eval's id or a Policy version, stay off the pages.

A text page has 4,000 UTF-16 code units by default and 8,000 at most, a list 20 items by default and 50 at most.

The names `event/`, `task/` and `observation/` of earlier versions still resolve.

### Messages delivered to Sessions

These messages are steered into the main Session's turn:

| Message | Content |
| --- | --- |
| Candidate | Batch Trigger cards, Thread, `related_tickets`, `tickets_total`, `delivered_to`, referenced Tickets from Issue/PR links, `handed_back` reasons and the next action |
| `follow_up` | One message as its Executor sees it, `replies_to`, receiving Tickets, and the reminder that Executors decide it while the main Session may only stop work |
| `worker_report` | Ticket card, originating Trigger, state and summary up to 600 characters; `chars` and a read pointer when truncated |
| `worker_attention` | Ticket card carrying the question |

Other notices are injected without waking the main Session: `ticket_ended`, `settings_saved`, prompt saves, Trigger requeues, dropped Subscriptions and context follows. A settings notice names the block, changed paths and `read: settings/<block>`. The main Session receives no redundant notice for a save, requeue, unsubscribe or attach it performed itself.

Workers receive assignments and Inputs inline. The first message includes the title, up to 1,500 characters of assignment text and the source Trigger card. Inputs carry a Trigger card with up to 600 characters and `replies_to`, or plain Input text. Read pointers appear only for truncated content.

### Panel-only actions

There is no tool for dismissing an unavailable Decision, rerunning setup, refreshing Source display names, or sending an Executor-owned human follow-up to Eval. The last action is deliberately refused by `orchestrator_trigger_requeue`. Other panel actions have equivalent tools.

Most built-in instructions live in `prompts/*.md`, with one sentence per line joined by `promptFile`. Source skills live in `skills/dsh-superagent-*/SKILL.md`. Tool descriptions and fixed notices such as restart recovery notes remain in code. Assessment instructions live only in `prompts/admission.md`.

`tests/model-surface.spec.ts` checks these surfaces for drift. [004 Prompts](004-prompts.md) explains the team's editable parts.

## Configuration reload

Every plugin configuration key except `stateDir` is volatile. The panel's Deployment settings and DeepSeek Harness's Plugin Manager edit them through DeepSeek Harness's configuration form; the host writes `cordis.patch.yml` and updates the values in place, and dsh-superagent reads each limit when it uses it, so a change applies without a restart.

A settings save that changes a Source field setup reads, such as an account's CLI, and any save while setup waits, restarts dsh-superagent. DeepSeek Harness's settings service does not serve the entry during that restart, so after its own restart dsh-superagent asks it to read the entry again, and an open form becomes editable again.

## Reviewing a change against real data

Point `DSH_HOME` at a temporary directory and create a new profile there. Copy the database from a backup, disable every Source, pause processing and remove the main Session id. Give the GitHub and Feishu CLIs read-only stand-ins.

## Group chats across plugins (VsSaros addition)

A group chat is not part of the orchestrator's model. It runs in `@vssaros/dsh-agents` and is drawn by `@vssaros/dsh-chat-surface`; dsh-superagent only starts groups and shows their runs read-only. No Ticket, Step, Executor slot or SSE topic carries a group run, so `0/3` on the Execution tab never counts group members.

The path of one request:

1. A person writes in the desk. `src/app/groupFastPath.ts` recognises a request for a team, creates the group at once through the team bus (`globalThis[Symbol.for('vssaros.team')]`, provided by `vssaros-agents/lib/teamBus.js`) with `originTriggerId` set to the Trigger id, then settles it in one transaction: the `group_route` row (`src/app/group-routes.ts`), the `ignore` decision and the notice to the desk. The same `originTriggerId` returns the existing group, so the fast path, `superagent_submit` and a later model call never make two. The desk's flow card reads `group_route` and shows the group rather than "not taken".
2. A message that `@`-names an existing group (or references its Session) is settled the same way as `routed`, with the person's DSH message id; `vssaros-agents` posts it into the group's Session as a person's message (`rooms.postToRoom`, `source.kind: 'user'`, `form: 'room-post'`, id `room-post:<session>:<message>` so it lands once however often it is posted) and remembers where it came from. Both plugins pair a message with its reference within the same 15 seconds; a reference that comes after the desk's short wait still settles the message, so the group and the supervisor never both take it.
3. A group's Session never calls a model: its last person message makes the agents plugin synthesise one `group_relay` tool call. The tool hands the message to members in their own shadow Sessions, waits for each turn to end, and returns every reply as the tool result, which the Session keeps.
4. While it runs, every reply, status event and speaker change is written through to `agent-rooms.json` (`rounds[]`). `GET /x/agents/api/rooms?progress=<callId>` and `?active=1` read it.
5. In the browser one poller (`GroupActivityDock` in chat-surface) reads `?active=1` and broadcasts `vssaros-group-progress` with `{ schema, seq, active }`, keeping the last list in `window.__vssarosGroupProgress`. The Bots rows, the composer dock of group and member Sessions, the right-hand tip, the desk's flow cards and `src/client/group-runs.tsx` all listen to it. Only while no broadcast has been heard (chat-surface missing, loaded later, or in another webview) does `group-runs.tsx` read `?active=1` itself, every five seconds. The group tool card polls its own `?progress=`.

The payloads of `?active=1`, `?progress=`, the tool result and the three window events (`vssaros-group-progress`, `vssaros-rooms-changed`, `vssaros-group-composer-dock-visibility`) are written down in `dsh-plugins/contracts/group-activity.schema.json`. `check-bots-rooms.mjs` validates the agents plugin's real output and chat-surface's real broadcasts against it; `tests/group-contract.spec.ts` reads its example the way this panel does.

Each run carries one state, computed once in `vssaros-agents/lib/core/rooms.js` (`roundStatusOf`): `sent`, `replying`, `done`, `cut` or `failed`, with its label. A run cut by a restart also carries an error, and still reads `cut`. Every consumer shows the server's `status`; the copies of the rule in chat-surface and `group-runs.tsx` only read older data, and one table of cases in `check-bots-rooms.mjs` and `tests/panel-work.spec.tsx` keeps all copies equal. A run also carries `originTriggerId`, `fromSession` and `sourceMessageId`, which tie it back to the desk.

Restarts and other Hosts:

- A run that was going when the Host stopped is closed as `cut` on the next load; its replies so far stay, nothing is run again. DSH closes the open tool call with a plain error result, so the tool card recognises that result and reads the run's replies from `?progress=`; `cut` runs are therefore kept by group (the latest 20 per group, removed with the group) instead of expiring after ten minutes. A finished run is drawn again from its tool result.
- A tool card that never gets progress again (a call from before this version, or a normal run older than ten minutes) shows that its state is lost and stops polling.
- `agent-rooms.json.owner` names the one instance that writes the file. The instance that loaded last takes it over; before each write an instance checks it still owns it, and otherwise turns read-only instead of overwriting the newer instance's data. A file from a newer version is read but never written.

Tests: `vssaros-agents/test/rooms.test.mjs` (a whole round against fake Sessions, persistence, ownership), `vssaros-agents/test/rooms-restart.test.mjs` (a child process killed in the middle of a round, then reloaded), `dsh-plugins/check-bots-rooms.mjs` (the chat-surface views in jsdom), and `tests/panel-work.spec.tsx` and `tests/panel-execution.spec.tsx` here.

## Open questions

- Trust: which Trigger fields are trusted, such as the Source's actor and Thread membership, and which are not, such as the body and quotes.
- Deployment isolation: the agent's profile on its own pinned DeepSeek Harness installation, so upgrading DeepSeek Harness elsewhere does not break it.
