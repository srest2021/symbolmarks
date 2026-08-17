import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Bookmark, Group } from './types';
import { BookmarkStore } from './storage';
import { BookmarksProvider, Node, isBookmark } from './tree';
import { describeAnchor, resolveBookmark } from './symbols';

export function activate(context: vscode.ExtensionContext) {
	const store = new BookmarkStore(context);
	const provider = new BookmarksProvider(store);

	const view = vscode.window.createTreeView('symbolmarks.view', {
		treeDataProvider: provider,
		dragAndDropController: provider,
		canSelectMany: true,
	});
	context.subscriptions.push(view);

	// Bookmark the symbol / line under the cursor.
	const bookmark = vscode.commands.registerCommand('symbolmarks.bookmark', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('Symbolmarks: open a file and place the cursor first.');
			return;
		}
		const position = editor.selection.active;
		const anchor = await describeAnchor(editor.document, position);
		const entry: Bookmark = {
			id: randomUUID(),
			uri: editor.document.uri.toString(),
			fallbackLine: position.line,
			fallbackChar: position.character,
			order: 0,
			...anchor,
		};
		const existing = store.findDuplicate(entry);
		if (existing) {
			const choice = await vscode.window.showWarningMessage(
				`Already bookmarked: ${existing.label}`,
				{ modal: true },
				'Add Anyway',
				'Reveal Existing',
			);
			if (choice === 'Reveal Existing') {
				await view.reveal(existing, { select: true, focus: true });
				return;
			}
			if (choice !== 'Add Anyway') {
				return; // dismissed
			}
			// fall through to add a second copy
		}
		await store.add(entry);
		provider.refresh();
		vscode.window.showInformationMessage(`Bookmarked: ${entry.label}`);
	});

	// Jump to a bookmark (invoked by clicking a tree item).
	const jump = vscode.commands.registerCommand('symbolmarks.jump', async (target: Bookmark) => {
		try {
			const { uri, range, stale } = await resolveBookmark(target);
			// preserveFocus: keep focus in the tree so cmd+↑/↓ can reorder right after clicking.
			const editor = await vscode.window.showTextDocument(uri, {
				preview: false,
				preserveFocus: true,
			});
			editor.selection = new vscode.Selection(range.start, range.start);
			editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
			if (stale) {
				vscode.window.showWarningMessage(
					`Symbolmarks: "${target.label}" may have moved — jumped to last-known location.`,
				);
			}
		} catch {
			vscode.window.showErrorMessage(`Symbolmarks: could not open "${target.label}".`);
		}
	});

	// Remove a bookmark (tree item context / inline action).
	const remove = vscode.commands.registerCommand('symbolmarks.remove', async (target: Bookmark) => {
		if (!target) {
			return;
		}
		await store.remove(target.id);
		provider.refresh();
	});

	// Rename a bookmark's label.
	const rename = vscode.commands.registerCommand('symbolmarks.rename', async (target: Bookmark) => {
		if (!target) {
			return;
		}
		const title = await vscode.window.showInputBox({
			prompt: 'Bookmark title (leave empty to use the symbol name)',
			value: target.title ?? '',
			placeHolder: target.label,
		});
		if (title === undefined) {
			return; // cancelled
		}
		// Empty clears the custom title and reverts to the derived label.
		await store.update(target.id, { title: title.trim() || undefined });
		provider.refresh();
	});

	// Toggle between alphabetical and manual (custom) sort.
	const toggleSort = vscode.commands.registerCommand('symbolmarks.toggleSort', async () => {
		const next = store.sortMode() === 'alpha' ? 'manual' : 'alpha';
		await store.setSortMode(next);
		provider.refresh();
		vscode.window.setStatusBarMessage(
			`Symbolmarks: ${next === 'alpha' ? 'alphabetical' : 'manual'} sort`,
			2000,
		);
	});

	// Clear all bookmarks (with confirmation).
	const clearAll = vscode.commands.registerCommand('symbolmarks.clearAll', async () => {
		if (store.all().length === 0) {
			return;
		}
		const choice = await vscode.window.showWarningMessage(
			'Remove all Symbolmarks bookmarks?',
			{ modal: true },
			'Clear All',
		);
		if (choice === 'Clear All') {
			await store.clear();
			provider.refresh();
		}
	});

	// --- folders (groups) ---

	const newGroup = vscode.commands.registerCommand('symbolmarks.newGroup', async () => {
		await createGroup(undefined);
	});

	const newSubgroup = vscode.commands.registerCommand(
		'symbolmarks.newSubgroup',
		async (parent: Group) => {
			if (parent) {
				await createGroup(parent.id);
			}
		},
	);

	async function createGroup(parentId: string | undefined): Promise<void> {
		const name = await vscode.window.showInputBox({ prompt: 'Folder name' });
		if (!name?.trim()) {
			return;
		}
		await store.addGroup({ id: randomUUID(), name: name.trim(), parentId, order: 0 });
		await store.setSortMode('manual');
		provider.refresh();
	}

	const renameGroup = vscode.commands.registerCommand(
		'symbolmarks.renameGroup',
		async (target: Group) => {
			if (!target) {
				return;
			}
			const name = await vscode.window.showInputBox({ prompt: 'Folder name', value: target.name });
			if (!name?.trim()) {
				return;
			}
			await store.renameGroup(target.id, name.trim());
			provider.refresh();
		},
	);

	const deleteGroup = vscode.commands.registerCommand(
		'symbolmarks.deleteGroup',
		async (target: Group) => {
			if (!target) {
				return;
			}
			await store.removeGroup(target.id);
			provider.refresh();
		},
	);

	// --- move up / down (keyboard + context menu) ---

	const move = async (arg: Node | undefined, dir: -1 | 1) => {
		const node = arg ?? view.selection[0];
		if (!node) {
			vscode.window.showInformationMessage('Symbolmarks: select an item first, then move it.');
			return;
		}
		await store.moveNode(node.id, dir);
		await store.setSortMode('manual');
		provider.refresh();
		// Re-select the moved node (fetch a fresh copy so reveal can find it).
		const fresh: Node | undefined = isBookmark(node)
			? store.all().find(b => b.id === node.id)
			: store.groups().find(g => g.id === node.id);
		if (fresh) {
			try {
				await view.reveal(fresh, { select: true, focus: true });
			} catch {
				/* reveal is best-effort */
			}
		}
	};

	const moveUp = vscode.commands.registerCommand('symbolmarks.moveUp', arg => move(arg, -1));
	const moveDown = vscode.commands.registerCommand('symbolmarks.moveDown', arg => move(arg, 1));

	context.subscriptions.push(
		bookmark,
		jump,
		remove,
		rename,
		toggleSort,
		clearAll,
		newGroup,
		newSubgroup,
		renameGroup,
		deleteGroup,
		moveUp,
		moveDown,
	);
}

export function deactivate() {}
