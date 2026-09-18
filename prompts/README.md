# Prompt files, addressed by content hash.

`@hyperfixation/ai` reads a prompt from this directory and records the hash of what it read on
every `hf_llm_call` row, so a prompt edit is visible in the ledger rather than silently
changing what a replay means. Phase 2 wires the registry; Phase 1 ships the directory.
