#!/usr/bin/env node
// submit.mjs — checks a PR draft folder (title.txt · body.md · media/) and opens the PR with gh pr create --attach.
//
//   node submit.mjs <draft dir> --base develop --check    check + preview.html only. Uploads nothing.
//   node submit.mjs <draft dir> --base develop [--draft]  push → create PR → confirm every attachment was replaced
//   node submit.mjs <draft dir> --edit 31                 replace the title and body of open PR #31 with this draft
//   node submit.mjs <draft dir> --repair 31               re-attach only the local references left in PR #31
//
// Only files that body.md references as `![alt](./path)` are uploaded. gh runs from the draft folder,
// so references must be relative to the draft folder (./media/...).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const MB = 1024 * 1024;
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const VIDEO = new Set([".mp4", ".mov", ".webm"]);
const REF = /!\[([^\]]*)\]\((\.\/[^)\s]+)\)/g;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string" },
    check: { type: "boolean" },
    draft: { type: "boolean" },
    edit: { type: "string" },
    repair: { type: "string" },
    "allow-dirty": { type: "boolean" },
  },
});
if (!positionals[0]) {
  console.error("usage: node submit.mjs <draft dir> --base <branch> [--check|--draft] | --edit <PR> | --repair <PR>");
  process.exit(2);
}
const dir = path.resolve(positionals[0]);
const sh = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const trySh = (cmd, args) => {
  try {
    return sh(cmd, args);
  } catch {
    return null;
  }
};

const errors = [];
const warns = [];
let attachments = [];
let git = { branch: sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]), commits: [], push: null };

checkGh();
if (opt.repair) process.exit(repair(opt.repair));

const title = readText("title.txt").split("\n")[0].trim();
const body = readText("body.md");
if (!title) errors.push("title.txt is empty");
attachments = inspectRefs(body);
git = inspectGit();

printPreview();
if (opt.check) {
  writePreviewHtml();
  process.exit(errors.length ? 1 : 0);
}
if (errors.length) {
  console.error("\nNot submitted: fix the errors above.");
  process.exit(1);
}
process.exit(opt.edit ? editPr(opt.edit) : createPr());

// ---------------------------------------------------------------------------

function checkGh() {
  const v = trySh("gh", ["--version"])?.match(/gh version (\d+)\.(\d+)/);
  if (!v) fail("gh CLI not found");
  if (+v[1] < 2 || (+v[1] === 2 && +v[2] < 99)) fail(`gh ${v[1]}.${v[2]} — --attach needs 2.99.0 or later. Upgrade gh`);
}

function readText(name) {
  const p = path.join(dir, name);
  if (!existsSync(p)) fail(`${p} not found`);
  return readFileSync(p, "utf8");
}

function inspectRefs(text) {
  const lines = text.split("\n");
  const seen = new Map();
  for (const m of text.matchAll(REF)) {
    const [raw, alt, ref] = m;
    const line = lines[text.slice(0, m.index).split("\n").length - 1];
    const ext = path.extname(ref).toLowerCase();
    const file = path.join(dir, ref);
    const kind = IMAGE.has(ext) ? "image" : VIDEO.has(ext) ? "video" : null;
    if (kind === "video" && line.trim() !== raw) warns.push(`${ref}: the video reference is not alone on its line, so it renders as a link, not a player`);
    if (/^\s*\|/.test(line)) warns.push(`${ref}: references inside tables are not always replaced with upload URLs — use a combined image (sheet)`);
    if (seen.has(ref)) {
      warns.push(`${ref} is referenced twice — the file is attached once`);
      continue;
    }
    if (!kind) errors.push(`${ref}: GitHub does not accept this format (png/jpg/gif/webp/svg/mp4/mov/webm)`);
    if (!existsSync(file)) {
      errors.push(`${ref}: file not found`);
      continue;
    }
    const bytes = statSync(file).size;
    if (kind === "image" && bytes > 10 * MB) errors.push(`${ref}: ${(bytes / MB).toFixed(1)}MB — image limit is 10MB`);
    if (kind === "video" && bytes > 100 * MB) errors.push(`${ref}: ${(bytes / MB).toFixed(1)}MB — video limit is 100MB`);
    else if (kind === "video" && bytes > 10 * MB) warns.push(`${ref}: ${(bytes / MB).toFixed(1)}MB — repositories on the Free plan have a 10MB limit`);
    if (kind === "image" && !alt.trim()) warns.push(`${ref}: alt text is empty`);
    seen.set(ref, { ref, kind, bytes });
  }
  if (/<img[^>]+src=["']\.\//i.test(text)) warns.push('<img src="./..."> is not replaced — use ![alt](./path)');
  const mediaDir = path.join(dir, "media");
  if (existsSync(mediaDir)) {
    // Single images that a referenced sheet was built from count as used.
    const manifest = existsSync(path.join(dir, "manifest.json")) ? (JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")).items ?? []) : [];
    const inSheets = new Set(
      manifest
        .filter((i) => i.kind === "sheet" && seen.has(`./${i.file}`))
        .flatMap((i) => i.from ?? [])
        .map((name) => manifest.find((x) => x.name === name)?.file),
    );
    const unused = readdirSync(mediaDir).filter((f) => !seen.has(`./media/${f}`) && !inSheets.has(`media/${f}`));
    if (unused.length) warns.push(`media/ files not used in the body (not uploaded): ${unused.join(", ")}`);
  }
  return [...seen.values()];
}

function inspectGit() {
  const { branch } = git;
  const info = { branch, commits: [], push: null, existing: null };
  if (opt.edit) return info;
  const base = opt.base;
  if (!base) {
    errors.push("--base is required");
    return info;
  }
  if (branch === base) errors.push(`the current branch is the base (${base}) itself`);
  // The repository's pre-push hooks own the push gates. Never bypass them; if a push is blocked, a person decides.
  // Captures come from the work tree, so uncommitted changes make the screens differ from the PR.
  const top = sh("git", ["rev-parse", "--show-toplevel"]); // check the whole repository, not only the draft folder
  const modified = sh("git", ["status", "--porcelain", "--untracked-files=no"], top);
  if (modified) {
    const msg = `uncommitted changes — they are not in the PR, but the screens were captured from the work tree:\n    ${modified.split("\n").join("\n    ")}`;
    (opt.check || opt["allow-dirty"] ? warns : errors).push(msg);
  }
  const untracked = sh("git", ["ls-files", "--others", "--exclude-standard"], top).split("\n").filter(Boolean);
  if (untracked.length) warns.push(`${untracked.length} untracked files — commit them if they are source: ${untracked.slice(0, 8).join(", ")}${untracked.length > 8 ? " …" : ""}`);
  if (!trySh("git", ["ls-remote", "--exit-code", "--heads", "origin", base])) errors.push(`origin has no ${base} branch`);
  else {
    trySh("git", ["fetch", "--quiet", "origin", base]);
    const log = trySh("git", ["log", "--oneline", `origin/${base}..HEAD`]) ?? "";
    info.commits = log ? log.split("\n") : [];
    if (!info.commits.length) errors.push(`no new commits compared to origin/${base}`);
  }
  const upstream = trySh("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream) info.push = "new branch — needs push -u";
  else {
    const ahead = +(trySh("git", ["rev-list", "--count", "@{u}..HEAD"]) ?? 0);
    if (ahead) info.push = `${ahead} unpushed commits`;
  }
  const open = JSON.parse(trySh("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"]) ?? "[]");
  if (open.length) {
    info.existing = open[0];
    errors.push(`PR #${open[0].number} is already open (${open[0].url}) — to change its body use --edit ${open[0].number}`);
  }
  return info;
}

function printPreview() {
  const line = (k, v) => console.log(`${k.padEnd(8)}  ${v}`);
  console.log("━━━━━━━━━━ PR preview ━━━━━━━━━━");
  line("title", title);
  if (opt.edit) line("target", `replace the title and body of PR #${opt.edit}`);
  else line("branch", `${opt.base} ← ${git.branch}  (${git.commits.length} commits${git.push ? `, ${git.push}` : ""})`);
  for (const c of git.commits.slice(0, 15)) console.log(`          ${c}`);
  if (git.commits.length > 15) console.log(`          … and ${git.commits.length - 15} more`);
  line("attach", attachments.length ? `${attachments.length}` : "none");
  for (const a of attachments) console.log(`          ${a.ref.padEnd(42)} ${(a.bytes / MB).toFixed(1)}MB  ${a.kind}`);
  line("body", path.join(dir, "body.md"));
  for (const w of warns) console.log(`⚠ ${w}`);
  for (const e of errors) console.log(`✗ ${e}`);
}

// Render the body with GitHub's own renderer so the user can see it in a browser before upload.
function writePreviewHtml() {
  const repo = trySh("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  const args = ["api", "markdown", "-F", "text=@body.md", "-f", "mode=gfm"];
  if (repo) args.push("-f", `context=${repo}`);
  const html = trySh("gh", args);
  if (!html) return console.log("(preview.html skipped — the GitHub markdown API call failed)");
  const withVideo = html.replace(/<a[^>]*>\s*<img[^>]*src="(\.\/[^"]+\.(?:webm|mp4|mov))"[^>]*>\s*<\/a>|<img[^>]*src="(\.\/[^"]+\.(?:webm|mp4|mov))"[^>]*>/gi, (_, a, b) => `<video controls muted src="${a ?? b}" style="max-width:100%;max-height:640px"></video>`);
  const page = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.8.1/github-markdown-light.min.css">
<style>body{background:#fff;margin:0}main{max-width:880px;margin:32px auto;padding:0 16px}h1.t{font:600 26px/1.3 system-ui,sans-serif;border-bottom:1px solid #d1d9e0;padding-bottom:12px}</style>
<main><h1 class="t">${escapeHtml(title)}</h1><article class="markdown-body">${withVideo}</article></main>`;
  writeFileSync(path.join(dir, "preview.html"), page);
  console.log(`preview   file://${path.join(dir, "preview.html")}`);
}

function attachArgs(list) {
  return list.flatMap((a) => ["--attach", a.ref]);
}

function createPr() {
  if (git.push) {
    console.log(`\n$ git push -u origin HEAD`);
    const pushed = spawnSync("git", ["push", "-u", "origin", "HEAD"], { cwd: dir, stdio: "inherit" });
    if (pushed.status !== 0) return fail("push failed — no PR was created"), 1;
  }
  const args = ["pr", "create", "--base", opt.base, "--head", git.branch, "--title", title, "--body-file", "body.md"];
  if (opt.draft) args.push("--draft");
  return runGh([...args, ...attachArgs(attachments)]);
}

function editPr(number) {
  return runGh(["pr", "edit", number, "--title", title, "--body-file", "body.md", ...attachArgs(attachments)], number);
}

function repair(number) {
  const remaining = leftoverRefs(number);
  if (!remaining.length) return console.log(`PR #${number}: no local references left — all attachments are uploaded`), 0;
  const missing = remaining.filter((r) => !existsSync(path.join(dir, r)));
  if (missing.length) return fail(`files missing from the draft folder: ${missing.join(", ")}`), 1;
  console.log(`PR #${number}: re-attaching ${remaining.length} — ${remaining.join(", ")}`);
  return runGh(["pr", "edit", number, ...remaining.flatMap((r) => ["--attach", r])], number);
}

function runGh(args, number) {
  console.log(`\n$ (cd ${path.relative(process.cwd(), dir) || "."} && gh ${args.map(quote).join(" ")})`);
  const res = spawnSync("gh", args, { cwd: dir, encoding: "utf8" });
  process.stderr.write(res.stderr ?? "");
  const url = (res.stdout ?? "").match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
  const target = url ?? (number ? number : null);
  if (!target) {
    // gh can fail after the PR was created — check before anyone runs create again.
    const open = trySh("gh", ["pr", "list", "--head", git.branch, "--state", "open", "--json", "number,url", "-q", ".[0].url"]);
    if (open) console.error(`gh failed, but the PR exists: ${open} — do not create again; use --repair`);
    else console.error("No PR was created.");
    return 1;
  }
  const prNumber = String(target).match(/(\d+)$/)[1];
  const left = leftoverRefs(prNumber);
  const result = { url: url ?? null, number: +prNumber, ghExit: res.status, missing: left };
  writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
  if (left.length) {
    console.error(`\n⚠ ${left.length} attachments not uploaded: ${left.join(", ")}`);
    console.error(`  repair: node ${path.relative(process.cwd(), process.argv[1])} ${path.relative(process.cwd(), dir)} --repair ${prNumber}`);
    return 1;
  }
  console.log(`\n✓ ${url ?? `PR #${prNumber}`} — all attachments in the body are uploaded`);
  return res.status === 0 ? 0 : 1;
}

function leftoverRefs(number) {
  const prBody = trySh("gh", ["pr", "view", String(number), "--json", "body", "-q", ".body"]) ?? "";
  return [...new Set([...prBody.matchAll(REF)].map((m) => m[2]))];
}

function quote(s) {
  return /^[\w./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
