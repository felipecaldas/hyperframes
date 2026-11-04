# Local GitHub Actions runners

All jobs must use `[self-hosted, Linux, X64, tabario, passbolt]`. These labels
route execution to the Linux x64 runner on the passbolt.local Windows server.
There is no GitHub-hosted fallback; jobs queue while the runner is offline.

Use the **Local runner smoke** workflow (`workflow_dispatch`) to check runner
identity, checkout, Node/Python setup actions, FFmpeg, ShellCheck and Docker.

Runner installation and maintenance live in
[felipecaldas/tabario-infra](https://github.com/felipecaldas/tabario-infra/tree/main/github-runner).
The server accepts jobs initiated by `felipecaldas` and rejects fork PR checkouts.
Apply this policy to newly added/generated workflows before publishing them.
Do not rerun historical commits or tags that still target hosted runners.

Both `main` and `tabario` carry this CI policy. `main` follows upstream application
code but is no longer a byte-for-byte mirror: the local-runner workflow patch
must survive upstream merges. Do not replace it with `upstream/main` or push
upstream tags without applying the policy first.

Windows and macOS/Safari jobs are deliberately disabled, including dependent
summary jobs. The CLI matrix covers Linux only. ARM64 jobs added by future
upstream updates must also stay disabled until compatible local hardware exists.
These skipped jobs do not prove platform coverage.
