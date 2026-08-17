import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Bookmark } from './types';
import { BookmarkStore } from './storage';
import { BookmarksProvider } from './tree';
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
			vscode.window.showWarningMessage(`Already bookmarked: ${existing.label}`);
			await view.reveal(existing, { select: true, focus: false });
			return;
		}
		await store.add(entry);
		provider.refresh();
		vscode.window.showInformationMessage(`Bookmarked: ${entry.label}`);
	});

	// Jump to a bookmark (invoked by clicking a tree item).
	const jump = vscode.commands.registerCommand('symbolmarks.jump', async (target: Bookmark) => {
		try {
			const { uri, range, stale } = await resolveBookmark(target);
			const editor = await vscode.window.showTextDocument(uri, { preview: false });
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
		const label = await vscode.window.showInputBox({
			prompt: 'Rename bookmark',
			value: target.label,
		});
		if (label !== undefined && label.trim().length > 0) {
			await store.update(target.id, { label: label.trim() });
			provider.refresh();
		}
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

	context.subscriptions.push(bookmark, jump, remove, rename, toggleSort, clearAll);
}

export function deactivate() {}
