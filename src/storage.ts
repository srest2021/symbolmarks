import * as vscode from 'vscode';
import { Bookmark, Group, SortMode } from './types';

const BOOKMARKS_KEY = 'symbolmarks.bookmarks';
const GROUPS_KEY = 'symbolmarks.groups';
const SORT_KEY = 'symbolmarks.sortMode';

/** Identity of a bookmark for duplicate detection — same key means "the same thing". */
export function bookmarkKey(b: Bookmark): string {
	const sep = ' ';
	switch (b.anchorType) {
		case 'symbol':
			return [b.uri, 'symbol', b.symbolPath.join('›')].join(sep);
		case 'lineInSymbol':
			return [b.uri, 'line', b.symbolPath.join('›'), b.lineText ?? b.lineOffset].join(sep);
		default:
			return [b.uri, 'raw', b.lineText ?? b.fallbackLine].join(sep);
	}
}

/** Thin wrapper over workspaceState for persisting bookmarks, groups, and view preferences. */
export class BookmarkStore {
	constructor(private readonly context: vscode.ExtensionContext) {}

	// --- reads ---
	//
	// workspaceState.get() deserializes the whole list on every call, and a single
	// tree render calls all()/groups() many times (getChildren, per-item getTreeItem,
	// and the recursive depth helpers). We cache the parsed arrays and refresh the
	// cache on every write, so a render parses storage at most once.

	private bookmarksCache?: Bookmark[];
	private groupsCache?: Group[];

	all(): Bookmark[] {
		return (this.bookmarksCache ??= this.context.workspaceState.get<Bookmark[]>(BOOKMARKS_KEY, []));
	}

	groups(): Group[] {
		return (this.groupsCache ??= this.context.workspaceState.get<Group[]>(GROUPS_KEY, []));
	}

	private async persist(list: Bookmark[]): Promise<void> {
		this.bookmarksCache = list;
		await this.context.workspaceState.update(BOOKMARKS_KEY, list);
	}

	private async persistGroups(list: Group[]): Promise<void> {
		this.groupsCache = list;
		await this.context.workspaceState.update(GROUPS_KEY, list);
	}

	private async persistBoth(groups: Group[], bookmarks: Bookmark[]): Promise<void> {
		await this.persistGroups(groups);
		await this.persist(bookmarks);
	}

	/** Number of nodes (groups + bookmarks) directly under `parent`. */
	private childCount(parent: string | undefined): number {
		return (
			this.groups().filter(g => g.parentId === parent).length +
			this.all().filter(b => b.groupId === parent).length
		);
	}

	// --- bookmarks ---

	findDuplicate(bookmark: Bookmark): Bookmark | undefined {
		const key = bookmarkKey(bookmark);
		return this.all().find(b => bookmarkKey(b) === key);
	}

	async add(bookmark: Bookmark): Promise<void> {
		bookmark.groupId = undefined;
		bookmark.order = this.childCount(undefined); // append at root
		await this.persist([...this.all(), bookmark]);
	}

	async remove(id: string): Promise<void> {
		await this.persist(this.all().filter(b => b.id !== id));
	}

	async update(id: string, patch: Partial<Bookmark>): Promise<void> {
		await this.persist(this.all().map(b => (b.id === id ? { ...b, ...patch } : b)));
	}

	async clear(): Promise<void> {
		await this.persistBoth([], []);
	}

	// --- groups ---

	async addGroup(group: Group): Promise<void> {
		group.order = this.childCount(group.parentId); // append after existing siblings
		await this.persistGroups([...this.groups(), group]);
	}

	async renameGroup(id: string, name: string): Promise<void> {
		await this.persistGroups(this.groups().map(g => (g.id === id ? { ...g, name } : g)));
	}

	/**
	 * Delete a group, promoting its direct children to the deleted group's own
	 * parent (root if it was top-level). Never deletes bookmarks.
	 */
	async removeGroup(id: string): Promise<void> {
		const target = this.groups().find(g => g.id === id);
		const newParent = target?.parentId;

		const groups = this.groups()
			.filter(g => g.id !== id)
			.map(g => (g.parentId === id ? { ...g, parentId: newParent } : g));
		const bookmarks = this.all().map(b => (b.groupId === id ? { ...b, groupId: newParent } : b));
		await this.persistBoth(groups, bookmarks);
	}

	// --- moving (keyboard + drag share the same order space) ---

	/**
	 * Move a node one slot up (dir -1) or down (dir +1) among its siblings. At the
	 * top/bottom edge of a folder it pops OUT one level, landing just before/after
	 * that folder. Works for both groups and bookmarks.
	 */
	async moveNode(id: string, dir: -1 | 1): Promise<void> {
		const groups = this.groups();
		const bookmarks = this.all();
		const groupById = new Map(groups.map(g => [g.id, g]));
		const bmById = new Map(bookmarks.map(b => [b.id, b]));
		if (!groupById.has(id) && !bmById.has(id)) {
			return;
		}

		const parentOf = (n: string) =>
			groupById.has(n) ? groupById.get(n)!.parentId : bmById.get(n)!.groupId;
		const setParent = (n: string, p: string | undefined) => {
			if (groupById.has(n)) {
				groupById.get(n)!.parentId = p;
			} else {
				bmById.get(n)!.groupId = p;
			}
		};
		const childIds = (parent: string | undefined) =>
			[...groups.filter(g => g.parentId === parent), ...bookmarks.filter(b => b.groupId === parent)]
				.sort((a, b) => a.order - b.order)
				.map(k => k.id);
		const renumber = (ids: string[]) =>
			ids.forEach((n, i) => {
				if (groupById.has(n)) {
					groupById.get(n)!.order = i;
				} else {
					bmById.get(n)!.order = i;
				}
			});

		const parent = parentOf(id);
		const sibs = childIds(parent);
		const idx = sibs.indexOf(id);
		const to = idx + dir;

		if (to >= 0 && to < sibs.length) {
			// Swap with the neighbour in this folder.
			[sibs[idx], sibs[to]] = [sibs[to], sibs[idx]];
			renumber(sibs);
		} else {
			// At an edge — pop out one level, adjacent to the parent folder.
			if (parent === undefined) {
				return; // already at the very top/bottom of the root
			}
			const grand = groupById.get(parent)!.parentId;
			renumber(sibs.filter(s => s !== id));
			const uncles = childIds(grand);
			const at = uncles.indexOf(parent) + (dir === 1 ? 1 : 0);
			uncles.splice(at, 0, id);
			setParent(id, grand);
			renumber(uncles);
		}

		await this.persistBoth(groups, bookmarks);
	}

	/**
	 * Drag target: move `ids` into `destParent` (or root). If `beforeId` is given
	 * they land right before that node; otherwise they append. Skips illegal group
	 * moves (cycles / exceeding the depth limit) and reports if any were blocked.
	 */
	async moveInto(
		ids: string[],
		destParent: string | undefined,
		beforeId: string | undefined,
	): Promise<{ blocked: boolean }> {
		const groups = this.groups();
		const bookmarks = this.all();
		const groupById = new Map(groups.map(g => [g.id, g]));
		const bmById = new Map(bookmarks.map(b => [b.id, b]));
		const maxDepth = this.maxGroupDepth();

		let blocked = false;
		const moving: string[] = [];
		for (const id of ids) {
			if (groupById.has(id)) {
				if (this.isSelfOrDescendant(destParent, id)) {
					continue; // would nest a folder inside itself
				}
				const parentDepth = destParent ? this.groupDepth(destParent) : 0;
				if (parentDepth + this.subtreeHeight(id) > maxDepth) {
					blocked = true;
					continue;
				}
			}
			if (groupById.has(id) || bmById.has(id)) {
				moving.push(id);
			}
		}
		if (moving.length === 0) {
			return { blocked };
		}

		moving.forEach(id => {
			if (groupById.has(id)) {
				groupById.get(id)!.parentId = destParent;
			} else {
				bmById.get(id)!.groupId = destParent;
			}
		});

		const kids = [
			...groups.filter(g => g.parentId === destParent),
			...bookmarks.filter(b => b.groupId === destParent),
		]
			.sort((a, b) => a.order - b.order)
			.map(k => k.id);
		const rest = kids.filter(id => !moving.includes(id));
		const at = beforeId ? rest.indexOf(beforeId) : -1;
		rest.splice(at < 0 ? rest.length : at, 0, ...moving);
		rest.forEach((id, i) => {
			if (groupById.has(id)) {
				groupById.get(id)!.order = i;
			} else {
				bmById.get(id)!.order = i;
			}
		});

		await this.persistBoth(groups, bookmarks);
		return { blocked };
	}

	// --- depth (single source of truth for the nesting limit) ---

	maxGroupDepth(): number {
		const configured = vscode.workspace
			.getConfiguration('symbolmarks')
			.get<number>('maxGroupDepth', 3);
		return Math.max(1, configured);
	}

	/** Depth of a group: a top-level folder is 1, its subfolder is 2, and so on. */
	groupDepth(id: string | undefined): number {
		const groups = this.groups();
		let depth = 0;
		let current = id;
		const seen = new Set<string>();
		while (current && !seen.has(current)) {
			seen.add(current);
			depth++;
			current = groups.find(g => g.id === current)?.parentId;
		}
		return depth;
	}

	/** Height of a folder's subtree in layers (a leaf folder is 1). */
	subtreeHeight(id: string): number {
		const children = this.groups().filter(g => g.parentId === id);
		if (children.length === 0) {
			return 1;
		}
		return 1 + Math.max(...children.map(c => this.subtreeHeight(c.id)));
	}

	/** True if `maybeDescendant` is `ancestorId` or lives somewhere beneath it. */
	isSelfOrDescendant(maybeDescendant: string | undefined, ancestorId: string): boolean {
		const groups = this.groups();
		let current = maybeDescendant;
		const seen = new Set<string>();
		while (current && !seen.has(current)) {
			if (current === ancestorId) {
				return true;
			}
			seen.add(current);
			current = groups.find(g => g.id === current)?.parentId;
		}
		return false;
	}

	/** Can a new subfolder be created under `parentId` without exceeding the limit? */
	canNestUnder(parentId: string | undefined): boolean {
		return this.groupDepth(parentId) + 1 <= this.maxGroupDepth();
	}

	// --- view preferences ---

	sortMode(): SortMode {
		return this.context.workspaceState.get<SortMode>(SORT_KEY, 'manual');
	}

	async setSortMode(mode: SortMode): Promise<void> {
		await this.context.workspaceState.update(SORT_KEY, mode);
	}
}
