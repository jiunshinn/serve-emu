---
name: open-pr
description: Create a pull request and attach real screenshots or a short recording of the changed screens. Use this skill whenever the user asks to create, open or send a PR ("open a PR", "create a pull request", "send this for review", "PR 올려줘", "PR 만들어줘") or to add screenshots or screen recordings to an existing PR. Reads the project profile (.agents/open-pr.md) written by the open-pr-setup skill, analyzes the diff, captures the changed screens from an Android emulator, iOS simulator or browser, verifies every capture visually, writes the body in the project's PR format, previews it with GitHub's renderer, asks for confirmation, then runs `gh pr create --attach` through scripts/submit.mjs. Not for commit-only requests or PR review/merge.
---

# open-pr — open a PR, with the changed screens attached

The reader of a PR is the reviewer. When a PR changes a screen, the first question is "what does it look like now?".
One screenshot, or a 10-second video when behavior changed, lets the reviewer judge without checking out the branch.

A wrong capture misleads the reviewer: a loading screen, a login redirect, or a screen the change does not touch.
So two parts of this skill need your judgment: **what to show**, and **opening every capture to verify it**. Build, install, capture, check and upload follow fixed steps.

## 0. Load the project profile

Read `.agents/open-pr.md` at the repository root. If it is not there, try `.claude/open-pr.md`. It holds the project facts this skill needs:
base branch rules, title convention, body sections, verify commands, platforms, capture commands, pitfalls and sensitive files.

- **No profile?** Run the `open-pr-setup` skill first, then come back. If the user wants to skip setup, use the defaults in `references/profile-template.md` and tell the user which defaults you used.
- **Profile out of date?** (a command fails, a path moved) Fix the capture, then propose the profile change to the user.
- Also obey the repository's own agent rules (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and similar). They win over this skill.

## Tool names

This skill works in any agent that supports Agent Skills (Codex, Claude Code, Antigravity, OpenCode, Devin and others). It names actions, not tools:

- **Ask the user**: use your agent's question tool if it has one. Otherwise ask in a message and wait for the answer.
- **Open an image**: use your agent's file or image viewer so that you see the pixels. A file listing is not enough.
- **Run a command**: use your shell tool.

If your agent cannot see images, tell the user. Then ask the user to check the captures before step 7.

## Flow

1. Status → 2. Analyze → 3. Plan captures → 4. Capture → 5. Verify → 6. Write body → 7. Check, preview, **confirm with the user** → 8. Submit → 9. Clean up

If no screen changed, skip steps 3–5 and drop the screenshots section from the body.

Keep the draft in `runs/open-pr/<slug>/`. The slug is the branch name with `/` replaced by `-`. Make sure `runs/` is git-ignored (the profile says where drafts go if the project uses another folder).

```
runs/open-pr/feat-adaptive-banner/
  media/          upload candidates      title.txt     PR title, one line
  check/          frames for review      body.md       PR body
  manifest.json   capture results        preview.html  GitHub-rendered preview
                                         result.json   PR number, missing attachments
```

`S=<folder of this SKILL.md>/scripts`. Use the path where this skill is installed, for example `.agents/skills/open-pr/scripts`, `~/.agents/skills/open-pr/scripts` or `.claude/skills/open-pr/scripts`.

## 1. Status

```bash
git rev-parse --abbrev-ref HEAD; git status --porcelain; gh pr list --head <branch> --state open
```

- **Base**: use what the user said. Otherwise use the profile's base rule. If the profile has none, use the repository default branch (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`).
- **Uncommitted user changes**: do not overwrite them. Use a separate worktree, or report and stop. Capture from the committed branch — a dirty work tree makes the screens differ from the PR.
- **Push gates**: obey the repository's pre-push hooks. Never use `--no-verify`. If a hook blocks the push, tell the user and stop.
- **An open PR already exists**: do not create another. Add screens or update the body (step 8).

## 2. Analyze

```bash
git fetch origin <base>
git log --oneline origin/<base>..HEAD
git diff --stat origin/<base>...HEAD
git diff origin/<base>...HEAD -- <files of interest>
```

Read the diff, not only the commit messages. If the change crosses an API contract, check both the producer and the consumer.

**Did a screen change?** The test is not the file path. The test is: "Before and after this PR, does the same screen look different?"
The profile's `Screen paths` table maps paths to platforms. Pure logic, tests, docs and config usually do not change a screen.

If the profile lists **platform parity** (for example iOS must match Android), capture both platforms **side by side**.

## 3. Plan captures — what to show

Read the profile's platform sections and `references/capture.md` first.

1. **The changed screen.** Find which screen (route, page, tab) shows the changed component.
2. **The state that shows the change.** If the first screen does not show it, plan the steps to get there: navigate, expand, type, scroll. Capturing an unrelated first screen is the most common mistake.
3. **Data.** A screen filled with realistic data tells the reviewer much more than an empty one. Use the profile's seed or demo data. Capture the empty state only when the empty state is the change.
4. **Devices and themes.** Use the profile's default device. Add a wide device when width matters (banners, sheets, full-width items). Capture a light/dark pair for theme changes.
5. **Screenshots.** Frame the changed area. Crop unrelated status bars and home indicators. Show each state as its own image under a sub-heading. Image references inside tables do not get replaced by upload URLs.
6. **Video.** When behavior changed, add at least one: open/close, transition, input feedback. One flow per video, 5–20 seconds.
7. **Amount.** The reviewer must scan it in one minute. Usually 2–4 screenshots and 0–1 video.

## 4. Capture

Use the profile's build, install, launch and capture commands. `references/capture.md` has generic commands for Android, iOS and web.

- On a ✗ failure or ⚠ warning (stuck at login, ad still loading, clipped layout), fix the cause and capture again. Check the profile's pitfall table first.

## 5. Verify — look before you upload

Open **every** `media/*.png` and every video frame sheet in `check/` with your image viewer. You cannot play a video, so look at its frames.

- Does the image show the change the summary describes?
- Is it free of loading spinners, empty screens, error overlays and login gates?
- Does the video run in the intended order, and do its first and last frames show meaningful states?
- Is it free of real names, contact details, tokens and other sensitive data? Use test accounts and test ad units.

If something is clipped or overlaps, decide whether the capture caused it (capture again) or the product has a bug.
**Do not hide a real bug.** Capture it as it is and note it in the body. At step 7, ask: "Fix it before the PR, or open the PR and note it?" Do not change product code yourself — the user asked only for a PR.

## 6. Write the body

Write the title to `title.txt` and the body to `body.md`. Use the profile's title convention, body sections and language.
If the profile has none, use this:

```markdown
## Summary
- What changed for the user, and why. 3–6 lines.

## Screenshots
### Home — banner aligned to the bottom (iPhone 17 / Pixel 8)

![iOS home with the banner at the bottom](./media/ios-banner.png) ![Android home with the banner at the bottom](./media/android-banner.png)

## Not changed
- (Only when the reviewer may worry) data format, sync behavior, and so on.

## Tests
- Only what you ran in this session, with the result.

## Notes
- (If any) problems found while capturing, screens you could not capture and why, follow-up work.
```

- Put **screenshots** right after the summary. Reviewers look at pictures before text. Give each image a sub-heading and one line on what to look at.
- Write specific **alt text**: the screen name and the visible state. Never `screenshot1`.
- Put each **video reference alone on its own line**, with blank lines before and after. Only then does GitHub render a player.
- Write references as **`./media/<file>`**. The submit script runs gh from the draft folder. `<img>` tags and references in tables are not replaced.
- **Tests**: write only checks you ran in this session. If you have no evidence, run the profile's verify command. For UI tests, write the device and launch arguments.
- If an **API response** changed instead of a screen, replace the screenshots section with a response example from a real request. If you could not run the server, say so and why.

## 7. Check, preview, confirm

```bash
node $S/submit.mjs runs/open-pr/<slug> --base <base> --check
```

This uploads nothing. It checks:

- referenced files exist, with a valid format and size (image 10 MB, video 100 MB; 10 MB on free plans)
- videos stand alone on a line, no references inside tables
- uncommitted changes, an already open PR, whether a push is needed

It also writes `preview.html` with GitHub's renderer. Fix every ✗ and run it again. Read every ⚠ and decide.

Then show the user everything at once and **get confirmation**. A push and a PR are hard to undo and notify the team.

- title, `base ← head`, commit count, attachment list
- the full `body.md`
- the `preview.html` path — open it in a browser to see the exact result, videos included
- if step 5 found a problem: the choice to fix it first or to note it

If the user asks for changes, apply them and run `--check` again.

## 8. Submit

```bash
node $S/submit.mjs runs/open-pr/<slug> --base <base>        # add --draft if wanted
```

The script pushes when needed, runs `gh pr create --attach …`, then checks that no local `./media/…` reference is left in the body.

- **Some uploads failed**: the exit code is not 0 but a PR URL is printed. The PR exists. Running create again makes a duplicate. Use `--repair <number>` to attach only what is left.
- **Replace the body of an open PR**: `--edit <number>`. It overwrites the body, so say so when you ask for confirmation.
- **Add screens without changing the body**: write `comment.md` in the draft folder, then run `gh pr comment <number> --body-file comment.md --attach ./media/…` from that folder.

Finish with the PR URL.

## 9. Clean up

Stop only the apps this skill launched. Do not touch emulators, simulators or servers the user started.
Shut down a simulator only if this skill booted it. Keep `runs/open-pr/<slug>/` for a re-capture or `--repair`.
