# PR 83753 Azure Doctor CLI Proof

Head tested: 8cef0bb2833a683b1f681aa72defc10812c852bb
Environment: disposable Azure Ubuntu 24.04 VM, real user systemd manager, systemd 255, Node 22.22.2.

This proof exercises current-head CLI behavior, not just unit tests:

- shell completion doctor --lint detects slow dynamic completion and exits 1;
- doctor --fix --yes rewrites the disposable shell profile to cached completion;
- shell completion doctor --lint is clean after repair;
- real loginctl show-user azureuser -p Linger starts as Linger=no;
- systemd-linger doctor --lint reports the availability warning and exits 1;
- doctor --fix --yes invokes the real systemd linger repair and enables lingering;
- real loginctl show-user azureuser -p Linger ends as Linger=yes;
- systemd-linger doctor --lint is clean after repair.

Files:

- zure-doctor-cli-proof.redacted.log: full redacted command transcript.
- zure-proof-excerpt.txt: key command/result excerpt.
- summary.redacted.txt: expected exit-code summary.
- docker-repro.sh: repeatable Docker repro for the non-privileged shell-completion CLI path. It intentionally does not claim systemd/loginctl coverage; the Azure VM transcript covers that.
