# open-pr profile — <project name>

<!--
  Project profile for the open-pr skill. Location: .agents/open-pr.md at the repository root.
  The open-pr-setup skill writes this file. Edit it by hand when the project changes.
  Never put secret values here. Name the secret files only.
  Delete a section that does not apply (for example "iOS" in a web-only project).
-->

## PR

- **Base branch**: `<develop>` for feature branches; `<main>` for release PRs from `<develop>`.
- **Title**: `<type>(<scope>): <summary>` (Conventional Commits), at most 70 characters.
- **Language**: <English>
- **Draft folder**: `runs/open-pr/<slug>/` (git-ignored)
- **Body sections**, in order:
  1. `## Summary`
  2. `## Screenshots` (only when a screen changed)
  3. `## Not changed` (optional)
  4. `## Tests`
  5. `## Notes` (optional)
- **Example PR**: <#123 — a PR whose body is a good model>

## Verify

- **Change-scoped check**: `<./verify.sh>`
- **Extra checks per module**: <`swift test` in `ios/Kit`; `./gradlew testDebugUnitTest` in `mobile/`>

## Screen paths

| Path | Platform | Screen change? |
|---|---|---|
| `<mobile/app/src/main/**/ui/**>` | Android | almost always |
| `<ios/App/Sources/Screens/**>` | iOS | almost always |
| `<web/src/components/**>` | Web | almost always |
| `<backend/**>`, tests, docs, config | — | no (check API output) |

- **Platform parity**: <iOS must match Android; capture both side by side> / <none>

## Android

- **Module**: `<mobile>` · **Install**: `<./gradlew :app:installDebug>`
- **Launch**: `<adb shell am start -n com.example.app/.MainActivity>`
- **Default device**: `<emulator-5554, Pixel 8 API 35>`
- **Seed / demo data**: <how to fill screens with test data>

## iOS

- **Project**: `<ios/App/App.xcodeproj>` · **Scheme**: `<App>` · **Bundle ID**: `<com.example.app>`
- **Generate first**: <`xcodegen generate` / none>
- **Build**: `<xcodebuild … build>` (with any required overrides)
- **Launch arguments**: `<--uitest-auth --seed>` (what each one does)
- **Default device**: `<iPhone 17>` · **Wide device**: `<iPhone 17 Pro Max>`

## Web

- **Dev server**: `<npm run dev>` at `<http://localhost:3000>`
- **Login for captures**: <test account or auth bypass; never a real account>

## Pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| <Debug build points to the dev backend> | <fake session gets 401, app shows login> | <build with API_BASE_URL=""> |
| <Ads load slowly> | <empty banner slot> | <wait 15–25 s after launch> |

## Sensitive

- **Do not print or log**: `<Secrets.xcconfig>`, `<.env>`, `<local.properties>`
- **Do not touch**: <the user's physical devices, production servers>
- **Push gates**: <`.githooks/pre-push` rule; never `--no-verify`>
