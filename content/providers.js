/* global Zotero, Services, AgentParserHTTP */

/**
 * Parsing service providers
 *
 * The core (queue, routing, output, status UI) knows nothing about any particular service. Each
 * provider lives in content/providers/<id>/ and registers a descriptor here:
 *
 * {
 *   apiVersion: 1,
 *   id: 'mineru-cloud',                    -- also the prefix of its prefs: providers.<id>.<name>
 *   kind: 'cloud' | 'local',
 *   ftl: 'agent-parser-mineru-cloud.ftl',  -- its strings, including:
 *   l10n: {
 *     name,                                -- short name, e.g. "MinerU Cloud"
 *     confirmBulk,                         -- confirmation before queueing a whole library ($count)
 *   },
 *   defaultPrefs: { name: value },          -- set on the default branch when registered
 *   legacy: {                              -- for migrating from before providers existed
 *     ids: ['cloudV4'],                    -- old names in the persisted queue and prefs
 *     prefs: { 'cloudV4.token': 'token' }, -- old pref -> own pref
 *   },
 *   limits: { maxPages, maxFileSize },      -- checked before submitting
 *   maxBatch: 50,                          -- if create() returns backends with parseBatch()
 *   settings: { fragment, script },        -- paths relative to the plugin root, see preferences.js
 *
 *   init(ctx), shutdown(),                  -- optional
 *   getConcurrency(ctx) -> Number,          -- single-file jobs at once
 *   getSetupIssue(ctx) -> null | { l10nID, installing },
 *                                          -- what's missing before files can be sent to it
 *   refreshSetup(ctx) -> Promise,           -- optional; recheck what getSetupIssue() reports
 *   classifyError(e) -> 'busy' | 'limit' | 'error',
 *                                          -- busy: try again later; limit: the file is outside
 *                                             the service's limits, so trying again won't help
 *   getFallback(parserInfo, variant) -> null | { variant, description },
 *                                          -- another way to parse a file whose output repeated
 *                                             itself
 *   describe(parserInfo) -> String,         -- for log messages
 *   frontMatter(parserInfo) -> Object,      -- optional; written to full.md as parser_<name>
 *   create(ctx, variant) -> backend,
 * }
 *
 * ctx = { getPref(name), setPref(name, value), plugin }
 *
 * backend.parse(job) leaves the raw results in job.stagingDir (one Markdown file plus images/,
 * see AgentParserOutput.finalize()) and returns an object describing the parser, which goes into
 * the front matter. backend.parseBatch(batch) is optional. backend.test() checks the connection.
 *
 * job = {
 *   filePath, fileName, fileSize, sha256,
 *   uploadName      -- ASCII-safe file name to send to the service
 *   dataID          -- unique ID for the file, also across libraries
 *   sourceURL       -- where the PDF was downloaded from, if known
 *   stagingDir      -- empty directory for the extracted results
 *   tempDir         -- scratch directory for downloads
 *   pollInterval    -- milliseconds
 *   timeout         -- milliseconds to wait once the service starts working on the file
 *   queueTimeout    -- milliseconds to wait while the service still has the file queued
 *   resume          -- what onSubmitted() reported before a restart, if anything
 *   onSubmitted(remote) -- remember a submission, so that it can be resumed after a restart
 *   onStatus(phase, detail) -- progress, where phase is one of PHASES
 *   checkCancelled()-- throws if the job should stop
 * }
 */
var AgentParserProviders = {
	API_VERSION: 1,
	PREF_PREFIX: 'extensions.agentparser.providers.',
	// Progress phases reported through onStatus(), shown in the status panel and item pane
	PHASES: ['preparing', 'uploading', 'pending', 'parsing', 'downloading'],

	_providers: new Map(),


	register(descriptor) {
		if (descriptor.apiVersion != this.API_VERSION) {
			throw new Error(`Agent Parser: Provider ${descriptor.id} uses API version ${descriptor.apiVersion}, `
				+ `but ${this.API_VERSION} is supported`);
		}
		if (this._providers.has(descriptor.id)) {
			throw new Error(`Agent Parser: Provider ${descriptor.id} is already registered`);
		}
		this._setDefaultPrefs(descriptor);
		this._migrateLegacyPrefs(descriptor);
		this._providers.set(descriptor.id, descriptor);
	},


	unregisterAll() {
		this._providers.clear();
	},


	get(id) {
		return this._providers.get(id) || null;
	},


	/**
	 * @return {Object[]} - Descriptors, in the order they were registered
	 */
	list() {
		return [...this._providers.values()];
	},


	/**
	 * Find a provider by its ID, or by a name it had before providers existed
	 *
	 * @return {String|null} - Provider ID
	 */
	resolveID(id) {
		if (!id) {
			return null;
		}
		if (this._providers.has(id)) {
			return id;
		}
		for (let provider of this._providers.values()) {
			if (provider.legacy?.ids?.includes(id)) {
				return provider.id;
			}
		}
		return null;
	},


	prefName(id, name) {
		return this.PREF_PREFIX + id + '.' + name;
	},


	_setDefaultPrefs(descriptor) {
		let branch = Services.prefs.getDefaultBranch('');
		for (let [name, value] of Object.entries(descriptor.defaultPrefs || {})) {
			let full = this.prefName(descriptor.id, name);
			switch (typeof value) {
				case 'boolean':
					branch.setBoolPref(full, value);
					break;
				case 'number':
					branch.setIntPref(full, value);
					break;
				default:
					branch.setStringPref(full, String(value));
			}
		}
	},


	/**
	 * Move settings from the names they had before providers existed (e.g., cloudV4.token)
	 *
	 * Only values the user changed are moved, and only if the new pref hasn't been set yet, so
	 * this is safe to run on every startup.
	 */
	_migrateLegacyPrefs(descriptor) {
		for (let [oldName, newName] of Object.entries(descriptor.legacy?.prefs || {})) {
			let oldFull = 'extensions.agentparser.' + oldName;
			let newFull = this.prefName(descriptor.id, newName);
			try {
				if (!Services.prefs.prefHasUserValue(oldFull)) {
					continue;
				}
				if (!Services.prefs.prefHasUserValue(newFull)) {
					let value = Zotero.Prefs.get(oldFull, true);
					// Old prefs could hold numbers as strings or vice versa, so match the new type
					let type = Services.prefs.getDefaultBranch('').getPrefType(newFull);
					if (type == Services.prefs.PREF_BOOL) {
						value = value === true || value === 'true';
					}
					else if (type == Services.prefs.PREF_INT) {
						value = parseInt(value) || 0;
					}
					else {
						value = String(value);
					}
					Zotero.Prefs.set(newFull, value, true);
					Zotero.debug(`Agent Parser: Moved ${oldName} to providers.${descriptor.id}.${newName}`);
				}
				Services.prefs.clearUserPref(oldFull);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	},


	//
	// Helpers for providers
	//
	trimURL(url) {
		url = (url || '').trim().replace(/\/+$/, '');
		if (!url) {
			throw new Error("Service URL is not configured");
		}
		return url;
	},


	async readFile(path) {
		return IOUtils.read(path);
	},


	/**
	 * @param {String} value - Comma-, semicolon-, or space-separated hosts, e.g. "arxiv.org, *.example.com"
	 * @return {String[]}
	 */
	parseHosts(value) {
		return (value || '')
			.split(/[\s,;]+/)
			.map(x => x.trim().toLowerCase().replace(/^\*?\./, ''))
			.filter(Boolean);
	},


	/**
	 * Whether a URL is on one of the hosts, or a subdomain of one
	 */
	isAllowedURL(url, hosts) {
		let host;
		try {
			let uri = new URL(url);
			if (uri.protocol != 'https:' && uri.protocol != 'http:') {
				return false;
			}
			host = uri.hostname.toLowerCase();
		}
		catch (e) {
			return false;
		}
		return hosts.some(x => host == x || host.endsWith('.' + x));
	},


	/**
	 * Make sure a URL still serves the same file we have locally, before giving it to a service
	 * to download instead of uploading the file
	 *
	 * @return {Promise<String|null>} - Reason the URL can't be used, or null if it can
	 */
	async checkURL(url, fileSize) {
		try {
			let response = await AgentParserHTTP.request('GET', url, {
				headers: { Range: 'bytes=0-1023' },
				timeout: 30000,
				allowErrorStatus: true
			});
			let total;
			if (response.status == 206) {
				total = parseInt((response.headers.get('Content-Range') || '').split('/')[1]);
			}
			else if (response.status == 200) {
				total = parseInt(response.headers.get('Content-Length'));
			}
			else {
				return `HTTP ${response.status}`;
			}
			let reader = response.body.getReader();
			let { value } = await reader.read();
			reader.cancel().catch(() => {});
			if (!value || String.fromCharCode(...value.slice(0, 5)) != '%PDF-') {
				return "not a PDF";
			}
			if (total !== fileSize) {
				return `size ${total} doesn't match local file (${fileSize})`;
			}
			return null;
		}
		catch (e) {
			return e.message || String(e);
		}
	},


	/**
	 * Poll until `fn` returns a non-undefined value
	 *
	 * Services that report queueing set `job.queued` while the file waits on the server and
	 * `job.startedAt` once processing starts, so that `job.timeout` only covers actual parsing.
	 * Otherwise the timeout runs from the start of polling.
	 */
	async poll(job, fn, since = Date.now()) {
		while (true) {
			job.checkCancelled();
			let result;
			try {
				result = await fn();
			}
			catch (e) {
				// Keep polling through dropped connections and server hiccups
				if (!AgentParserHTTP.isTransientError(e)) {
					throw e;
				}
				job.checkCancelled();
				Zotero.debug(`Agent Parser: Polling for ${job.dataID} failed (${e.message}) -- trying again`);
			}
			if (result !== undefined) {
				return result;
			}
			if (this.isTimedOut(job, since)) {
				throw new Error("Timed out waiting for parse results");
			}
			await AgentParserHTTP.sleep(job.pollInterval);
		}
	},


	isTimedOut({ queued, startedAt, timeout, queueTimeout }, submittedAt) {
		let now = Date.now();
		if (queued) {
			return now - submittedAt > queueTimeout;
		}
		return now - (startedAt || submittedAt) > timeout;
	}
};
