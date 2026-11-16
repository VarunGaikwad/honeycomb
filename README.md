# bi

A [Pi coding agent](https://pi.dev) extension package.

## Structure

```
bi/
├── package.json                 # Pi manifest and package scripts
├── tsconfig.json
├── src/
│   ├── index.ts                 # Extension entry point
│   ├── tui/                     # Branded interactive header and footer
│   ├── extension/               # Pi runtime integration
│   │   ├── index.ts             # Extension module exports
│   │   ├── ask-user.ts          # Structured interactive prompts
│   │   ├── quiet-startup.ts     # Project-local Pi setting
│   │   └── register-tools.ts    # Tool registration and dispatch bridge
│   ├── slash/                   # Slash commands and system prompt
│   │   ├── index.ts             # Slash module exports
│   │   ├── init.ts
│   │   └── system-instruction.ts
│   ├── tools/                   # Tool implementations, registry, and dispatcher
│   └── types/                   # Shared/domain interfaces and type aliases
├── tests/                       # Tool-system tests
└── README.md
```

Keep TypeScript source and test files below 1000 lines. Split files by responsibility
before they approach that limit.

## Usage

```bash
# Try for one session (no install needed)
pi -e ./

# Install as a local package
pi install ./

# Or copy into the global extensions directory
mkdir -p ~/.pi/agent/extensions/bi
cp -r . ~/.pi/agent/extensions/bi
```

Inside pi:

- `/init` — analyzes the codebase and generates/updates `AGENTS.md` at the project root
- `session_start` notification confirms the extension loaded
- Interactive mode uses a compact branded header and a footer with the current
  project, model, and Git branch; other modes are unchanged

### Tool execution safety

Shell, background, terminal, and code-execution tools require either an
`allowCommand` policy supplied to `createExecutionTools()` or per-command
approval through the tool context. Destructive filesystem and Git operations
also require a UI approval callback; both kinds of operation are denied when
the extension has no UI or configured policy.

### How `/init` works

1. Checks `AGENTS.md` doesn't already exist (asks before overwriting)
2. Sends a user prompt to the agent instructing it to explore the project
   (docs, manifests, directory structure) and write a concise `AGENTS.md`
   with overview, build/test/lint commands, architecture notes, and code style
3. The agent runs with its normal tools (read, edit, write) to produce the file

## System prompt

bi uses its own system prompt — pi's default system instruction is fully
replaced via a `before_agent_start` handler that returns the complete prompt
for every run.

- Edit `BI_CORE_PROMPT` in `src/slash/system-instruction.ts` to change bi's identity and workflow rules
- The builder re-embeds what pi's default prompt would have provided: tool
  guidance (`toolSnippets`/`toolGuidelines`), context files (`AGENTS.md`
  content), skills, custom sections, and `--append-system-prompt`
- User-supplied `--system-prompt` / `SYSTEM.md` prefixes are kept in front

## Development

```bash
npm install        # install dev deps (types, tooling)
npm run typecheck  # type-check the extension
npm test           # run tool-system tests (Node.js with TypeScript transform support)
```

Host-provided packages (`@earendil-works/pi-coding-agent`, `typebox`, etc.)
are declared as optional `peerDependencies` — pi supplies them at runtime.
