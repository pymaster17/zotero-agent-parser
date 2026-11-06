/* global Zotero, Services, Components */

var { classes: Cc, interfaces: Ci, utils: Cu } = Components;
var AgentParser;
var AgentParserProviders;
var AgentParserBundledProviders;
var AgentParserUI;
var chromeHandle;

// fetch, TextEncoder, etc. are already provided by the plugin sandbox, but not AbortController
for (let prop of ["fetch", "AbortController"]) {
	try {
		Cu.importGlobalProperties([prop]);
	}
	catch (e) {}
}

function install() {}

async function startup({ id, version, rootURI }) {
	// chrome://agentparser/content/ for icons and styles
	let aomStartup = Cc['@mozilla.org/addons/addon-manager-startup;1'].getService(Ci.amIAddonManagerStartup);
	chromeHandle = aomStartup.registerChrome(Services.io.newURI(rootURI + 'manifest.json'), [
		['content', 'agentparser', rootURI + 'content/']
	]);

	Services.scriptloader.loadSubScript(rootURI + 'content/http.js');
	Services.scriptloader.loadSubScript(rootURI + 'content/output.js');
	Services.scriptloader.loadSubScript(rootURI + 'content/providers.js');
	// Parsing services in this edition
	Services.scriptloader.loadSubScript(rootURI + 'content/providers/index.js');
	for (let { dir, scripts } of AgentParserBundledProviders) {
		try {
			for (let script of scripts) {
				Services.scriptloader.loadSubScript(`${rootURI}content/providers/${dir}/${script}`);
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	}
	Services.scriptloader.loadSubScript(rootURI + 'content/main.js');
	Services.scriptloader.loadSubScript(rootURI + 'content/ui.js');

	AgentParser.init({ id, version, rootURI });

	let paneID = await Zotero.PreferencePanes.register({
		pluginID: id,
		id: 'agent-parser-prefs',
		src: rootURI + 'content/preferences.xhtml',
		scripts: [rootURI + 'content/preferences.js'],
	});
	if (paneID) {
		AgentParser.prefPaneID = paneID;
	}

	await Zotero.initializationPromise;
	try {
		AgentParserUI.register();
	}
	catch (e) {
		Zotero.logError(e);
	}
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
	try {
		AgentParserUI?.unregister();
	}
	catch (e) {
		Zotero.logError(e);
	}
	AgentParser?.shutdown();
	AgentParserProviders?.unregisterAll();
	AgentParser = undefined;
	AgentParserUI = undefined;
	AgentParserProviders = undefined;
	chromeHandle?.destruct();
	chromeHandle = null;
}

function uninstall() {}
