# Source Layout (Transition Skeleton)

This `src/` tree is the target layout for modular refactoring.

- `background/`: service worker logic and background-only helpers.
- `content/`: content script and capture utilities.
- `sidepanel/`: side panel UI assets.
- `config/prompts/`: prompt template data.
- `shared/`: shared constants/contracts consumed by background/content/sidepanel.

Notable extractions completed so far:
- `background/session-helpers.js`: session routing/turn helpers and delivery-state normalization.
- `shared/providers.js`: provider metadata/capabilities plus host/label helper utilities.

Current runtime entrypoints still use root files during transition. The mirrored files in `src/` are used for staged extraction commits.
