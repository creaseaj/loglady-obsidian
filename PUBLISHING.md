# Publishing

How a version of this plugin gets released, and how it gets onto Obsidian's
Community Plugins list. Everything below is a maintainer task — nothing here
is needed to use or build the plugin.

## Cutting a release

Releases are built by `.github/workflows/release.yml` (the workflow from
Obsidian's `obsidian-sample-plugin`, plus a `npm test` step), which fires on
any pushed tag.

1. Bump `version` in `manifest.json` and `package.json` to the new semver
   number, and add a `"<version>": "<minAppVersion>"` line to `versions.json`
   so older Obsidian installs resolve the newest version they can run.
2. Commit, then tag the commit with the version number **exactly as it appears
   in `manifest.json`** — no `v` prefix. Obsidian looks for a release whose tag
   equals the manifest version:

   ```
   git tag 0.1.1
   git push origin 0.1.1
   ```

   Tag the merged commit on `main` that carries the version bump, not an
   earlier one — the manifest inside the tagged tree is what reviewers and the
   installer read.

3. The workflow runs `npm ci && npm run build && npm test`, attests the build,
   and opens a **draft** release with `main.js`, `manifest.json`, and
   `styles.css` attached as individual files (not zipped — Obsidian downloads
   them by name).
4. Review the draft release notes and publish it.

The built `main.js` is deliberately not committed (`.gitignore`), matching the
sample plugin: the release assets are the distribution channel.

**Don't create the release by hand in the GitHub UI.** Publishing a hand-made
draft creates the tag *at publish time* from whatever `main` points at, after
the workflow's chance to fire has passed — so nothing gets built and the
release goes out with an empty asset list, which Obsidian cannot install. That
is what happened to `0.1.0`, which is why the first real release is `0.1.1`.
Push the tag and let the workflow open the draft.

## Submitting to the Community Plugins list

One-time, and only after a published (non-draft, non-prerelease) release exists.

1. Fork [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases).
2. Append this entry to the **end** of `community-plugins.json`:

   ```json
   {
     "id": "loglady",
     "name": "LogLady",
     "author": "creaseaj",
     "description": "Import script(1) terminal session recordings (shell + timing logs) as clean command/output pairs: insert at cursor, or create linked notes with frontmatter.",
     "repo": "creaseaj/loglady-obsidian"
   }
   ```

   `id`, `name`, `author`, and `description` must match `manifest.json`
   verbatim; `repo` is the `owner/name` this plugin is published from.
3. Open a pull request against `obsidianmd/obsidian-releases` and fill in their
   template checklist. An automated validator comments first; a human review
   follows and can take a while.
4. Fix whatever the reviewers flag, push to the same branch, and the bot
   re-checks.

Once merged, the plugin appears in Settings → Community plugins → Browse, and
every later release published by the workflow above is picked up automatically
— no further PRs to `obsidian-releases`.

## Review-checklist notes

Things the review bot and reviewers check that this repo has already been
lined up against, worth not regressing:

- No `innerHTML` / `outerHTML` / `insertAdjacentHTML` — the panel builds DOM
  through `createEl`/`createDiv`/`createSpan`.
- No styling assigned from JavaScript. Visibility toggles go through the
  `loglady-hidden` class in `styles.css`, not `el.style`.
- No plugin-name heading at the top of the settings tab, and setting names are
  in sentence case.
- The command is registered as `Open panel`, not `LogLady: open panel` —
  Obsidian prefixes the plugin name itself.
- `manifest.json` carries `id`/`name`/`version`/`minAppVersion`/`description`/
  `author`/`authorUrl`/`isDesktopOnly`, with an `id` and `name` that don't
  mention Obsidian.
- Leaves are not detached in `onunload`.
