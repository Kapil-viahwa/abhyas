# Security exceptions

Every advisory that remains after the phase 0 upgrades, with its scope and why it is accepted. The audit gate itself is never lowered: `pnpm audit:ci` fails on any **high or critical advisory in a production dependency**, and reports the rest as warnings.

Last verified: the `audit` job in [run 41312437972](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972) (job [124865446644](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446644), commit `0f96b9d`) — 2 production advisory, both moderate, 0 blocking high/critical; 6 dev-only findings. Every remaining finding is listed below with its scope.

## Production dependencies (moderate only — gate does not block, recorded for visibility)

| Package | Advisory | Severity | Path | Why it is accepted | What removes it |
| --- | --- | --- | --- | --- | --- |
| `glob` | GHSA-3g3m-2fjr-6pw4 | moderate | `apps/api > @fastify/static@10.1.8 > glob@13.0.6` | Reached only through Swagger's static file serving at `/api/docs`; the advisory is in `glob`'s pattern matching, not in request handling of our own routes. No patched `glob` 13.x is published that `@fastify/static` accepts. | `@fastify/static` releasing against a patched `glob`, or replacing Swagger UI with a pre-rendered document in a later phase. |
| `minimatch` | GHSA-g3hv-75wg-m249 | moderate | `apps/api > @fastify/static@10.1.8 > glob@13.0.6 > minimatch@10.2.6` | Same chain as above: transitive inside `glob`, used for static asset patterns. | Same as above. |

## Dev-only dependencies (never shipped in an image)

These run only on developer machines and CI runners. They are not copied into the API, web or worker images, and no production traffic can reach them.

| Package | Advisory | Severity | Path | Why it is accepted | What removes it |
| --- | --- | --- | --- | --- | --- |
| `tinypool` | GHSA-5gmw-xhrv-c9v3 | critical | `. > vitest@3.2.7 > tinypool@1.1.1` | Test worker pool only. `vitest@3` requires `tinypool@^1`, so overriding it to the patched 2.x line would break the runner; the fix is the vitest 4 upgrade, not an override. | vitest 4 (which uses `tinypool@2`). |
| `tinypool` | GHSA-85c8-ppgw-ccpr | critical | `. > vitest@3.2.7 > tinypool@1.1.1` | Same as above. | vitest 4. |
| `@vitest/mocker` | GHSA-82fw-gwwq-j7x9 | moderate | `. > vitest@3.2.7 > @vitest/mocker@3.2.7` | Test-only module mocking. | vitest >= 4.1.11. |
| `@vitest/mocker` | GHSA-qxg6-89mg-rqv8 | moderate | `. > vitest@3.2.7 > @vitest/mocker@3.2.7` | Same as above. | vitest >= 4.1.12. |
| `vitest` | GHSA-82fw-gwwq-j7x9 | moderate | `. > vitest@3.2.7` | The runner itself; only used to execute tests. | vitest >= 4.1.11. |
| `minimatch` | GHSA-g3hv-75wg-m249 | moderate | `. > @typescript-eslint/* > @typescript-eslint/typescript-estree@8.72.1 > minimatch@10.2.6` | Lint tooling only. | typescript-eslint against `minimatch >= 11.0.1`. |

## Overrides in force

`package.json` pins these through `pnpm.overrides`, each with a reason in `docs/decisions.md`:

- `postcss >= 8.5.18` — `next@15` pins `postcss@8.4.31`.
- `js-yaml >= 4.3.2` and `lodash >= 4.17.24` — pinned by `@nestjs/swagger` 7 before the 11 upgrade; kept as a floor.
- `fastify >= 5.12.5` — `@nestjs/platform-fastify` keeps its own nested copy below the patched line.

## Secret scan

`gitleaks` runs on every push and pull request, and its default rules are not
adjusted. One exception is recorded, in `.gitleaks.toml`: the browser suite
needs accounts to sign in with against a disposable `docker compose` stack, so
its spec files define throwaway credentials as constants (`administrator-9pass`,
`editorial-9pass`, and so on). Those values are listed by exact regex, written
with a character class so the configuration does not reproduce them, and they
are useless outside a local or CI stack because production refuses the
development shortcuts around sign-in (decisions 0005 and 0009). A real secret in
a spec file — or anywhere else — is still reported.

## Follow-up

The dev-only findings are closed by moving to vitest 4 once the workspace's test configs are migrated. That is tracked in `PROGRESS.md` as a known gap, not silently dropped.
