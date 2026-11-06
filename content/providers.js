/* global Zotero, Services, AgentParserHTTP */

/**
 * Parsing service providers
 *
 * The core (queue, routing, output, status UI) knows nothing about any particular service. Every
 * service -- a cloud API or a model the user runs themselves -- is a provider that registers a
 * descriptor here. They come from three places:
 *
 *   - bundled with the plugin: content/providers/<id>/ (MinerU cloud, PaddleOCR)
 *   - the user's own scripts: <Zotero data directory>/agent-parser/providers/*.js, loaded at
 *     startup (see loadUserProviders() and docs/custom-providers.md)
 *   - other Zotero plugins, which can register and unregister at any time:
 *     Zotero.AgentParser.providers.register(descriptor)
 *
 * {
 *   apiVersion: 1,
 *   id: 'mineru-cloud',                    -- also the prefix of its prefs: providers.<id>.<name>
 *   name: 'My service'                     -- display name: a string, or { 'zh-CN': ..., 'en-US': ... }
 *     or ftl + l10n: {                     -- Fluent strings, for providers with a locale folder
 *       name,                              -- short name, e.g. "MinerU Cloud"
 *       confirmBulk,                       -- confirmation before queueing a whole library ($count)
 *     },
 *   rootURI,                               -- optional; base for settings paths (default: this plugin)
 *   defaultPrefs: { name: value },          -- set on the default branch when registered
 *   legacy: {                              -- for migrating from before providers existed
 *     ids: ['cloudV4'],                    -- old names in the persisted queue and prefs
 *     prefs: { 'cloudV4.token': 'token' }, -- old pref -> own pref
 *   },
 *   limits: { maxPages, maxFileSize },      -- checked before submitting
 *   maxBatch: 50,                          -- if create() returns backends with parseBatch()
 *   settings: {                            -- its section in the settings, see preferences.js:
 *     fields: [{ pref, label, type, options, description }],
 *                                          -- simple form bound to its prefs, and/or
 *     fragment, script,                    -- XHTML fragment and script, relative to rootURI
 *     description,                         -- text above the fields (string or per-locale object)
 *     test: true,                          -- show a "Test connection" button (backend.test())
 *   },
 *
 *   init(ctx), shutdown(),                  -- optional
 *   getConcurrency(ctx) -> Number,          -- single-file jobs at once (default 1)
 *   getSetupIssue(ctx) -> null | { l10nID | message, installing },
 *                                          -- what's missing before files can be sent to it; files
 *                                             for it wait in the queue meanwhile
 *   refreshSetup(ctx) -> Promise,           -- optional; recheck what getSetupIssue() reports
 *   classifyError(e) -> 'busy' | 'unavailable' | 'limit' | 'error',
 *                                          -- busy: try again later; unavailable: the service
 *                                             isn't running, so queue the file again and report a
 *                                             setup issue until it is (then call
 *                                             ctx.plugin.refreshSetup(ctx.id)); limit: the file is
 *                                             outside the service's limits, so trying again won't
 *                                             help. Optional (default 'error').
 *   getFallback(parserInfo, variant) -> null | { variant, description },
 *                                          -- optional; another way to parse a file whose output
 *                                             repeated itself
 *   describe(parserInfo) -> String,         -- optional; for log messages
 *   frontMatter(parserInfo) -> Object,      -- optional; written to full.md as parser_<name>
 *   create(ctx, variant) -> backend,
 * }
 *
 * ctx = { id, getPref(name), setPref(name, value), plugin }
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
	// Folder in the Zotero data directory for the user's own providers
	USER_DIR: ['agent-parser', 'providers'],

	_providers: new Map(),
	_listeners: new Set(),
	// { file, ids, error } for each script in the user's folder, from the last loadUserProviders()
	userScripts: [],


	register(descriptor) {
		if (!descriptor || typeof descriptor.id != 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(descriptor.id)) {
			throw new Error(`Agent Parser: Provider ID must be letters, digits, ".", "_" or "-": ${descriptor && descriptor.id}`);
		}
		if (descriptor.apiVersion != this.API_VERSION) {
			throw new Error(`Agent Parser: Provider ${descriptor.id} uses API version ${descriptor.apiVersion}, `
				+ `but ${this.API_VERSION} is supported`);
		}
		if (this._providers.has(descriptor.id)) {
			throw new Error(`Agent Parser: Provider ${descriptor.id} is already registered`);
		}
		if (typeof descriptor.create != 'function') {
			throw new Error(`Agent Parser: Provider ${descriptor.id} has no create()`);
		}
		if (!descriptor.name && !descriptor.l10n?.name) {
			throw new Error(`Agent Parser: Provider ${descriptor.id} has no name`);
		}
		this._setDefaultPrefs(descriptor);
		this._migrateLegacyPrefs(descriptor);
		this._providers.set(descriptor.id, descriptor);
		this._notify('register', descriptor);
	},


	/**
	 * Remove a provider, e.g., when the plugin that registered it shuts down. Files queued for it
	 * wait until it's back.
	 */
	unregister(id) {
		let descriptor = this._providers.get(id);
		if (!descriptor) {
			return;
		}
		this._providers.delete(id);
		this._notify('unregister', descriptor);
	},


	unregisterAll() {
		this._providers.clear();
		this._listeners.clear();
		this.userScripts = [];
	},


	/**
	 * @param {Function} listener - (event, descriptor), where event is 'register' or 'unregister'
	 * @return {Function} - Removes the listener
	 */
	onChange(listener) {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	},


	_notify(event, descriptor) {
		for (let listener of [...this._listeners]) {
			try {
				listener(event, descriptor);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
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


	/**
	 * Pick the text for the app's language from a string or { 'zh-CN': ..., 'en-US': ... }
	 */
	localize(value) {
		if (value == null || typeof value == 'string') {
			return value || '';
		}
		let locale = Services.locale.appLocaleAsBCP47 || 'en-US';
		let lang = locale.split('-')[0];
		let key = Object.keys(value).find(x => x == locale)
			|| Object.keys(value).find(x => x.split('-')[0] == lang)
			|| (value['en-US'] !== undefined ? 'en-US' : Object.keys(value)[0]);
		return key === undefined ? '' : String(value[key]);
	},


	getUserDir() {
		return PathUtils.join(Zotero.DataDirectory.dir, ...this.USER_DIR);
	},


	/**
	 * Run the user's provider scripts, in file name order
	 *
	 * Each script runs with the same globals as the bundled providers (AgentParserProviders,
	 * AgentParserHTTP, AgentParserOutput, Zotero, IOUtils, ...) and calls
	 * AgentParserProviders.register(). A script that fails doesn't stop the others; its error is
	 * shown in the settings.
	 */
	async loadUserProviders() {
		this.userScripts = [];
		let dir = this.getUserDir();
		let files;
		try {
			if (!(await IOUtils.exists(dir))) {
				return;
			}
			files = (await IOUtils.getChildren(dir))
				.filter(x => /\.js$/i.test(x) && !PathUtils.filename(x).startsWith('.'))
				.sort();
		}
		catch (e) {
			Zotero.logError(e);
			return;
		}
		for (let file of files) {
			let before = new Set(this._providers.keys());
			let entry = { file: PathUtils.filename(file), ids: [], error: null };
			try {
				let url = Services.io.newFileURI(Zotero.File.pathToFile(file)).spec;
				// Don't cache, so that edits take effect after a restart
				Services.scriptloader.loadSubScriptWithOptions(url, { ignoreCache: true });
			}
			catch (e) {
				entry.error = e.message || String(e);
				Zotero.logError(e);
			}
			entry.ids = [...this._providers.keys()].filter(x => !before.has(x));
			if (!entry.ids.length && !entry.error) {
				entry.error = "The script didn't register a provider";
			}
			Zotero.debug(`Agent Parser: Loaded ${entry.file}: ${entry.ids.join(', ') || entry.error}`);
			this.userScripts.push(entry);
		}
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
	 * multipart/form-data body, built by hand so that it doesn't depend on FormData being
	 * available in the plugin's scope
	 *
	 * @param {Object} fields - Name -> string value
	 * @param {String} fileName
	 * @param {Uint8Array} fileData - Sent as the "file" field
	 * @return {Object} - { data: Uint8Array, contentType }
	 */
	multipart(fields, fileName, fileData, { fileField = 'file', fileType = 'application/pdf' } = {}) {
		let boundary = '----AgentParser' + Math.random().toString(36).slice(2) + Date.now().toString(36);
		let encoder = new TextEncoder();
		let parts = [];
		for (let [name, value] of Object.entries(fields)) {
			parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
		}
		let safeName = (fileName || 'document.pdf').replace(/["\r\n\\]/g, '_');
		parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${safeName}"\r\n`
			+ `Content-Type: ${fileType}\r\n\r\n`));
		parts.push(fileData);
		parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));
		let data = new Uint8Array(parts.reduce((sum, x) => sum + x.length, 0));
		let offset = 0;
		for (let part of parts) {
			data.set(part, offset);
			offset += part.length;
		}
		return { data, contentType: `multipart/form-data; boundary=${boundary}` };
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
