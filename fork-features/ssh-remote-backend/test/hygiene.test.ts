import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ts } from "ts-morph";

/**
 * Issue #10 acceptance row 5 (hygiene), as three structural contracts:
 *
 * 1. the fork backend and its upstream barrel never *reference* upstream
 *    internals (`createAgentSession`, `IrcBus`, `AgentSession`, `authStorage`,
 *    `modelRegistry`, `AgentHub`);
 * 2. the upstream registration stays a re-export-only barrel of at most three
 *    non-empty lines;
 * 3. `fork-features/trunk-patches.md` records the issue #10 trunk delta in its
 *    three-column table.
 *
 * References are read from compiler ASTs, so comments and string literals are
 * data, not references (this file keeps the forbidden names only as strings).
 * The parser is the classic compiler bundled by the installed `ts-morph`
 * devDependency: `typescript@7` is native-only and its `unstable/ast` entry
 * ships no text parser.
 */

const BACKEND_DIR = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(BACKEND_DIR, "../..");
const UPSTREAM_BARREL = path.join(REPO_ROOT, "packages/coding-agent/src/fork/ssh-remote-backend.ts");
const TRUNK_LEDGER = path.join(REPO_ROOT, "fork-features/trunk-patches.md");
const LEDGER_SECTION = "## fork-features/ssh-remote-backend/ — production factory + registration (issue #10)";
const LEDGER_COLUMNS = ["file/line", "missing API", "rationale"];

/** Upstream internals the fork consumes through public seams instead of naming directly. */
const FORBIDDEN_IDENTIFIERS: Record<string, true> = {
	createAgentSession: true,
	IrcBus: true,
	AgentSession: true,
	authStorage: true,
	modelRegistry: true,
	AgentHub: true,
};

interface ForbiddenReference {
	file: string;
	line: number;
	column: number;
	name: string;
}

function discoverBackendSources(): string[] {
	const sources: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(fullPath);
			else if (entry.name.endsWith(".ts")) sources.push(fullPath);
		}
	};
	walk(BACKEND_DIR);
	return sources.sort();
}

/**
 * Member names on an already-resolved receiver (`port.AgentSession`,
 * `{ AgentSession: value }`, `interface { AgentSession: T }`) label a member;
 * they are not references to the upstream symbol. Every other identifier
 * occurrence — bindings, imports/exports, type positions, values — is a
 * reference and must not use a forbidden name.
 */
function isMemberLabel(node: ts.Identifier): boolean {
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
	if (ts.isQualifiedName(parent)) return parent.right === node;
	if (ts.isPropertyAssignment(parent)) return parent.name === node;
	if (ts.isPropertySignature(parent)) return parent.name === node;
	if (ts.isPropertyDeclaration(parent)) return parent.name === node;
	if (ts.isMethodDeclaration(parent)) return parent.name === node;
	if (ts.isMethodSignature(parent)) return parent.name === node;
	if (ts.isGetAccessorDeclaration(parent)) return parent.name === node;
	if (ts.isSetAccessorDeclaration(parent)) return parent.name === node;
	if (ts.isEnumMember(parent)) return parent.name === node;
	return false;
}

function findForbiddenReferences(sourceFile: ts.SourceFile): ForbiddenReference[] {
	const references: ForbiddenReference[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && Object.hasOwn(FORBIDDEN_IDENTIFIERS, node.text) && !isMemberLabel(node)) {
			const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
			references.push({ file: sourceFile.fileName, line: position.line + 1, column: position.character + 1, name: node.text });
		}
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(sourceFile, visit);
	return references;
}

/** Section body up to the next level-2 heading (read as Markdown documentation, not as implementation). */
function extractSection(markdown: string, heading: string): string | undefined {
	const lines = markdown.split(/\r?\n/);
	const target = heading.trim().replace(/\s+/g, " ");
	const start = lines.findIndex(line => line.trim().replace(/\s+/g, " ") === target);
	if (start === -1) return undefined;
	const body: string[] = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^##\s/.test(lines[index].trim())) break;
		body.push(lines[index]);
	}
	return body.join("\n").trim();
}

/** Markdown table cell canonical form: no emphasis markers, no slash padding, single spaces, lowercase. */
function normalizeCell(cell: string): string {
	return cell
		.trim()
		.replace(/[`*]/g, "")
		.replace(/\s*\/\s*/g, "/")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

function findLedgerHeaderRow(section: string): string[] | undefined {
	const expected = LEDGER_COLUMNS.map(normalizeCell);
	for (const line of section.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) continue;
		const cells = trimmed
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map(normalizeCell);
		if (cells.length === expected.length && cells.every((cell, index) => cell === expected[index])) return cells;
	}
	return undefined;
}

describe("ssh-remote-backend hygiene (issue #10 row 5)", () => {
	it("references no forbidden upstream internals from the backend", async () => {
		// Detector control: without this, a broken visitor would make the scan below
		// pass on a clean tree no matter what the backend actually contains.
		const control = findForbiddenReferences(
			ts.createSourceFile(
				"control.ts",
				[
					'import createAgentSession from "../../session/agent-session";',
					'import { AgentSession, authStorage as credentials } from "../../session";',
					'export { AgentHub } from "../../hub";',
					'export * as IrcBus from "../../irc";',
					"const host = { createAgentSession, modelRegistry };",
					"function use(session: AgentSession): void {}",
					"credentials.load();",
					'const labels = { AgentSession: "data", createAgentSession: 1 };',
					'const strings = ["AgentSession", "IrcBus", "createAgentSession", "authStorage", "modelRegistry", "AgentHub"];',
				].join("\n"),
				ts.ScriptTarget.Latest,
				/* setParentNodes */ true,
				ts.ScriptKind.TS,
			),
		);
		expect(control.map(reference => reference.name)).toEqual([
			"createAgentSession", // default import binding
			"AgentSession", // named import binding
			"authStorage", // aliased import, original name
			"AgentHub", // re-export specifier
			"IrcBus", // namespace re-export binding
			"createAgentSession", // shorthand object property
			"modelRegistry", // shorthand object property
			"AgentSession", // type reference
		]);
		expect(control[0]).toEqual({ file: "control.ts", line: 1, column: 8, name: "createAgentSession" });
		// The `credentials` alias, the member labels and the string literals above stay
		// unflagged: data is not a reference.

		// Coverage precondition: the scan must see the frozen launcher and the tests.
		const files = [...discoverBackendSources(), UPSTREAM_BARREL];
		expect(files.map(file => path.relative(REPO_ROOT, file))).toEqual(
			expect.arrayContaining(["fork-features/ssh-remote-backend/src/index.ts", "fork-features/ssh-remote-backend/test/lookup.test.ts"]),
		);

		const violations: ForbiddenReference[] = [];
		for (const file of files) {
			const text = await Bun.file(file).text();
			const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
			for (const reference of findForbiddenReferences(sourceFile)) {
				violations.push({ ...reference, file: path.relative(REPO_ROOT, file) });
			}
		}
		expect(violations.map(reference => `${reference.file}:${reference.line}:${reference.column} references ${reference.name}`)).toEqual([]);
	});

	it("keeps the upstream registration a re-export-only barrel", async () => {
		const text = await Bun.file(UPSTREAM_BARREL).text();
		const sourceFile = ts.createSourceFile(UPSTREAM_BARREL, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
		expect(text.split(/\r?\n/).filter(line => line.trim().length > 0).length).toBeLessThanOrEqual(3);
		expect(sourceFile.statements.length).toBeGreaterThan(0);
		// A module re-export is an export declaration with a literal module specifier.
		const nonReExports = sourceFile.statements.filter(
			statement =>
				!(
					ts.isExportDeclaration(statement) &&
					statement.moduleSpecifier !== undefined &&
					ts.isStringLiteral(statement.moduleSpecifier)
				),
		);
		expect(
			nonReExports.map(statement => {
				const line = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
				return `${ts.SyntaxKind[statement.kind]} at line ${line}`;
			}),
		).toEqual([]);
	});

	it("records the factory/registration slice in the trunk ledger", async () => {
		const ledger = await Bun.file(TRUNK_LEDGER).text();
		const section = extractSection(ledger, LEDGER_SECTION);
		if (section === undefined) {
			const sections = ledger
				.split(/\r?\n/)
				.filter(line => /^##\s/.test(line.trim()))
				.map(line => line.trim());
			throw new Error(`Missing section "${LEDGER_SECTION}" in fork-features/trunk-patches.md. Found:\n  ${sections.join("\n  ")}`);
		}
		const header = findLedgerHeaderRow(section);
		if (header === undefined) {
			throw new Error(`Missing table "${LEDGER_COLUMNS.join(" | ")}" under section "${LEDGER_SECTION}"`);
		}
		expect(header).toEqual(LEDGER_COLUMNS.map(normalizeCell));
	});
});
