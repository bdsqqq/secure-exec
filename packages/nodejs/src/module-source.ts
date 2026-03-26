import { transform, transformSync } from "esbuild";
import { init, initSync, parse } from "es-module-lexer";

function isJavaScriptLikePath(filePath: string | undefined): boolean {
	return filePath === undefined || /\.[cm]?[jt]sx?$/.test(filePath);
}

function parseSourceSyntax(source: string, filePath?: string) {
	const [imports, , , hasModuleSyntax] = parse(source, filePath);
	const hasDynamicImport = imports.some((specifier) => specifier.d >= 0);
	const hasImportMeta = imports.some((specifier) => specifier.d === -2);
	return { hasModuleSyntax, hasDynamicImport, hasImportMeta };
}

function shouldTransformForRequire(source: string, filePath?: string): boolean {
	if (!isJavaScriptLikePath(filePath)) {
		return false;
	}

	const { hasModuleSyntax, hasDynamicImport, hasImportMeta } =
		parseSourceSyntax(source, filePath);
	return hasModuleSyntax || hasDynamicImport || hasImportMeta;
}

function getRequireTransformOptions(filePath: string) {
	return {
		define: {
			"import.meta.url": "__filename",
		},
		format: "cjs" as const,
		loader: "js" as const,
		platform: "node" as const,
		sourcefile: filePath,
		supported: {
			"dynamic-import": false,
		},
		target: "node22",
	};
}

export async function sourceHasModuleSyntax(
	source: string,
	filePath?: string,
): Promise<boolean> {
	if (filePath?.endsWith(".mjs")) {
		return true;
	}
	if (filePath?.endsWith(".cjs")) {
		return false;
	}

	await init;
	return parseSourceSyntax(source, filePath).hasModuleSyntax;
}

export function transformSourceForRequireSync(
	source: string,
	filePath: string,
): string {
	if (!isJavaScriptLikePath(filePath)) {
		return source;
	}

	initSync();
	if (!shouldTransformForRequire(source, filePath)) {
		return source;
	}

	try {
		return transformSync(source, getRequireTransformOptions(filePath)).code;
	} catch {
		return source;
	}
}

export async function transformSourceForRequire(
	source: string,
	filePath: string,
): Promise<string> {
	if (!isJavaScriptLikePath(filePath)) {
		return source;
	}

	await init;
	if (!shouldTransformForRequire(source, filePath)) {
		return source;
	}

	try {
		return (
			await transform(source, getRequireTransformOptions(filePath))
		).code;
	} catch {
		return source;
	}
}
