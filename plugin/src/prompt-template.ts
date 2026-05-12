/**
 * Parse a prompt-template .md file into `[label, body]`. The first non-empty
 * line before a `---` separator is the label; the rest is the prompt body.
 * With no separator, the first non-empty line is the label and the whole
 * file is the body.
 */
export function parsePromptTemplate(content: string, fallbackName: string): [string, string] {
	// Tightened separator: only treat `---` as the label/body divider when it
	// appears as the FIRST non-blank/non-whitespace line group's terminator —
	// i.e. preceded only by optional blank lines plus one or more non-blank
	// label lines, with no blank-line gap between them. The previous
	// `^---\s*$` (multiline) matched any markdown HR mid-body, so a template
	// like `Title\n\nIntro paragraph\n---\n## Section` would incorrectly
	// split at the body HR.
	//
	// Strategy: skip leading blank lines, collect contiguous non-blank lines
	// as the label block, and only accept the next line as a separator if
	// it matches `---\s*`. Anything else means no separator.
	const lines = content.split("\n");
	const isSep = (s: string): boolean => /^---\s*$/.test(s);
	let i = 0;
	// Skip leading blank lines.
	while (i < lines.length && lines[i].trim() === "") i++;
	const labelStart = i;
	// Walk forward across non-blank, non-separator lines — these form the
	// label block. Stop at the first blank line (so a body HR after a blank
	// paragraph isn't treated as the separator) or at the first `---` line.
	while (i < lines.length && lines[i].trim() !== "" && !isSep(lines[i])) i++;
	if (i < lines.length && isSep(lines[i])) {
		const before = lines.slice(labelStart, i).join("\n").trim();
		const after = lines
			.slice(i + 1)
			.join("\n")
			.trim();
		const label =
			before
				.split("\n")
				.find((l) => l.trim())
				?.trim() ?? fallbackName;
		return [label, after];
	}
	const firstLine = content.split("\n").find((l) => l.trim()) ?? fallbackName;
	return [firstLine.trim(), content.trim()];
}

/** Substitute `{{file}}` with the vault path (matches whitespace variants).
 *  Uses a function replacer so the path is never re-interpreted as a regex
 *  back-reference (a literal `$1` / `$&` in the path would otherwise be
 *  replaced by capture groups — vault paths rarely contain `$` but the bug
 *  exists regardless). */
export function substituteFilePlaceholder(body: string, vaultPath: string): string {
	return body.replace(/\{\{\s*file\s*\}\}/g, () => vaultPath);
}
