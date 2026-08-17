# symbolmarks

Bookmark **symbols** — not just line numbers. Put your cursor on a class, function,
call site, or plain line and Symbolmarks anchors to it by its place in the symbol
tree, so the bookmark survives edits and moves. Organize bookmarks into nested
folders and reorder everything from the keyboard.

## Features

- **Symbol-aware bookmarks.** Anchors to the enclosing symbol (`OrderService › processRefund`), a line inside a symbol, or a raw line — and re-resolves on click even after the code moves.
- **Folders.** Group bookmarks into nested folders (up to 3 levels by default).
- **Keyboard reordering.** Move any symbol or folder up/down; at the edge of a folder it pops out one level.
- **Drag & drop.** Drop onto a folder to move into it, onto a symbol to drop just before it, or onto empty space to move to the root.
- **Sort toggle.** Switch between manual order and alphabetical.

## Usage

| Action | Shortcut |
| --- | --- |
| Bookmark the symbol/line under the cursor | `⌘⌥K` (mac) · `Ctrl+Alt+K` |
| Move selected item up / down (view focused) | `⌘↑` / `⌘↓` (mac) · `Alt+↑` / `Alt+↓` |
| New folder | title-bar button |
| Rename / delete / new subfolder | hover a folder row |

Click a bookmark to jump to it — focus stays in the sidebar so you can immediately reorder with `⌘↑`/`⌘↓`.

## Settings

- `symbolmarks.maxGroupDepth` (default `3`) — maximum number of nested folder levels.

## Install (for others)

No Marketplace account needed. You install a packaged `.vsix` file — get it either
by **building it** (see below) or by **downloading it from a GitHub Release**.

Once you have the file:

```bash
code --install-extension symbolmarks-0.0.1.vsix
```

Or in VS Code: **Extensions** panel → `⋯` menu → **Install from VSIX…**

To share the file with teammates, attach the `.vsix` to a
[GitHub Release](https://docs.github.com/en/repositories/releasing-projects-on-github)
(or just send them the file directly) — don't add it to the repo.

## Build & package from source

```bash
npm install
npm run package                          # type-check, lint, production bundle
npx @vscode/vsce package --allow-missing-repository   # → symbolmarks-0.0.1.vsix
```

Then install the generated `.vsix` with the command above. To iterate, open the
folder in VS Code and press `F5` to launch an Extension Development Host.

## Publishing (optional)

If you later want a one-click install for everyone:

- **VS Code Marketplace** — create a publisher at <https://marketplace.visualstudio.com/manage>, get an Azure DevOps Personal Access Token, then `npx @vscode/vsce publish`.
- **Open VSX** (used by VSCodium/Cursor/etc.) — `npx ovsx publish symbolmarks-0.0.1.vsix -p <token>`.

Both read metadata from `package.json`; set a real `publisher`, `repository`, and bump `version` before publishing.
