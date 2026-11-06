/**
 * Providers bundled with this edition, loaded in this order. Each entry's scripts are relative to
 * content/providers/<dir>/, and the last one registers the provider.
 *
 * build.sh removes entries (and their directories) for editions that leave them out.
 */
var AgentParserBundledProviders = [
	{ dir: 'mineru-cloud', scripts: ['provider.js'] },
	{ dir: 'paddleocr', scripts: ['provider.js'] },
	{ dir: 'mineru-local', scripts: ['runtime.js', 'tasks.js', 'provider.js'] },
];
