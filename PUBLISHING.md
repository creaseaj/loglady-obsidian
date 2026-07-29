# Publishing

How a version of this plugin gets released, and how it gets onto Obsidian's
Community Plugins list. Everything below is a maintainer task — nothing here
is needed to use or build the plugin.

## Cutting a release

Releases are built by `.github/workflows/release.yml` (the workflow from
Obsidian's `obsidian-sample-plugin`, plus a `npm test` step). It runs
`npm ci && npm run build && npm test`, attests the build, and attaches
`main.js`, `manifest.json`, and `styles.css` as individual files — not zipped,
because Obsidian downloads them by name. The built `main.js` is deliberately
not committed (`.gitignore`): the release assets are the distribution channel.

First, in either flow, bump the version:

1. Set `version` in `manifest.json` **and** `package.json` to the new semver
   number, and add a `"<version>": "<minAppVersion>"` line to `versions.json`
   so older Obsidian installs resolve the newest version they can run.
2. Commit and merge that to `main`. The tag must land on the commit carrying
   the bump — the manifest inside the tagged tree is what reviewers and the
   installer read.

The tag name is the version **exactly as it appears in `manifest.json`**, with
**no `v` prefix** — Obsidian matches the release tag to the manifest version.
The workflow fires on both triggers below, so either flow works.

### From the GitHub UI

1. **Releases → Draft a new release**.
2. **Choose a tag** → type the version (e.g. `0.1.1`) → **Create new tag: … on
   publish**. **Target** = `main`.
3. Add a title (the version), then **Publish release**.
4. The `release: published` trigger builds and uploads the three assets to that
   release within a minute or two. Refresh the release page to see them.

### From the CLI

```
git tag 0.1.1        # exact manifest version, no "v"
git push origin 0.1.1
```

The `push` tag trigger builds and opens a **draft** release with the assets
attached; review its notes and publish it.

Either way the final step converges on the workflow's "Attach plugin assets"
step, which uploads to an existing (UI-published) release or opens a fresh
draft (pushed tag) as appropriate. Do **not** attach the assets by hand: an
empty release is what Obsidian cannot install, and it is what happened to
`0.1.0` — the reason the first real release is `0.1.1`.

## Submitting to the Community Plugins list

One-time, and only after a published (non-draft, non-prerelease) release exists.

1. Fork [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases).
2. Append this entry to the **end** of `community-plugins.json`:

   ```json
   {
     "id": "loglady",
     "name": "LogLady",
     "author": "creaseaj",
     "description": "Import script(1) terminal session recordings (shell + timing logs) as clean command/output pairs, and drag any command straight into a note.",
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
