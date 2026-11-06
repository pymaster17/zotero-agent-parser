/* global AgentParserProviders, AgentParserMinerULocal */

/**
 * Local MinerU via the Tasks API
 *
 * By default the plugin manages the server itself (see runtime.js) and starts it on demand. It
 * can also point at a server the user runs, on this computer or elsewhere.
 */
AgentParserMinerULocal.Backend = class extends AgentParserMinerULocal.Tasks {
	constructor(getPref) {
		let runtime = AgentParserMinerULocal.runtime;
		super({
			url: runtime.getBaseURL(),
			apiKey: runtime.isManaged() ? '' : getPref('apiKey'),
			tier: runtime.getTier(),
			ocrMode: getPref('ocrMode'),
		});
		this.serviceName = 'mineru-local';
	}
	
	async test() {
		await AgentParserMinerULocal.runtime.acquire();
		try {
			return await super.test();
		}
		finally {
			AgentParserMinerULocal.runtime.release();
		}
	}
	
	async parse(job) {
		await AgentParserMinerULocal.runtime.acquire(status => job.onStatus(status));
		try {
			return await super.parse(job);
		}
		finally {
			AgentParserMinerULocal.runtime.release();
		}
	}
};


AgentParserProviders.register({
	apiVersion: 1,
	id: 'mineru-local',
	kind: 'local',
	ftl: 'agent-parser-mineru-local.ftl',
	l10n: {
		name: 'agentparser-provider-mineru-local',
		confirmBulk: 'agentparser-mineru-local-confirm-library'
	},
	defaultPrefs: {
		// When managed, the plugin installs MinerU into envDir and runs the server itself
		managed: true,
		tier: 'standard',
		ocrMode: 'auto',
		port: '8000',
		idleStopMinutes: '15',
		// Empty means ~/.zotero-agent-parser/mineru-env
		envDir: '',
		// Empty means search PATH and the usual install locations
		uvPath: '',
		// "auto", "huggingface" or "modelscope"
		modelSource: 'auto',
		// Server run by the user, when not managed
		url: 'http://127.0.0.1:8000',
		apiKey: ''
	},
	legacy: {
		ids: ['local'],
		prefs: Object.fromEntries(['managed', 'tier', 'ocrMode', 'port', 'idleStopMinutes', 'envDir', 'uvPath',
			'modelSource', 'url', 'apiKey'].map(name => ['local.' + name, name]))
	},
	settings: {
		fragment: 'content/providers/mineru-local/settings.xhtml',
		script: 'content/providers/mineru-local/settings.js'
	},

	runtime: AgentParserMinerULocal.runtime,


	init(ctx) {
		AgentParserMinerULocal.runtime.init(ctx.getPref);
	},


	shutdown() {
		return AgentParserMinerULocal.runtime.shutdown();
	},


	// The server runs one task at a time: inference is serialized, so parallel tasks just compete
	// for memory
	getConcurrency() {
		return 1;
	},


	getSetupIssue() {
		let runtime = AgentParserMinerULocal.runtime;
		if (runtime._task) {
			return { l10nID: 'agentparser-mineru-local-setup-installing', installing: true };
		}
		// Unknown until refreshSetup() has checked counts as ready, so that jobs aren't held up
		if (runtime.isReady() === false) {
			return { l10nID: 'agentparser-mineru-local-setup-install' };
		}
		return null;
	},


	async refreshSetup() {
		await AgentParserMinerULocal.runtime.getStatus({ refresh: true });
	},


	classifyError() {
		return 'error';
	},


	getFallback() {
		return null;
	},


	describe(parserInfo) {
		return parserInfo.tier || 'default';
	},


	create(ctx) {
		return new AgentParserMinerULocal.Backend(ctx.getPref);
	}
});
