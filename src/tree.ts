import * as vscode from 'vscode';
import { Bookmark } from './types';
import { BookmarkStore } from './storage';
import { locationLabel } from './symbols';

const MIME = 'application/vnd.code.tree.symbolmarks';

/** Map a SymbolKind to a codicon so tree items look like the Outline view. */
function iconFor(bookmark: Bookmark): vscode.ThemeIcon {
	if (bookmark.anchorType === 'rawLine') {
		return new vscode.ThemeIcon('bookmark');
	}
	if (bookmark.anchorType === 'lineInSymbol') {
		return new vscode.ThemeIcon('arrow-small-right');
	}
	switch (bookmark.symbolKind) {
		case vscode.SymbolKind.Class:
			return new vscode.ThemeIcon('symbol-class');
		case vscode.SymbolKind.Method:
			return new vscode.ThemeIcon('symbol-method');
		case vscode.SymbolKind.Function:
			return new vscode.ThemeIcon('symbol-function');
		case vscode.SymbolKind.Constructor:
			return new vscode.ThemeIcon('symbol-constructor');
		case vscode.SymbolKind.Variable:
			return new vscode.ThemeIcon('symbol-variable');
		case vscode.SymbolKind.Constant:
			return new vscode.ThemeIcon('symbol-constant');
		case vscode.SymbolKind.Property:
		case vscode.SymbolKind.Field:
			return new vscode.ThemeIcon('symbol-field');
		case vscode.SymbolKind.Interface:
			return new vscode.ThemeIcon('symbol-interface');
		case vscode.SymbolKind.Enum:
			return new vscode.ThemeIcon('symbol-enum');
		default:
			return new vscode.ThemeIcon('symbol-misc');
	}
}

export class BookmarksProvider
	implements vscode.TreeDataProvider<Bookmark>, vscode.TreeDragAndDropController<Bookmark>
{
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	readonly dropMimeTypes = [MIME];
	readonly dragMimeTypes = [MIME];

	constructor(private readonly store: BookmarkStore) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(bookmark: Bookmark): vscode.TreeItem {
		const hasTitle = !!bookmark.title && bookmark.title.trim().length > 0;
		const item = new vscode.TreeItem(
			hasTitle ? bookmark.title! : bookmark.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.id = bookmark.id;
		// With a title, keep the derived symbol descriptor visible in the dimmed text.
		item.description = hasTitle
			? `${bookmark.label} · ${locationLabel(bookmark)}`
			: locationLabel(bookmark);
		item.tooltip = new vscode.MarkdownString(
			[
				hasTitle ? `**${bookmark.title}**` : undefined,
				bookmark.symbolPath.join(' › ') || bookmark.label,
				`\`${locationLabel(bookmark)}\``,
			]
				.filter(Boolean)
				.join('\n\n'),
		);
		item.iconPath = iconFor(bookmark);
		item.contextValue = 'symbolmark';
		item.command = {
			command: 'symbolmarks.jump',
			title: 'Jump to Bookmark',
			arguments: [bookmark],
		};
		return item;
	}

	getParent(): vscode.ProviderResult<Bookmark> {
		// Flat tree — every item is a root.
		return undefined;
	}

	getChildren(): Bookmark[] {
		const list = [...this.store.all()];
		if (this.store.sortMode() === 'alpha') {
			const name = (b: Bookmark) => b.title?.trim() || b.label;
			return list.sort((a, b) => name(a).localeCompare(name(b)));
		}
		return list.sort((a, b) => a.order - b.order);
	}

	// --- drag & drop (custom/manual reordering) ---

	handleDrag(source: readonly Bookmark[], dataTransfer: vscode.DataTransfer): void {
		dataTransfer.set(MIME, new vscode.DataTransferItem(source.map(b => b.id)));
	}

	async handleDrop(target: Bookmark | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		const transferItem = dataTransfer.get(MIME);
		if (!transferItem) {
			return;
		}
		const draggedIds: string[] = transferItem.value;

		// Reorder against the current *manual* order.
		let list = [...this.store.all()].sort((a, b) => a.order - b.order);
		const dragged = draggedIds
			.map(id => list.find(b => b.id === id))
			.filter((b): b is Bookmark => b !== undefined);
		list = list.filter(b => !draggedIds.includes(b.id));

		const targetIdx = target ? list.findIndex(b => b.id === target.id) : list.length;
		list.splice(targetIdx < 0 ? list.length : targetIdx, 0, ...dragged);
		list.forEach((b, i) => (b.order = i));

		await this.store.replaceAll(list);
		// Reordering only makes sense in manual mode — switch to it.
		await this.store.setSortMode('manual');
		this.refresh();
	}
}
