# Source Layout (Transition Skeleton)

This `src/` tree is the target layout for modular refactoring.

- `background/`: service worker logic and background-only helpers.
- `content/`: content script and capture utilities.
- `sidepanel/`: side panel UI assets.
- `config/prompts/`: prompt template data.
- `shared/`: shared constants/contracts consumed by background/content/sidepanel.

Current runtime entrypoints still use root files during transition. The mirrored files in `src/` are used for staged extraction commits.
