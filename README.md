# xlf-mcp

An MCP server for Business Central XLIFF translation files. It lets an agent do
the translation housekeeping of an AL app — keeping every language file in step
with the compiler's output, reusing translations that already exist, adding new
languages — and report what is left for a translator.

No VS Code, AL tooling or translation service is needed: the server reads and
writes `.xlf` files on disk, and nothing else. It needs Node.js 18 or later; see
[Install](#install).

It is not a machine translator. New text comes from the agent calling it or from
translations already in your files; the server keeps the files consistent.

- [How BC translation files work](#how-bc-translation-files-work)
- [Tools](#tools)
- [States](#states)
- [Configuration](#configuration)
- [Typical workflows](#typical-workflows)
- [Good practices](#good-practices)
- [Install](#install)

## How BC translation files work

With `"features": ["TranslationFile"]` in `app.json`, every build writes
`Translations/<App>.g.xlf`: one `<trans-unit>` per caption, tooltip, label and
option caption, in the source language (en-US), with no translations. That file
is **compiler output** — regenerated on each build, never edited by hand.

Each language is a separate file beside it, by convention `<App>.g.<lang>.xlf`,
holding the same units plus a `<target>` with the translation:

```xml
<trans-unit id="Table 3628820878 - Field 4078588867 - Property 2879900210" size-unit="char" translate="yes" xml:space="preserve">
  <source>Responsibility Center</source>
  <target state="translated">Ansvarscenter</target>
  <note from="Developer" annotates="general" priority="2"></note>
  <note from="Xliff Generator" annotates="general" priority="3">Table MyBuffer - Field ResponsibilityCenter - Property Caption</note>
</trans-unit>
```

| Part | Meaning |
|---|---|
| `id` | Hash of object, member and property names. Renaming any of them changes the id: to a translation file that is a removed unit plus a new one. |
| `<source>` | The English text, from the AL `Caption`, `ToolTip` or `Label`. |
| `<target>` | The translation. Its `state` and `state-qualifier` attributes say how far along it is (see [States](#states)). |
| `note from="Developer"` | The AL `Comment = '...'` — the developer's hint to the translator, e.g. what `%1` stands for. |
| `note from="Xliff Generator"` | Readable context: object, member and property behind the id. |
| `<file original="…">` | The app name. It ties a language file to its source; this server pairs files by it. |

When the source changes, the language files drift: new units are missing, edited
texts still carry the old translation, deleted ones linger. Keeping them in step
is what `xlf_sync` does.

## Tools

All tools take a `path`: a repo root, an app folder, a `Translations` folder, or
one `.xlf` file, and work on everything under it. Tools that write **preview by
default** and report a summary with a capped sample; pass `write: true` to apply.

### `xlf_status` — read-only health check

Start here. For each source file and each language beside it:

- unit count, empty targets, and targets that are filled but still `needs-*`
- breakdown of `state` values
- **out of sync**: units new in source, units whose source text changed, units
  gone from source, notes that changed
- duplicate unit ids, and the order the file follows (by id, by source, or none)
- targets whose `%1`, `%2` placeholders differ from the source
- targets whose `state` is not an XLIFF 1.2 value
- the effective [settings](#configuration) and where each comes from

### `xlf_sync` — bring language files in line with the source

| Situation in the source `.g.xlf` | What happens in each language file |
|---|---|
| Unit is new | Added, with an empty target in state `stateEmpty` |
| Source text changed | Source updated. Old target **kept** and set to `stateReview`, so the translator sees what it said — or emptied into `stateEmpty` with `onSourceChange: "clear"` |
| Unit is gone | Removed |
| Developer or context note changed | Copied over |
| Unit id appears twice in the language file | Collapsed to one copy, at the first position; a translated copy wins over an empty one |
| Placement | Existing units never move. New units go where the file's own order puts them: by id if the file is sorted by id (the common convention), by source position if it follows the source, at the end otherwise |

Source texts are compared with XML entities decoded and whitespace trimmed, so
`&quot;` versus `"` is not a change. Units that need no change keep their exact
bytes, and the file keeps its own BOM, line endings and indentation: a sync that
adds eight units is an eight-unit diff.

Parameters: `languages` (limit to some), `onSourceChange`, `order` (`auto` by
default; `id` or `source` re-sorts every unit), `write`.

### `xlf_apply_matches` — reuse existing translations

Fills **empty** targets from other language files of the same language where
the source text is identical — a translation-memory exact match. By default it
searches under `path`; pass `searchPath` (e.g. the repo root) to reuse across
apps, and `includePackages: true` to also reuse translations shipped inside the
`.app` files in `.alpackages` (Microsoft's System Application, ISV apps…).

An untranslated copy (target identical to the source) is ignored when a real
translation of the same text exists, so leftover English does not compete with
it; on its own it is still used (`Bank` → `Bank`). A source text translated more
than one way is **not** guessed: the unit stays
empty and the candidates are listed with their counts. `ambiguous:
"mostFrequent"` accepts a clear majority, never a tie. Filled targets get
`stateMatched` (`needs-review-translation`), so they remain distinguishable
from reviewed work.

### `xlf_list` — read units for translation or review

Pages through one file with source, target, state, qualifier, developer note and
context. `filter`: `empty` (default), `needs-any` (empty, or state `needs-*`),
`placeholders` (target's `%n` differ from source), `all`, or an exact state.

### `xlf_set_targets` — write translations

Writes translations by unit id, for whatever no match could fill — typically an
agent translating the output of `xlf_list`. Text is plain; escaping is done
here. Targets get `stateWritten` (`needs-review-translation`) unless an entry
sets its own `state` / `qualifier`. A placeholder mismatch is flagged.

### `xlf_find` — look a text up

Shows how a source text is already translated across the repo (and optionally
`.alpackages`): each distinct translation, how often, where, in which state.
`match`: `exact`, `ignoreCase` or `contains`. Use it to keep terminology
consistent before writing a translation.

### `xlf_normalize_states` — convert to standard states

Replaces every target state that is not an XLIFF 1.2 value — typically
`state=""` left by older tooling — with a standard one: a filled target becomes
`filledState` (default `translated`), an empty one `stateEmpty`. `map` sets an
explicit replacement per old value, e.g. `{ "ai-translated":
"needs-review-translation" }`. Only the attribute changes; the text keeps its
bytes. Run it once when adopting standard states.

### `xlf_create` — add a language

Creates `<App>.g.<lang>.xlf` beside each source file: the source's header with
`target-language` set, every unit with an empty target in `stateEmpty`. With
`prefill` (default) it then reuses existing translations of that language, as
`xlf_apply_matches` does. A language that already has a file is skipped.

## States

XLIFF 1.2 gives every `<target>` an optional `state` attribute recording where
the translation stands in its workflow, and an optional `state-qualifier`
recording how it was produced. These are bookkeeping for people and tools; the
spec's values are:

| `state` | Meaning (XLIFF 1.2) |
|---|---|
| `new` | The unit is new, e.g. not in a previous version of the document |
| `needs-translation` | Needs to be translated |
| `needs-adaptation` / `needs-l10n` | Non-text / text and non-text information needs adapting |
| `needs-review-translation` | The text needs review |
| `needs-review-adaptation` / `needs-review-l10n` | Non-text / text and non-text information needs review |
| `translated` | Translated |
| `signed-off` | Approved by a reviewer |
| `final` | Terminal state |

Any other value must start with `x-` (e.g. `x-customer-approved`). An empty
`state=""` is not a valid value; `xlf_status` reports such targets.

`state-qualifier` (e.g. `exact-match`, `fuzzy-match`, `leveraged-tm`,
`mt-suggestion`) records how a translation was produced. It is valid XLIFF but
rarely used in Business Central apps, so it is **off by default**; set
`qualifierMatched` / `qualifierWritten` to turn it on.

In practice: Microsoft's shipped translations mark every target `translated`;
some ISVs use `state` as a real workflow (machine output, developer draft,
`signed-off`). Both are reasons to keep it accurate.

**What Business Central does with them:** Microsoft's documentation on
translation files describes only `<source>`, `<target>` and `target-language`
and says nothing about `state`; this server does not assume the compiler reads
it. Treat `state` as your team's workflow record — which is exactly why it
should be accurate.

### Which state each tool writes

| Event | Setting | Default |
|---|---|---|
| Unit new in source, or target emptied by a source change | `stateEmpty` | `needs-translation` |
| Source changed, old target kept for the translator | `stateReview` | `needs-review-translation` |
| Filled from an identical source text | `stateMatched` / `qualifierMatched` | `needs-review-translation` / none |
| Written by `xlf_set_targets` | `stateWritten` / `qualifierWritten` | `needs-review-translation` / none |

Nothing this server writes is `translated` or later by default: promoting a
target is a reviewer's decision. A team that does not review reused matches can
set `stateMatched` to `translated`.

## Configuration

Settings are resolved **per call, key by key**, first hit wins:

1. a tool argument, where the tool offers one (`onSourceChange`, per-entry `state` / `qualifier`)
2. `xlf-mcp.json` — the nearest one walking up from `path` (put it at the repo root)
3. the defaults above

```json
{
  "stateEmpty": "needs-translation",
  "stateReview": "needs-review-translation",
  "stateMatched": "translated",
  "qualifierMatched": null,
  "stateWritten": "needs-review-translation",
  "qualifierWritten": null,
  "onSourceChange": "review"
}
```

Any subset works; missing keys fall back to the defaults. A qualifier set to
`""` or `null` is not written. An unknown key is an error, so a typo cannot
silently fall back. `xlf_status` prints the effective values and marks those
coming from the file.

## Typical workflows

**After a build that changed captions** — keep every language current:

```
xlf_status         { path: "<repo>" }                       what drifted
xlf_sync           { path: "<repo>", write: true }          add / update / remove units
xlf_apply_matches  { path: "<repo>", write: true }          reuse identical texts
xlf_list           { path: "<file>", filter: "needs-any" }  what is left
xlf_set_targets    { path: "<file>", entries: [...], write: true }
```

**A new language:**

```
xlf_create  { path: "<app>", languages: ["sv-SE"], searchPath: "<repo>", includePackages: true }
```

then `xlf_list` / `xlf_set_targets` for the rest.

## Good practices

- **Never edit the generated `.g.xlf`.** The next build overwrites it.
- **Sync after every build that touches captions**, before translating: a
  translator working on a stale file translates units that no longer exist and
  misses new ones.
- **Keep a changed source's old translation for review** rather than deleting it
  (`onSourceChange: "review"`): most source edits are small, and the old target
  is the translator's best starting point. Choose `"clear"` if an outdated
  translation must never reach users.
- **Use `state` honestly.** Machine output and reused matches are suggestions
  until someone reviews them; `needs-review-translation` plus a qualifier keeps
  them findable. `state=""` carries no information; `xlf_normalize_states`
  converts it.
- **Keep placeholders intact.** `%1`, `%2` are filled at runtime; a target that
  drops or adds one shows wrong or missing values. `xlf_status` counts
  mismatches, `xlf_list filter: "placeholders"` lists them.
- **Write a `Comment` on every label with placeholders** in AL
  (`Comment = '%1 = Customer No.'`). It reaches the translator as the Developer
  note.
- **Be consistent.** Check `xlf_find` before translating a term, and reuse the
  translation already shipped elsewhere in the repo or by Microsoft.
- **One file per language per app**, named `<App>.g.<lang>.xlf`, with
  `original` equal to the app name. A file translating *another* app must carry
  that app's name in `original` instead.
- **Review the diff.** Every write here is a minimal text change, so a pull
  request shows exactly which units moved.

## Install

```bash
git clone https://github.com/iti-mateusz-wojciechowski/xlf-mcp.git
cd xlf-mcp
npm install
npm test
npm run register
```

`npm run register` registers this checkout with Claude Code (`-- --local` for
the current directory only, `-- --print` to change nothing). Restart Claude
Code and confirm with `claude mcp list`.

Requires Node.js 18 or later. `XLF_MCP_VERBOSE=1` logs each call to stderr.

## License

MIT — see [LICENSE](LICENSE).
