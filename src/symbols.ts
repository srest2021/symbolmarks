import * as vscode from 'vscode';
import { AnchorType, Bookmark } from './types';

interface WalkNode {
	sym: vscode.DocumentSymbol;
	path: string[];
}

/** Depth-first walk of the document symbol tree, yielding each node with its full path. */
function* walk(symbols: vscode.DocumentSymbol[], prefix: string[] = []): Generator<WalkNode> {
	for (const sym of symbols) {
		const path = [...prefix, sym.name];
		yield { sym, path };
		yield* walk(sym.children ?? [], path);
	}
}

async function getDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
	const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
		'vscode.executeDocumentSymbolProvider',
		uri,
	);
	return result ?? [];
}

/** Find the symbol node exactly matching a stored path, if it still exists. */
function findByPath(symbols: vscode.DocumentSymbol[], path: string[]): vscode.DocumentSymbol | undefined {
	let level = symbols;
	let found: vscode.DocumentSymbol | undefined;
	for (const name of path) {
		found = level.find(s => s.name === name);
		if (!found) {
			return undefined;
		}
		level = found.children ?? [];
	}
	return found;
}

/**
 * Build a bookmark for the given position by inspecting the symbol tree.
 *
 * - If the cursor sits on a symbol's *name*, it's a `symbol` anchor.
 * - If it sits *inside* a symbol, it's a `lineInSymbol` anchor (call sites, comments, plain lines).
 * - Otherwise it's a `rawLine` anchor.
 */
export async function describeAnchor(
	document: vscode.TextDocument,
	position: vscode.Position,
): Promise<Pick<Bookmark, 'anchorType' | 'symbolPath' | 'symbolKind' | 'tokenText' | 'lineText' | 'lineOffset' | 'label'>> {
	const symbols = await getDocumentSymbols(document.uri);
	const nodes = [...walk(symbols)];

	// Token under the cursor (identifier) and the full line, used for re-finding.
	const wordRange = document.getWordRangeAtPosition(position);
	const tokenText = wordRange ? document.getText(wordRange) : undefined;
	const lineText = document.lineAt(position.line).text.trim();

	// 1. Cursor on a declaration name?
	const onName = nodes.find(n => n.sym.selectionRange.contains(position));
	if (onName) {
		return {
			anchorType: 'symbol',
			symbolPath: onName.path,
			symbolKind: onName.sym.kind,
			tokenText,
			lineText,
			label: onName.path.join(' › '),
		};
	}

	// 2. Cursor inside a symbol body — pick the deepest containing symbol.
	const containing = nodes
		.filter(n => n.sym.range.contains(position))
		.sort((a, b) => b.path.length - a.path.length)[0];
	if (containing) {
		const enclosingName = containing.path[containing.path.length - 1];
		const hint = lineText || tokenText;
		return {
			anchorType: 'lineInSymbol',
			symbolPath: containing.path,
			symbolKind: containing.sym.kind,
			tokenText,
			lineText,
			lineOffset: position.line - containing.sym.range.start.line,
			label: `${(hint || 'line').slice(0, 50)} — in ${enclosingName}`,
		};
	}

	// 3. Outside any symbol.
	return {
		anchorType: 'rawLine',
		symbolPath: [],
		tokenText,
		lineText,
		label: lineText ? lineText.slice(0, 60) : `line ${position.line + 1}`,
	};
}

export interface ResolvedLocation {
	uri: vscode.Uri;
	range: vscode.Range;
	/** True when we had to fall back to the last-known line (symbol/token not found). */
	stale: boolean;
}

/** Build a range on `line`, pointing at `token` if given, else the first non-whitespace char. */
function rangeOnLine(document: vscode.TextDocument, line: number, token?: string): vscode.Range {
	const text = document.lineAt(line).text;
	const idx = token ? text.indexOf(token) : -1;
	if (idx >= 0) {
		return new vscode.Range(line, idx, line, idx + token!.length);
	}
	const firstNonWs = Math.max(0, text.length - text.trimStart().length);
	return new vscode.Range(line, firstNonWs, line, text.length);
}

/**
 * Find the best line for a bookmark within [startLine, endLine], preferring:
 *   1. an exact trimmed-line-text match closest to `expectedLine`
 *   2. a line containing `token` closest to `expectedLine`
 * Returns undefined if neither is found.
 */
function findBestLine(
	document: vscode.TextDocument,
	startLine: number,
	endLine: number,
	expectedLine: number,
	lineText?: string,
	token?: string,
): vscode.Range | undefined {
	const exact: number[] = [];
	const partial: number[] = [];
	for (let line = startLine; line <= endLine; line++) {
		const text = document.lineAt(line).text;
		if (lineText && text.trim() === lineText) {
			exact.push(line);
		} else if (token && text.includes(token)) {
			partial.push(line);
		}
	}
	const closest = (lines: number[]) =>
		lines.sort((a, b) => Math.abs(a - expectedLine) - Math.abs(b - expectedLine))[0];

	if (exact.length > 0) {
		return rangeOnLine(document, closest(exact), token);
	}
	if (partial.length > 0) {
		return rangeOnLine(document, closest(partial), token);
	}
	return undefined;
}

/** Re-resolve a bookmark to a concrete location in the (possibly edited) document. */
export async function resolveBookmark(bookmark: Bookmark): Promise<ResolvedLocation> {
	const uri = vscode.Uri.parse(bookmark.uri);
	const document = await vscode.workspace.openTextDocument(uri);
	const lastLine = document.lineCount - 1;

	const fallback = (): ResolvedLocation => {
		const line = Math.min(Math.max(bookmark.fallbackLine, 0), lastLine);
		const char = Math.min(bookmark.fallbackChar, document.lineAt(line).text.length);
		return { uri, range: new vscode.Range(line, char, line, char), stale: true };
	};

	if (bookmark.anchorType === 'rawLine') {
		// Match the whole line, closest to where it originally was — not the first
		// occurrence of the token (which could be an unrelated import, etc.).
		const hit = findBestLine(
			document,
			0,
			lastLine,
			bookmark.fallbackLine,
			bookmark.lineText,
			bookmark.tokenText,
		);
		return hit ? { uri, range: hit, stale: false } : fallback();
	}

	const symbols = await getDocumentSymbols(uri);
	const sym = findByPath(symbols, bookmark.symbolPath);
	if (!sym) {
		return fallback();
	}

	if (bookmark.anchorType === 'symbol') {
		return { uri, range: sym.selectionRange, stale: false };
	}

	// lineInSymbol: re-find the exact line within the (moved) symbol body,
	// preferring the offset we originally recorded.
	const expectedLine = sym.range.start.line + (bookmark.lineOffset ?? 0);
	const hit = findBestLine(
		document,
		sym.range.start.line,
		sym.range.end.line,
		expectedLine,
		bookmark.lineText,
		bookmark.tokenText,
	);
	if (hit) {
		return { uri, range: hit, stale: false };
	}
	// Fall back to the stored offset within the current symbol range.
	const line = Math.min(expectedLine, sym.range.end.line);
	return { uri, range: rangeOnLine(document, line, bookmark.tokenText), stale: true };
}

/** Human-readable location suffix for the tree (e.g. "extension.ts:42"). */
export function locationLabel(bookmark: Bookmark): string {
	const uri = vscode.Uri.parse(bookmark.uri);
	const name = uri.path.split('/').pop() ?? uri.path;
	return `${name}:${bookmark.fallbackLine + 1}`;
}

export { AnchorType };
