import { Modal } from "obsidian";
import type { App } from "obsidian";

export type WriteOperation =
	| "create"
	| "modify"
	| "append"
	| "prepend"
	| "patch"
	| "search_replace"
	| "frontmatter_set"
	| "frontmatter_delete"
	| "rename"
	| "move"
	| "delete";

const OPERATION_LABELS: Record<WriteOperation, string> = {
	create: "Create file",
	modify: "Modify file",
	append: "Append to file",
	prepend: "Prepend to file",
	patch: "Patch file",
	search_replace: "Search and replace",
	frontmatter_set: "Set frontmatter",
	frontmatter_delete: "Delete frontmatter property",
	rename: "Rename file",
	move: "Move file",
	delete: "Delete file",
};

export interface ReviewRequest {
	operation: WriteOperation;
	filePath: string;
	oldContent?: string;
	newContent?: string;
	description: string;
	/** For rename/move/delete: notes whose wikilinks reference this file. */
	affectedLinks?: string[];
}

export interface ReviewResult {
	approved: boolean;
}

export function computeUnifiedDiff(oldText: string, newText: string): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const output: string[] = [];
	let i = 0;
	let j = 0;

	while (i < oldLines.length || j < newLines.length) {
		if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
			output.push(`  ${oldLines[i]}`);
			i++;
			j++;
		} else {
			let foundMatch = false;
			for (let ahead = 1; ahead <= 3; ahead++) {
				if (j + ahead < newLines.length && oldLines[i] === newLines[j + ahead]) {
					for (let k = 0; k < ahead; k++) output.push(`+ ${newLines[j + k]}`);
					j += ahead;
					foundMatch = true;
					break;
				}
				if (i + ahead < oldLines.length && oldLines[i + ahead] === newLines[j]) {
					for (let k = 0; k < ahead; k++) output.push(`- ${oldLines[i + k]}`);
					i += ahead;
					foundMatch = true;
					break;
				}
			}
			if (!foundMatch) {
				if (i < oldLines.length) {
					output.push(`- ${oldLines[i]}`);
					i++;
				}
				if (j < newLines.length) {
					output.push(`+ ${newLines[j]}`);
					j++;
				}
			}
		}
	}

	return output.join("\n");
}

interface ReviewButton<T> {
	text: string;
	cls: string;
	result: () => T;
}

abstract class ReviewModalBase<T> extends Modal {
	private resolve: ((result: T) => void) | null = null;

	review(): Promise<T> {
		return new Promise<T>((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	protected addButtons(buttons: ReviewButton<T>[]): void {
		this.contentEl.createDiv({ cls: "modal-button-container" }, (div) => {
			for (const b of buttons) {
				div.createEl("button", { text: b.text, cls: b.cls }, (btn) => {
					btn.addEventListener("click", () => {
						this.resolve?.(b.result());
						this.close();
					});
				});
			}
		});
	}

	protected abstract defaultResult(): T;

	onClose(): void {
		if (this.resolve) {
			this.resolve(this.defaultResult());
			this.resolve = null;
		}
		this.contentEl.empty();
	}
}

export class DiffReviewModal extends ReviewModalBase<ReviewResult> {
	private request: ReviewRequest;

	constructor(app: App, request: ReviewRequest) {
		super(app);
		this.request = request;
	}

	protected defaultResult(): ReviewResult {
		return { approved: false };
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(`Review: ${OPERATION_LABELS[this.request.operation]}`);

		contentEl.createEl("p", {
			text: this.request.description,
			cls: "diff-review-description",
		});

		contentEl.createEl("div", { cls: "diff-review-path", text: this.request.filePath });

		const links = this.request.affectedLinks;
		if (links && links.length > 0) {
			const header = contentEl.createEl("div", { cls: "diff-review-affected-header" });
			header.setText(`${links.length} note(s) link here:`);
			const list = contentEl.createEl("ul", {
				cls: "diff-review-affected-list sandbox-diff-affected-list",
			});
			for (const link of links) list.createEl("li", { text: link });
		} else if (links !== undefined) {
			contentEl.createEl("div", {
				cls: "diff-review-affected-empty",
				text: "No other notes link to this file.",
			});
		}

		if (this.request.oldContent !== undefined || this.request.newContent !== undefined) {
			const diffEl = contentEl.createEl("pre", { cls: "diff-review-diff sandbox-diff-pre" });

			const diff = computeUnifiedDiff(
				this.request.oldContent ?? "",
				this.request.newContent ?? "",
			);
			for (const line of diff.split("\n")) {
				const lineEl = diffEl.createEl("div");
				lineEl.textContent = line;
				if (line.startsWith("+ ")) {
					lineEl.addClass("sandbox-diff-line-added");
				} else if (line.startsWith("- ")) {
					lineEl.addClass("sandbox-diff-line-removed");
				}
			}
		}

		this.addButtons([
			{ text: "Reject", cls: "mod-muted", result: () => ({ approved: false }) },
			{ text: "Approve", cls: "mod-cta", result: () => ({ approved: true }) },
		]);
	}
}

export interface BatchReviewRequest {
	operation: WriteOperation;
	description: string;
	items: Array<{ filePath: string; oldContent?: string; newContent?: string }>;
}

export interface BatchReviewResult {
	approved: boolean;
	approvedPaths: string[];
}

export class BatchReviewModal extends ReviewModalBase<BatchReviewResult> {
	private request: BatchReviewRequest;
	private selected = new Set<string>();

	constructor(app: App, request: BatchReviewRequest) {
		super(app);
		this.request = request;
		for (const item of request.items) this.selected.add(item.filePath);
	}

	protected defaultResult(): BatchReviewResult {
		return { approved: false, approvedPaths: [] };
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(`Review batch: ${OPERATION_LABELS[this.request.operation]}`);

		contentEl.createEl("p", {
			text: this.request.description,
			cls: "diff-review-description",
		});

		contentEl.createEl("div", {
			cls: "diff-review-count",
			text: `${this.request.items.length} file(s) affected. Uncheck any you want to skip.`,
		});

		const list = contentEl.createEl("div", {
			cls: "batch-review-list sandbox-modal-list-tall",
		});
		for (const item of this.request.items) {
			const row = list.createEl("label", {
				cls: "batch-review-row sandbox-modal-check-row",
			});
			const checkbox = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
			checkbox.checked = true;
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) this.selected.add(item.filePath);
				else this.selected.delete(item.filePath);
			});
			row.createEl("span", { text: item.filePath });
		}

		this.addButtons([
			{ text: "Reject all", cls: "mod-muted", result: () => this.defaultResult() },
			{
				text: "Approve selected",
				cls: "mod-cta",
				result: () => ({ approved: true, approvedPaths: [...this.selected] }),
			},
		]);
	}
}
