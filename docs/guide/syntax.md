# Supported syntax

Linear Lens recognizes all of the following:

| Example | What happens |
|---|---|
| `ENG-123` | Linked + decorated + hover (raw reference) |
| `eng-123` | Linked + decorated + hover; normalized to `ENG-123` |
| `Fixed in ENG-123` | Linked + decorated + hover only — **never** a Problem |
| `TODO: ENG-123 fix retry logic` | Linked + decorated + hover + Problem (`TODO`) |
| `TODO ENG-123: fix retry logic` | Linked + decorated + hover + Problem (`TODO`) |
| `TODO: fix retry logic in ENG-123` | Linked + decorated + hover + Problem (`TODO`) |
| `FIXME ENG-124 handle null user` | Linked + decorated + hover + Problem (`FIXME`) |
| `// BUG ENG-9 leaks memory` | Linked + decorated + hover + Problem (`BUG`) |
| `# HACK ABC-1 workaround` | Linked + decorated + hover + Problem (`HACK`) |
| `- [ ] ENG-123 fix auth` | Linked + decorated + hover + Problem (unchecked task) |
| `- [x] ENG-200 done` | Linked + decorated + hover only — checked task is not actionable |
| `https://linear.app/acme/issue/ENG-123/fix-auth` | Linked + decorated + hover (URL reference) |
| Branch `allie/eng-123-auth` | Detected in the status bar as `ENG-123` |

A marker keyword anywhere on a line makes the IDs on that line actionable, whether the ID comes
before or after the keyword. Word boundaries are respected, so `debug` is not treated as `BUG`
and `hackathon` is not treated as `HACK`.

> **Zero-config note:** when no team-key allowlist is set, any `ABC-123`-shaped token is treated
> as an issue ID. This can occasionally produce false positives (for example `self-2` would be
> read as `SELF-2`). Set `linearLens.teamKeys` to your real team keys to remove them.
