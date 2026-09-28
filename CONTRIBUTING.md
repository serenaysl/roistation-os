# Contributing

Thank you for taking the time to look at this project.

ROIstation Master Panel is a production system published as a portfolio repository under an **all-rights-reserved** license (see [LICENSE](LICENSE)). That shapes how contributions work:

- **Issues are welcome** — bug reports, questions about design decisions, documentation fixes and suggestions.
- **Pull requests** are welcome for documentation and clear bug fixes. By opening a pull request you agree that your contribution may be incorporated into the project under its license, and you confirm you have the right to grant that.
- For larger changes, please open an issue first so we can agree on the approach.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through [SECURITY.md](SECURITY.md), never public issues.

## Development setup

```bash
npm ci
cp .env.example .env.local   # set the admin password, session secret and a Blob token
npm run dev
```

Before opening a pull request:

```bash
npm run verify   # build → typecheck → smoke → integration
```

The integration test builds against the **demo catalog**; leave `NEXT_PUBLIC_ROISTATION_SITES` unset when you run it. See [docs/Developer-Guide.md](docs/Developer-Guide.md) for how the test fixture works.

## Conventions

- **Structure.** Route handlers stay thin: guard (`requireAdmin`), validate, call a service in `lib/`, respond. Put domain logic in `lib/`; keep modules that the UI imports free of Node APIs.
- **Storage.** One Blob object per record. Use `createJson` for inserts, `replaceJson` (ETag compare-and-swap) for updates, `overwriteJson` only for independent observations. Never introduce a shared multi-record document.
- **Validation.** Parse request bodies explicitly; validate ids with the existing regular expressions and stored documents with the `parse*` functions in `lib/records.ts`.
- **Errors.** Throw `ApiError` with an actionable Turkish message for users; log technical detail on the server.
- **Language.** UI copy is Turkish; identifiers, comments, commit messages and docs are English.
- **Dependencies.** Prefer platform APIs and small typed clients over new runtime dependencies. Explain any new dependency in the pull request.
- **Data.** Never commit client names, domains, tokens or real submissions. Use the demo catalog in `lib/sites.ts`.
- **Accessibility.** Status is always icon + label, never colour alone; respect `prefers-reduced-motion`.

## Commit messages

Use short, imperative subjects with an optional scope, for example:

```
seo: treat missing sitemap as critical in issue priority
publishing: reject demo generations on the server
docs: document requireCronSecret
```

## Pull request checklist

- [ ] `npm run verify` passes locally.
- [ ] New behaviour is covered by the integration test or explained in the PR if it cannot be.
- [ ] Docs in `docs/` are updated when behaviour, APIs or environment variables change.
- [ ] No client data or secrets in code, fixtures, screenshots or logs.
