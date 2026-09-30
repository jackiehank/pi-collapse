# Changelog

## v1.0.0

Initial release.

- **Thinking auto-collapse** (`thinking`): thinking expands while streaming, collapses once the answer / tool starts; collapsed label `Thinking >`.
- **Long command fold** (`cmdlines`): a shell command over N lines or M chars folds into a one-line summary (`write x.py`, `python heredoc`, `python -c`, or the first meaningful line).
- **Dangerous command hints** (`danger`): flags `rm -rf /`, `dd of=/dev/*`, `git push --force`, `DROP TABLE`, `curl … | bash`, … with a `⚠ reason` badge. Hint only — never blocks execution.
- **Transcript collapse** (`transcript`): each turn folds everything except the final assistant reply into one block; expanded blocks have a clickable `^ collapse` row at the bottom.
- **Minimal output** (`minimalOutput`): hides the output of `bash` / `powershell` / `read` / `find` / `grep` / `ls` while collapsed.
- Single `/collapse` master switch; all fine-grained options live in `~/.pi/agent/collapse.json`.
- i18n: `lang` = `auto` / `en` / `zh`.
- Re-installs every patch on each extension load (original method remembered), so `/reload` always runs the latest code.

Tested with **pi 0.99.1**.
