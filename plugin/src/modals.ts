/**
 * Lightweight modal helpers for confirm prompts and single-input prompts.
 * Centralizes the cancel + CTA button pair and the onClose-resolves-default
 * race handling that was duplicated across several ad-hoc modal sites.
 */

import { Modal } from "obsidian";
import type { App } from "obsidian";

export interface ConfirmOptions {
	title: string;
	message: string;
	ctaLabel?: string;
	cancelLabel?: string;
}

export function confirmModal(app: App, opts: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let settled = false;
		const settle = (v: boolean) => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		modal.titleEl.setText(opts.title);
		modal.contentEl.createEl("p", { text: opts.message });
		modal.contentEl.createDiv({ cls: "modal-button-container" }, (div) => {
			div.createEl(
				"button",
				{ text: opts.cancelLabel ?? "Cancel", cls: "mod-muted" },
				(btn) => {
					btn.addEventListener("click", () => {
						settle(false);
						modal.close();
					});
				},
			);
			div.createEl("button", { text: opts.ctaLabel ?? "Confirm", cls: "mod-cta" }, (btn) => {
				btn.addEventListener("click", () => {
					settle(true);
					modal.close();
				});
			});
		});
		modal.onClose = () => settle(false);
		modal.open();
	});
}

export interface InputOptions {
	title: string;
	message?: string;
	placeholder?: string;
	defaultValue?: string;
	/** Single-line `<input>` if false, multi-line `<textarea>` if true (default). */
	multiline?: boolean;
	ctaLabel?: string;
	cancelLabel?: string;
}

/** Resolves to the trimmed input string, or null if the user cancels / closes the modal. */
export function inputModal(app: App, opts: InputOptions): Promise<string | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let settled = false;
		const settle = (v: string | null) => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		modal.titleEl.setText(opts.title);
		if (opts.message) modal.contentEl.createEl("p", { text: opts.message });
		const multiline = opts.multiline ?? true;
		const input: HTMLInputElement | HTMLTextAreaElement = multiline
			? modal.contentEl.createEl("textarea", { cls: "sandbox-modal-input-multiline" })
			: modal.contentEl.createEl("input", { type: "text", cls: "sandbox-modal-input-full" });
		if (opts.placeholder) input.placeholder = opts.placeholder;
		if (opts.defaultValue) input.value = opts.defaultValue;
		const submit = () => {
			const body = input.value.trim();
			settle(body || null);
			modal.close();
		};
		if (!multiline) {
			(input as HTMLInputElement).addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key === "Enter") submit();
				else if (e.key === "Escape") {
					settle(null);
					modal.close();
				}
			});
		}
		modal.contentEl.createDiv({ cls: "modal-button-container" }, (div) => {
			div.createEl(
				"button",
				{ text: opts.cancelLabel ?? "Cancel", cls: "mod-muted" },
				(btn) => {
					btn.addEventListener("click", () => {
						settle(null);
						modal.close();
					});
				},
			);
			div.createEl("button", { text: opts.ctaLabel ?? "OK", cls: "mod-cta" }, (btn) => {
				btn.addEventListener("click", submit);
			});
		});
		modal.onClose = () => settle(null);
		modal.open();
		input.focus();
	});
}
