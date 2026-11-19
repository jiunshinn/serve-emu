---
name: open-pr-setup
description: Set up a repository for the open-pr skill. Inspects the project (branches, PR history, build files, mobile and web apps, verify scripts, hooks), checks the local tools (gh 2.99+, node, adb, xcrun, ffmpeg), asks the user only what the code cannot answer, and writes the project profile .agents/open-pr.md. Use when the user says "set up open-pr", "configure open-pr for this repo", "open-pr setup", or when the open-pr skill finds no profile. Also use to refresh an outdated profile.
---

# open-pr-setup — write the project profile for open-pr

The `open-pr` skill is generic. It reads the project facts from `.agents/open-pr.md`.
This skill finds those facts and writes that file. The format is in `../open-pr/references/profile-template.md`.

Find facts in the code first. Ask the user only for decisions the code cannot answer.

## 1. Check the tools

```bash
gh --version          # --attach needs gh 2.99.0 or later
gh auth status
node --version        # submit.mjs needs Node 18.3+ (util.parseArgs)
command -v adb xcrun ffmpeg npx
```

Report what is missing and what it blocks:

| Tool | Blocks |
|---|---|
| `gh` < 2.99 | all uploads — tell the user to upgrade (`brew upgrade gh`) |
| `node` | submit.mjs |
| `adb` / Android SDK | Android captures |
| `xcrun` / Xcode | iOS captures |
| `ffmpeg` | video frame sheets for verification (step 5 of open-pr) |
| `npx playwright` | web captures |

Do not install tools without the user's approval.

## 2. Inspect the repository

Read, do not guess:

- **Agent rules**: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`. They often state the base branch, title format and body sections.
- **Branches**: `gh repo view --json defaultBranchRef`, `git branch -r`. Look for `develop`, `main`, release branches.
- **PR history**: `gh pr list --state merged --limit 10 --json number,title,baseRefName` and read 2–3 bodies with `gh pr view <n> --json body`. Take the title convention, section headings and language from them. Pick one good PR as the example.
- **Verify commands**: `verify.sh`, `Makefile`, `package.json` scripts, `.github/workflows/*`, pre-commit hooks.
- **Android**: `settings.gradle*`, `app/build.gradle*` (`applicationId`), `AndroidManifest.xml` (launcher activity), debug seed or demo data.
- **iOS**: `*.xcodeproj`, `project.yml` (XcodeGen), `Project.swift` (Tuist), schemes, `PRODUCT_BUNDLE_IDENTIFIER`, UI test launch arguments (`launchArguments` in UI tests), debug harness code.
- **Web**: `package.json` dev script and port, auth bypass for local development.
- **Screen paths**: the folders that hold UI code for each platform.
- **Parity rules**: a rule that one platform must match another.
- **Sensitive files**: tracked secret files, `.env*`, `local.properties`, signing files. Record the **names** only. Never read or print their values.
- **Push gates**: `.githooks/`, `.husky/`, `core.hooksPath`.

## 3. Ask what the code cannot answer

Ask all questions at once, at most 4. Use your agent's question tool if it has one; otherwise ask in one message and wait. Typical questions:

- The base branch, when the branches and PR history disagree.
- The PR language, when PR history mixes languages.
- The default capture devices, when several emulators or simulators exist.
- How to reach a logged-in state for captures, when no test harness exists.

Skip a question when the repository already answers it.

## 4. Prove the capture path (optional, ask first)

A profile with untested commands fails later. Offer to run one capture per platform now: build, install, launch, screenshot, then open the image with your image viewer.
Record each failure and its fix in the profile's **Pitfalls** table. Building can take minutes, so ask before you start.

## 5. Write the profile

1. Copy the structure of `../open-pr/references/profile-template.md`.
2. Fill each section with the facts from steps 2–4. Delete the sections that do not apply.
3. Replace every `<placeholder>`. If a fact is unknown, write `TODO: <question>` and tell the user.
4. Write to `.agents/open-pr.md`. Every supported agent reads this one file, so do not write a copy for each agent. If an older `.claude/open-pr.md` exists, propose to move it. If the file exists, show the diff and get approval before you overwrite it.
5. Make sure the draft folder (default `runs/`) is in `.gitignore`. Propose the line if it is not there.

Never write secret values, tokens, real account credentials or personal data into the profile.

## 6. Report

Tell the user:

- the profile path, and which sections came from the code and which came from their answers
- the missing tools and the `TODO` items
- whether the capture path was proven (step 4)
- that the profile is a normal file: commit it so the team shares it, or keep it local by adding it to `.gitignore`

Do not commit the profile unless the user asks.
