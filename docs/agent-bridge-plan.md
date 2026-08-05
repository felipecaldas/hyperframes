# Direct Chat-to-Agent Bridge for HyperFrames Studio

Status: implementation plan for TAB-507 spike follow-up (2026-08-01).

## Goal

Studio can send its generated project context and a user's instruction directly to a local Codex or
Claude CLI. Each provider owns a resumable, project-scoped thread. The selected agent may edit only
the server-resolved project, Studio lints the result, refreshes once, and exposes conflict-safe Undo.
Copy Prompt remains available whenever a provider is missing or unauthenticated.

## Shared server contract

The optional runtime is mounted by `@hyperframes/studio-server`, so CLI Preview and the Vite Studio
development host share one implementation:

- `GET /projects/:id/agent/capabilities`
- `GET /projects/:id/agent/threads`
- `POST /projects/:id/agent/threads/reset`
- `POST /projects/:id/agent/runs`
- `GET /agent/runs/:jobId/events`
- `POST /agent/runs/:jobId/cancel`
- `POST /agent/runs/:jobId/undo`

`AgentRunRequest` accepts provider `codex | claude`, a fixed request kind, the complete generated
prompt, an optional registry item, and an optional new-thread flag. Prompts are capped at 128 KiB.
Only one run may own a project write lock at a time.

The capabilities response is the Studio bootstrap for this optional feature. It includes provider
availability/setup guidance and a random, process-local nonce. Agent mutations require same-origin,
JSON content type, and that nonce. The bridge reports unavailable on non-loopback hosts. Agent
payloads, paths, transcripts, and output never enter telemetry.

## Provider execution

Provider adapters spawn fixed executable names with `shell: false` and use the canonical project
directory as `cwd`. Prompts are written to stdin, never interpolated into a command or shell. Codex
uses JSONL output and workspace-write sandboxing. Claude uses stream JSON plus edit-accepting,
deny-by-default permissions: only project settings are loaded, MCP and slash-command customization is
disabled, project read/search/edit tools are pre-approved, and only the narrow HyperFrames lint/check
command patterns may run. Unrestricted/bypass modes are forbidden. Both adapters normalize status,
assistant text, tool summaries, session IDs, cancellation, malformed streams, authentication errors,
and process failures. Codex resume commands explicitly reassert workspace-write because the resume
subcommand otherwise falls back to a read-only permission profile.

Runs have a three-minute inactivity timeout, reset by normalized provider activity, plus a
fifteen-minute absolute ceiling. A timeout terminates the provider, invalidates its resumable thread,
then continues through source diffing and lint so Studio unlocks and refreshes once. Supported partial
edits remain available to Undo; unsupported edits retain the existing critical no-coverage behavior.

Provider state lives outside projects under the HyperFrames user-state directory, keyed by a hash of
the canonical project path and provider. Threads are independent between providers. The newest 20
run ledgers per project are retained.

## Transaction and Undo

Before registry installation or agent launch, snapshot every supported editable source file and
`.hyperframes/frame-comments.json` to the external run ledger. Record a project-wide hash inventory
to detect changes to unsupported files. Generated Studio caches such as `.thumbnails/` are excluded
from both inventories because Preview may update them concurrently and they are neither editable
source nor part of Undo. Registry installation uses the existing adapter and belongs to the same
transaction as agent edits.

After the process exits or is cancelled, compute created/modified/deleted files and their before/after
hashes. Any changed file outside the supported source set makes Undo coverage incomplete and emits a
critical failure. An edit-oriented request that exits successfully without changing project files is
reported as a failure instead of a completed edit. Otherwise run the existing project lint path and
publish its findings. Lint errors do not discard edits or block the single post-run Studio refresh.

Undo is all-or-nothing: first verify that every changed path still matches its recorded post-run hash.
A mismatch returns 409 and restores nothing. A clean rollback recreates deleted files, restores
modified files byte-for-byte, removes created files, lints again, and invalidates the provider thread.
Cancellation deliberately leaves partial changes visible and undoable.
If cancellation discovers an unsupported change, the critical incomplete-coverage failure takes
precedence instead; Studio never labels that cancellation fully undoable.

## Studio integration

A persistent Agent drawer owns provider selection, per-provider transcript, generated-context
inspection, activity, changed files, lint findings, Cancel, Undo, and New chat. The last provider is
saved per project. Existing prompt builders remain canonical; direct actions pass their output to the
drawer without rewriting or truncating it. Large lint result sets use a compact severity summary with
collapsed details so the agent's terminal result remains visible.

Catalog requests install the registry item inside the server transaction before agent execution.
Selection, timeline, lint, preview-console, and Storyboard actions route into the same drawer. Copy
Prompt remains adjacent as fallback. Before starting, Studio waits for queued DOM/source saves and
rejects an unsaved source editor. Signature-driven intermediate reloads are suppressed during a run;
completion or Undo refreshes the file tree, Storyboard, and Preview once while retaining playhead and
selection when possible.

Storyboard order remains explicit: Create with Agent creates only the proposal; Save & Send Feedback
persists comments before starting the agent; stage approval buttons send the existing approval text.
No approval, view-stage change, or render is inferred from agent completion.

## Verification

Unit tests cover prompt preservation, provider first/resume runs, malformed streams, auth errors,
cancellation, API guards, project resolution, allowlists, prompt limits, locking, shell injection,
registry transactions, unsupported changes, hash-conflict Undo, and byte-identical rollback. UI tests
cover capabilities/fallback, provider switching, persistent threads, New chat, dirty-editor blocking,
events, lint, refresh-once, and Undo. Integration fixtures use fake Codex and Claude executables to
edit HTML and Storyboard source without invoking real accounts.

Manual acceptance uses `ft43lvj85z-nubank`: Neon Accent through each provider, a follow-up in the
same thread, lint plus one refresh, then Undo. Final gates are targeted tests, package typechecks,
full Bun build, lint, and format checks.

The 2026-08-01 acceptance run found and fixed a Claude isolation gap: user-level tooling initially
created `.code-review-graph` state in the project. The bridge reported incomplete coverage, the test
artifacts were removed, and the adapter was changed to project-only settings, strict empty MCP
configuration, disabled slash commands, and deny-by-default permissions. The repeated Claude run
made only supported edits, resumed its provider session, and restored all 23 tracked source files to
their pre-run hashes. Codex independently completed the same install/follow-up/Undo sequence.
