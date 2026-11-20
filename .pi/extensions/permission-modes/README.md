# Permission Modes (draft)

## Known limitations

- Read-only Git commands are not guaranteed to be side-effect-free. Git can execute repository-configured commands through settings such as `core.pager`, `core.fsmonitor`, and `diff.external`. Do not treat an allowlisted Git command as a sandbox when working in an untrusted repository.
