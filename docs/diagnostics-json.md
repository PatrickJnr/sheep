# Machine-readable diagnostics

`baa check`, `baa lint` and `baa fmt` accept `--format json`. They then write
one JSON object to stdout and nothing else, so a tool can read the stream
without filtering prose out of it first.

```console
$ baa check --format json src/
{"version":1,"baa":"0.8.0","command":"check","wording":"woolly","ok":false,...}
```

The object is on a single line, and every run writes exactly one. That makes a
log of several runs valid [JSON Lines](https://jsonlines.org) as well as valid
JSON, so appending reports to a file needs no separator and no bracket
counting.

This is a second *presentation* of the same diagnostics the terminal shows, not
a second analysis. Nothing is re-parsed out of formatted text, so JSON cannot
report a problem the terminal would not, or miss one it does.

---

## Which commands

| Command | `--format json` | Reports |
| --- | --- | --- |
| `baa check` | yes | Parse and analysis diagnostics |
| `baa lint` | yes | The same, plus lint warnings |
| `baa fmt` | yes | Parse failures, and the files that would change |
| everything else | no, refused with `BAA301` | — |

`baa run` and `baa test` are refused deliberately. There, stdout belongs to
your program: a report written into that stream would be interleaved with
whatever the program printed, and nothing downstream could tell the two apart.
Refusing says so; writing anyway would not.

`baa fmt --format json` never writes a file. It reports what would change, the
way `--check` and `--diff` do.

---

## The envelope

```json
{
  "version": 1,
  "baa": "0.8.0",
  "command": "check",
  "wording": "woolly",
  "ok": false,
  "errors": 1,
  "warnings": 2,
  "files": 7,
  "diagnostics": []
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | number | Schema version. Increases only for a breaking change. |
| `baa` | string | The release that produced the report. |
| `command` | string | `check`, `lint` or `fmt`. |
| `wording` | `"woolly"` \| `"plain"` | Which wording each `message` carries. |
| `ok` | boolean | True when the command exited `0`. |
| `errors` | number | Diagnostics with severity `error`. |
| `warnings` | number | Diagnostics with severity `warning`. |
| `files` | number | How many files the command looked at. |
| `diagnostics` | array | Every diagnostic, in the order the terminal shows them. |
| `changed` | array of string | `fmt` only: the files whose formatting would change. |

`ok` is not simply `errors === 0`. `lint --deny-warnings` fails on warnings and
`fmt` fails when a file would change, and a consumer should not have to
re-implement either rule to know whether the command passed.

---

## A diagnostic

```json
{
  "code": "BAA102",
  "severity": "error",
  "message": "`sheap` is not part of the current flock.",
  "messages": {
    "woolly": "`sheap` is not part of the current flock.",
    "plain": "Undefined name `sheap`."
  },
  "file": "src/main.baa",
  "range": {
    "start": { "line": 4, "column": 19, "offset": 83 },
    "end": { "line": 4, "column": 24, "offset": 88 }
  },
  "note": "not found in this pasture",
  "related": [],
  "help": ["did you mean `sheep`?"],
  "trace": []
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `code` | string | The stable `BAAnnn` code. Codes never change meaning. |
| `severity` | `"error"` \| `"warning"` | Errors fail the command; warnings do not, unless `--deny-warnings`. |
| `message` | string | The wording this run would print. |
| `messages.woolly` | string | The default, sheep-flavoured wording. |
| `messages.plain` | string | The neutral wording, as under `--no-baa`. |
| `file` | string \| null | Null when the diagnostic is about a command rather than a place. |
| `range` | object \| null | Null for the same reason. |
| `note` | string \| null | The short label the terminal renders under the span. |
| `related` | array | Other spans worth looking at: `{ file, range, note }`. |
| `help` | array of string | The `= help:` lines. |
| `trace` | array | Runtime call stack, innermost first: `{ name, file, range }`. |

Both wordings are always present. CI annotations usually want `plain`, an
editor usually wants `woolly`, and neither should have to re-run Baa with a
different flag to get the other.

### Positions

`line` and `column` are 1-based, matching the `file:line:column` the terminal
prints and what an editor shows in its status bar. Columns count UTF-16 code
units, which is what the Language Server Protocol uses, so a position can be
handed to an editor unchanged.

`offset` is 0-based, for tools that slice the file rather than count lines.

`end` is exclusive: a zero-width range has `start` equal to `end`.

---

## Using it

Annotating a GitHub Actions run, without a regular expression anywhere:

```bash
baa check --format json . | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    for (const d of JSON.parse(raw).diagnostics) {
      const level = d.severity === "error" ? "error" : "warning";
      console.log(
        `::${level} file=${d.file},line=${d.range.start.line},` +
        `col=${d.range.start.column},title=${d.code}::${d.messages.plain}`,
      );
    }
  });
'
```

Failing a build only on a particular code:

```bash
baa lint --format json . | jq -e '[.diagnostics[] | select(.code == "BAA905")] | length == 0'
```

Listing what `baa fmt` would rewrite:

```bash
baa fmt --format json . | jq -r '.changed[]'
```

---

## Compatibility

Within a `version`, fields are added but never removed and never repurposed.
Read the fields you need and ignore the rest, and a consumer written today
keeps working. If a breaking change ever becomes necessary, `version` goes up
and both are supported for at least one minor release.

Diagnostic codes carry the same promise `docs/errors.md` makes: a code never
changes meaning, and a new diagnostic takes a new number.
