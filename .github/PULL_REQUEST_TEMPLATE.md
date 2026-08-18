<!--
Thanks for contributing. Small, focused pull requests get reviewed quickly.
See CONTRIBUTING.md for the house rules.
-->

## What this changes

<!-- One or two sentences. What problem does this solve? -->

Fixes #

## Before and after

<!-- A snippet is worth three paragraphs. Delete if not user-facing. -->

```baa
// before

// after
```

## Checklist

- [ ] `npm run ci` passes (typecheck, format check, lint, tests)
- [ ] Tests cover the change, at the layer where it happens
- [ ] Any new diagnostic has a `BAAnnn` code with **both** wordings, and
      `node tools/gen-docs.ts` has been run
- [ ] `SPEC.md` updated, if semantics changed
- [ ] `LANGUAGE.md` updated, if it is user-facing
- [ ] `CHANGELOG.md` updated
- [ ] An example added or extended, and `node tools/record-examples.ts` re-run,
      if the change is worth showing

## Notes for the reviewer

<!-- Anything you are unsure about, or decisions worth a second opinion. -->
