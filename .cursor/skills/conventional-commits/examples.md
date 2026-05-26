# Commit message examples (m4trix)

## Strong (changelog-friendly)

```
feat(matrix): add optional retry config to AgentFactory

- Expose maxAttempts and backoff on the fluent builder
- Default remains single attempt

Closes #123
```

```
fix(evals): accept top-level dataset paths in filter config
```

```
feat(tracing,trace-viewer): add S3 and DynamoDB export for trace batches
```

```
perf(trace-viewer): reduce LangGraph token panel re-renders
```

```
refactor(tracing): extract sidecar shipping into dedicated module
```

```
feat(core)!: rename channel bind API on AgentNetwork

BREAKING CHANGE: bindChannel() is now wire(); update imports from @m4trix/core/matrix.
```

## Weak (avoid)

| Message | Why |
|---------|-----|
| `feat: new features` | No scope → ambiguous Agents changelog |
| `chore(evals): add tag filters` | `chore` excluded from product changelog |
| `docs(evals): add tag filters` | Product change mislabeled as docs |
| `fix(tracing): hotfixed ci` | Vague; sounds like CI not tracing |
| `feat(trace-viewer): wip` | Not user-meaningful in Mintlify |
| `refactor(*): update imports` | `*` floods all three changelogs |

## Split vs combine

**Combine** (one commit) when one feature spans packages intentionally:

```
feat(tracing,trace-viewer): ship trace profiles for LangGraph runs
```

**Split** when changes are independent:

```
feat(evals): introduce sampling for run configs
```

```
fix(trace-viewer): correct package exports field in package.json
```

## Non-product commits (correct, not in changelog)

```
docs(tracing): document sidecar CLI flags
```

```
ci: add coverage upload to release workflow
```

```
chore: bump biome and format packages
```
