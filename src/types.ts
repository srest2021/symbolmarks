import * as vscode from 'vscode';

/**
 * How a bookmark is anchored back to a location in code.
 *
 * - `symbol`       – the cursor was on a declaration (class/function/method/var/…).
 *                    We re-resolve it by its symbol path, so it survives edits and
 *                    even the symbol being moved elsewhere in the file.
 * - `lineInSymbol` – the cursor was *inside* a symbol but not on its name
 *                    (e.g. a call site like `chargeGateway()` inside a method,
 *                    or a comment/plain line). We re-resolve the enclosing symbol,
 *                    then re-find the exact line by matching `tokenText`.
 * - `rawLine`      – the cursor was outside any symbol (e.g. a top-level comment).
 *                    Anchored to an absolute line, with a token/text hint.
 */
export type AnchorType = 'symbol' | 'lineInSymbol' | 'rawLine';

export interface Bookmark {
	/** Stable unique id. */
	id: string;
	/** User-facing label shown in the tree (defaults derived, renamable). */
	label: string;
	/** Target document, stored as a Uri string. */
	uri: string;
	anchorType: AnchorType;
	/** Path of enclosing symbols, outermost first, e.g. ["OrderService", "processRefund"]. */
	symbolPath: string[];
	/** vscode.SymbolKind of the anchored/enclosing symbol, for the icon. */
	symbolKind?: vscode.SymbolKind;
	/** Identifier/text under the cursor, used to re-find call sites and lines. */
	tokenText?: string;
	/** Trimmed text of the bookmarked line, matched to re-find the line robustly. */
	lineText?: string;
	/** Line offset from the enclosing symbol's start (fallback for lineInSymbol). */
	lineOffset?: number;
	/** Last-known absolute position, used as a final fallback. */
	fallbackLine: number;
	fallbackChar: number;
	/** Explicit order for manual (custom) sort. */
	order: number;
}

export type SortMode = 'manual' | 'alpha';
