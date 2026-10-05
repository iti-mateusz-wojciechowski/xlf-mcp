# xlf-mcp

An MCP server for Business Central XLIFF translation files. It lets an agent keep
target language files (`<App>.g.da-DK.xlf`, `<App>.g.de-DE.xlf`, …) in step with the
compiler-generated source `<App>.g.xlf`, and fill empty targets from translations
that already exist elsewhere — instead of an owner doing both by hand in an editor.

```
xlf_sync { path: "…/Apps/MyApp" }
```

```
Preview only -- nothing written (pass write: true to apply).

Translations/MyApp.g.da-DK.xlf (da-DK):
  +8 new, 1 source changed (target cleared), -2 obsolete, 0 notes updated
    + Table 3628820878 - Field 4078588867 - Property 2879900210: Responsibility Center
    ~ Codeunit 391167912 - … : "Invalid parameter." -> "Invalid parameter. %1" (drops "Ugyldig parameter.")
    - Table 486998653 - Field 3703022435 - Property 2879900210: Tax G/L Account No.
```

## Tools

| Tool | What it does |
|---|---|
| `xlf_status` | Per source file and target language: units, empty targets, state breakdown, and what is out of sync. Read-only — start here. |
| `xlf_sync` | Synchronise targets with their source `.g.xlf`. |
| `xlf_apply_matches` | Fill empty targets from identical source texts already translated in other files of the same language. |
| `xlf_list` | Page through a file's units (empty, `needs-*`, a state, or all) with source, notes and context. |
| `xlf_find` | Look up how a source text has been translated across the repo, optionally inside `.alpackages`. |
| `xlf_set_targets` | Write given translations by trans-unit id — for whatever no match could fill. |

Every write tool previews by default and reports a summary plus a capped sample;
`write: true` applies.

## Rules

The sync follows the rules of the [XLF Editor](https://marketplace.visualstudio.com/items?itemName=aar.xlf-editor)
VS Code extension, so files stay compatible with a team that also edits them there:

| Situation | Result |
|---|---|
| Unit new in source | Added with `<target state="needs-translation"></target>` after `<source>` |
| Source text changed | Source replaced, target cleared, state `needs-translation` |
| Unit gone from source | Removed |
| Developer or generator note changed | Copied from source |
| Filled by a match or `xlf_set_targets` | State `needs-review-translation` (configurable) |

Source texts are compared entity-decoded and trimmed, so `&quot;` versus `"` is not
a change.

Where it differs from XLF Editor, deliberately:

- **No reformatting.** Units are edited as text, not parsed and re-serialised, so a
  sync that adds eight units is an eight-unit diff. BOM, line endings, indentation
  and self-closing notes of untouched units stay byte-identical.
- **Order is kept by default.** New units are appended; `reorder: true` puts every
  unit in source order. Existing targets are often in another order, and reordering
  them rewrites the whole file.
- **Ambiguity is reported, not guessed.** When one source text has several
  translations, `xlf_apply_matches` skips the unit and lists the candidates with
  counts (`ambiguous: "mostFrequent"` accepts a clear majority, never a tie). An
  empty target is never used as a match.
- **Duplicate unit ids** in a target are reported and collapsed to one.

Targets are paired with their source by the `<file original="…">` attribute, which
the compiler sets to the app name, in the same folder. A target with no matching
source is reported as unpaired and never synced.

## Install

```bash
git clone https://github.com/iti-mateusz-wojciechowski/xlf-mcp.git
cd xlf-mcp
npm install
npm test
npm run register
```

`npm run register` registers this checkout's absolute path with Claude Code
(`-- --local` for the current directory only, `-- --print` to change nothing).
Restart Claude Code and confirm with `claude mcp list`.

Requires Node.js 18 or later. No VS Code or AL tooling is needed.

`XLF_MCP_VERBOSE=1` logs each call to stderr.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
