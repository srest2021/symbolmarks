import * as vscode from 'vscode';
import { Bookmark, Group } from './types';
import { BookmarkStore } from './storage';
import { locationLabel } from './symbols';

const MIME = 'application/vnd.code.tree.symbolmarks';

export type Node = Group | Bookmark;

export function isBookmark(node: Node): node is Bookmark {
	return 'anchorType' in node;
}

function displayName(node: Node): string {
	return isBookmark(node) ? node.title?.trim() || node.label : node.name;
}

/** Map a SymbolKind to a codicon so tree items look like the Outline view. */
function iconFor(bookmark: Bookmark): vscode.ThemeIcon {
	if (bookmark.anchorType === 'rawLine' || bookmark.anchorType === 'lineInSymbol') {
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
	implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>
{
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	readonly dropMimeTypes = [MIME];
	readonly dragMimeTypes = [MIME];

	constructor(private readonly store: BookmarkStore) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(node: Node): vscode.TreeItem {
		return isBookmark(node) ? this.bookmarkItem(node) : this.groupItem(node);
	}

	private groupItem(group: Group): vscode.TreeItem {
		const item = new vscode.TreeItem(group.name, vscode.TreeItemCollapsibleState.Expanded);
		item.id = group.id;
		item.description = `(${this.store.all().filter(b => b.groupId === group.id).length +
			this.store.groups().filter(g => g.parentId === group.id).length})`;
		item.iconPath = vscode.ThemeIcon.Folder;
		// Whether another subfolder may still be nested here — drives the context menu.
		item.contextValue = this.store.canNestUnder(group.id) ? 'group.nestable' : 'group.leaf';
		item.tooltip = group.name;
		return item;
	}

	private bookmarkItem(bookmark: Bookmark): vscode.TreeItem {
		const hasTitle = !!bookmark.title && bookmark.title.trim().length > 0;
		const item = new vscode.TreeItem(
			hasTitle ? bookmark.title! : bookmark.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.id = bookmark.id;
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

	getParent(node: Node): Node | undefined {
		const parentId = isBookmark(node) ? node.groupId : node.parentId;
		return parentId ? this.store.groups().find(g => g.id === parentId) : undefined;
	}

	getChildren(element?: Node): Node[] {
		if (element && isBookmark(element)) {
			return [];
		}
		const parent = element?.id; // undefined at root
		const kids: Node[] = [
			...this.store.groups().filter(g => g.parentId === parent),
			...this.store.all().filter(b => b.groupId === parent),
		];
		if (this.store.sortMode() === 'alpha') {
			return kids.sort((a, b) => displayName(a).localeCompare(displayName(b)));
		}
		return kids.sort((a, b) => a.order - b.order);
	}

	// --- drag & drop: move nodes into a folder / to root ---

	handleDrag(source: readonly Node[], dataTransfer: vscode.DataTransfer): void {
		dataTransfer.set(MIME, new vscode.DataTransferItem(source.map(n => n.id)));
	}

	async handleDrop(target: Node | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		const transferItem = dataTransfer.get(MIME);
		if (!transferItem) {
			return;
		}
		const ids = transferItem.value as string[];

		// Dropped on a folder → into it; on a bookmark → into its folder, before it;
		// on empty space → root.
		const destParent = target ? (isBookmark(target) ? target.groupId : target.id) : undefined;
		const beforeId = target && isBookmark(target) ? target.id : undefined;

		const { blocked } = await this.store.moveInto(ids, destParent, beforeId);
		if (blocked) {
			vscode.window.showWarningMessage(
				`Symbolmarks: move blocked — would exceed ${this.store.maxGroupDepth()} folder levels.`,
			);
		}
		await this.store.setSortMode('manual');
		this.refresh();
	}
}
