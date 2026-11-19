# open-pr profile — serve-emu

<!--
  Project profile for the open-pr skill. Location: .agents/open-pr.md at the repository root.
  Edit it by hand when the project changes. Never put secret values here.
-->

## PR

- **Base branch**: `main` (stacked PRs target the branch below them, e.g. `feat/deep-link-api`).
- **Title**: `<type>(<scope>): <summary>` (Conventional Commits), at most 70 characters. Scopes in use: `apps`, `devices`, `scrcpy`, `ui`, `readme`, `foldable`, `agents`.
- **Language**: English
- **Draft folder**: `runs/open-pr/<slug>/` (git-ignored)
- **Body sections**, in order:
  1. `## Summary` — user-visible change and why; pseudo-diffs or before/after tables over prose
  2. `## Checks` — commands run (`bun run check`, `test:browser`) and new tests
  3. `## Evidence` — screenshots or a short recording (only when the UI or runtime behavior changed), with the emulator/device model and Android version
  4. `## Notes` (optional) — protocol, latency, or compatibility risks; stack order for stacked PRs
- **Example PR**: #186 — feat(apps): open deep links through VIEW intents
- **Rules** (CONTRIBUTING.md): small focused PRs; atomic commits listing each path explicitly (`git commit -m "…" -- <paths>`); media goes in the PR as GitHub attachments, never committed (`*.mp4`, `*.mov` are git-ignored).

## Verify

- **Change-scoped check**: `bun run check` (docs, knip, coverage floors, typechecks, build, package smoke — same steps as CI "Package check")
- **Extra checks**: `bun run --filter serve-emu test:browser` (Playwright streaming suite; run `bunx playwright install chromium` once). Edited the root `README.md`? Run `bun run docs:sync`.

## Screen paths

| Path | Platform | Screen change? |
|---|---|---|
| `packages/serve-emu/src/ui/**` | Web | almost always |
| `packages/serve-emu/src/shared/**` | Web + server | sometimes (wire contracts the UI renders) |
| `packages/serve-emu/src/scrcpy.ts`, `src/server/video.ts`, `src/ui/lib/stream-*.ts` | Web (live stream) | runtime: show the stream recovering/playing |
| `packages/serve-emu/src/api/**`, other `src/*.ts` | — | no (show the API request and response instead) |
| tests, docs, `scripts/`, config | — | no |

- **Platform parity**: none

## Web

- **Device**: the browser UI streams an Android emulator. Boot one first, in its own long-lived shell:
  `emulator -avd pixel -no-window -no-audio -gpu swiftshader_indirect` (boots in ~40 s; check with `adb devices`).
  If `/dev/kvm` is not accessible, add your user to the `kvm` group (`sudo usermod -aG kvm $USER`, then re-login). Use `sudo chmod 666 /dev/kvm` only on a single-user throwaway VM such as Devin's.
- **Build UI**: `bun run --filter serve-emu setup` (fetches scrcpy server + builds the UI)
- **Server**: `bun run packages/serve-emu/src/cli.ts` at `http://127.0.0.1:3300` (UI dev server with HMR: `bun run --filter serve-emu dev:ui` at `http://localhost:5173`, proxies to 3300)
- **Login for captures**: none on loopback. With `--token <t>`, open `/?token=<t>` once; it sets the `semu_session` cookie. Never show the token in a capture.
- **Default devices**: AVD `pixel` (phone). Others on the box: `emulator -list-avds`.

## Pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| UI opened through a proxy/preview host | `403` from serve-emu | start the CLI with `--allowed-host <hostname>` |
| More than one device booted | CLI refuses to pick a device | pass `-s <serial>` |
| Capture taken before the first keyframe | black or grey video area | wait for the stream to show frames (check `/health`) before capturing |
| `gh` older than 2.99 on the Devin Linux VM (2.78) | `gh pr create --attach` unknown flag | upgrade `gh`, or upload media another way |

## Sensitive

- **Do not print or log**: `.env*` files (git-ignored), any `--token` value, `semu_session` cookie
- **Do not touch**: the user's physical devices connected over adb unless asked
- **Push gates**: none (no git hooks); CI runs "Package check" and "Browser streaming integration"
