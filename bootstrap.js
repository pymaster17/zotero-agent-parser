/* global Zotero, Services, Components */

var { classes: Cc, interfaces: Ci, utils: Cu } = Components;
var AgentParser;
var AgentParserEdition;

// fetch, TextEncoder, etc. are already provided by the plugin sandbox, but not AbortController
for (let prop of ["fetch", "AbortController"]) {
	try {
		Cu.importGlobalProperties([prop]);
	}
	catch (e) {}
}

function install() {}

async function startup({ id, version, rootURI }) {
	Services.scriptloader.loadSubScript(rootURI + 'content/edition.js');
	Services.scriptloader.loadSubScript(rootURI + 'content/http.js');
	Services.scriptloader.loadSubScript(rootURI + 'content/backends.js');
	// The lite edition is cloud-only and doesn't ship local MinerU support
	if (AgentParserEdition == 'full') {
		Services.scriptloader.loadSubScript(rootURI + 'content/local.js');
	}
	Services.scriptloader.loadSubScript(rootURI + 'content/output.js');
	Services.scriptloader.loadSubScript(rootURI + 'content/main.js');

	AgentParser.init({ id, version, rootURI });

	Zotero.PreferencePanes.register({
		pluginID: id,
		id: 'agent-parser-prefs',
		src: rootURI + 'content/preferences.xhtml',
		scripts: [rootURI + 'content/preferences.js'],
	});

	await Zotero.initializationPromise;
	for (let win of Zotero.getMainWindows()) {
		if (win.ZoteroPane) {
			AgentParser.addToWindow(win);
		}
	}
	AgentParser.restoreQueue();
}

function onMainWindowLoad({ window }) {
	AgentParser?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	AgentParser?.removeFromWindow(window);
}

function shutdown() {
	AgentParser?.shutdown();
	AgentParser = undefined;
}

function uninstall() {}
