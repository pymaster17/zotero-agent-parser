/* global Zotero, Services, AgentParserProviders, AgentParserOutput, AgentParserUI, Localization */

AgentParser = {
	PREF_PREFIX: 'extensions.agentparser.',
	FTL: 'agent-parser.ftl',
	// Batches in flight at once. Servers parse submitted files in parallel, so this hands them
	// plenty of work, while limiting simultaneous uploads (each reads a whole PDF into memory).
	MAX_BATCHES: 4,
	// How long a file may wait in the server's queue before we give up on it
	QUEUE_TIMEOUT_HOURS: 24,
	// When the server refuses new work (queue full, daily task limit), try again after this long
	BUSY_RETRY_MINUTES: 15,
	// Failures kept for the status menu and item pane
	MAX_FAILURES: 500,
	// How long the toolbar button shows a check mark after the last file finished
	DONE_DISPLAY_MS: 15000,

	id: null,
	version: null,
	rootURI: null,

	_notifierID: null,
	_queue: [],
	_running: new Map(),
	_batchesRunning: 0,
	_pumpScheduled: false,
	_retryTimer: null,
	_windowElements: new WeakMap(),
	_started: false,
	_shuttingDown: false,
	_l10n: null,
	prefPaneID: 'agent-parser-prefs',
	// Persisted failures, keyed by attachment libraryKey: { message, title, service, time }
	_failures: {},
	// Whether an attachment has results, so that the item tree can show it without disk access
	_parsed: new Map(),
	_parsedPending: new Set(),
	_parsedCheckScheduled: false,
	_listeners: new Set(),
	_changeTimer: null,
	_lastDone: 0,
	_doneTimer: null,
	_prefObservers: [],
	_providerPrefObserver: null,
	_setupTimers: new Map(),
	_setupNotified: false,
	_providerContexts: new Map(),


	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this._l10n = typeof Localization != 'undefined' ? new Localization(this.getFTLFiles()) : null;
		this._migrateRoutingPrefs();
		// Load the saved queue before anything can add to it, since saving the queue overwrites it
		this._loadQueue();
		this._loadFailures();
		this._notifierID = Zotero.Notifier.registerObserver(this, ['item'], 'agentParser');
		for (let provider of AgentParserProviders.list()) {
			try {
				provider.init?.(this.getProviderContext(provider.id));
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		// Let the preferences pane and other code reach us, and the providers
		this.providers = AgentParserProviders;
		Zotero.AgentParser = this;
		
		// Setup can be completed (or broken) from the preferences, so recheck whether queued jobs can run
		for (let name of ['defaultProvider', 'bulkProvider', 'autoParse']) {
			this._prefObservers.push(Zotero.Prefs.registerObserver(this.PREF_PREFIX + name, () => {
				this._changed();
				this._schedulePump();
			}, true));
		}
		this._providerPrefObserver = {
			observe: (subject, topic, prefName) => {
				let id = prefName.substr(AgentParserProviders.PREF_PREFIX.length).split('.')[0];
				if (AgentParserProviders.get(id)) {
					this._scheduleRefreshSetup(id);
				}
			}
		};
		Services.prefs.addObserver(AgentParserProviders.PREF_PREFIX, this._providerPrefObserver);
	},


	shutdown() {
		this._shuttingDown = true;
		clearTimeout(this._retryTimer);
		clearTimeout(this._changeTimer);
		clearTimeout(this._doneTimer);
		for (let symbol of this._prefObservers) {
			Zotero.Prefs.unregisterObserver(symbol);
		}
		this._prefObservers = [];
		if (this._providerPrefObserver) {
			Services.prefs.removeObserver(AgentParserProviders.PREF_PREFIX, this._providerPrefObserver);
			this._providerPrefObserver = null;
		}
		for (let timer of this._setupTimers.values()) {
			clearTimeout(timer);
		}
		this._listeners.clear();
		if (this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
			this._notifierID = null;
		}
		for (let win of Zotero.getMainWindows()) {
			this.removeFromWindow(win);
		}
		for (let provider of AgentParserProviders.list()) {
			Promise.resolve()
				.then(() => provider.shutdown?.())
				.catch(e => Zotero.logError(e));
		}
		// Leave the persisted queue in place so pending and running jobs resume on next startup
		delete Zotero.AgentParser;
	},


	getPref(name) {
		return Zotero.Prefs.get(this.PREF_PREFIX + name, true);
	},


	setPref(name, value) {
		return Zotero.Prefs.set(this.PREF_PREFIX + name, value, true);
	},


	_getIntPref(name, fallback) {
		let value = parseInt(this.getPref(name));
		return isNaN(value) || value < 0 ? fallback : value;
	},


	//
	// Providers
	//
	
	/**
	 * Language files of the core and every provider
	 */
	getFTLFiles() {
		return [this.FTL, ...AgentParserProviders.list().map(x => x.ftl).filter(Boolean)];
	},
	
	
	/**
	 * What a provider gets to work with: its own prefs, and the plugin
	 */
	getProviderContext(id) {
		let ctx = this._providerContexts.get(id);
		if (!ctx) {
			ctx = {
				id,
				plugin: this,
				getPref: name => Zotero.Prefs.get(AgentParserProviders.prefName(id, name), true),
				setPref: (name, value) => Zotero.Prefs.set(AgentParserProviders.prefName(id, name), value, true)
			};
			this._providerContexts.set(id, ctx);
		}
		return ctx;
	},
	
	
	/**
	 * @param {String} id - Provider ID
	 * @param {Object} [variant] - Provider-specific alternative way of parsing (see getFallback())
	 */
	createBackend(id, variant = null) {
		let provider = AgentParserProviders.get(id);
		if (!provider) {
			throw new Error(`Unknown parsing service '${id}'`);
		}
		return provider.create(this.getProviderContext(id), variant);
	},
	
	
	/**
	 * Settings from before providers existed: `mode` (cloud/local) and `bulkUseCloud`
	 */
	_migrateRoutingPrefs() {
		let legacy = name => this.PREF_PREFIX + name;
		try {
			if (Services.prefs.prefHasUserValue(legacy('mode'))) {
				let id = AgentParserProviders.resolveID(this.getPref('mode'));
				if (id && !Services.prefs.prefHasUserValue(legacy('defaultProvider'))) {
					this.setPref('defaultProvider', id);
				}
				Services.prefs.clearUserPref(legacy('mode'));
			}
			if (Services.prefs.prefHasUserValue(legacy('bulkUseCloud'))) {
				if (!this.getPref('bulkUseCloud') && !Services.prefs.prefHasUserValue(legacy('bulkProvider'))) {
					this.setPref('bulkProvider', '');
				}
				Services.prefs.clearUserPref(legacy('bulkUseCloud'));
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	},
	
	
	/**
	 * The service new files go to
	 */
	getDefaultProvider() {
		let id = this.getPref('defaultProvider');
		if (AgentParserProviders.get(id)) {
			return id;
		}
		return AgentParserProviders.list()[0]?.id || null;
	},
	
	
	/**
	 * The service for large requests (the whole library, many selected items), if not the default
	 */
	getBulkProvider() {
		let id = this.getPref('bulkProvider');
		let provider = AgentParserProviders.get(id);
		return provider && provider.maxBatch ? id : null;
	},
	
	
	/**
	 * Pick the service for a queue entry
	 *
	 * Local parsing takes about a minute per paper on Apple Silicon, so large requests (e.g., the
	 * whole library) can go to a service with a batch API instead, once it's set up, unless the
	 * user chose a service explicitly.
	 */
	getProviderFor(entry) {
		if (entry.provider && AgentParserProviders.get(entry.provider)) {
			return entry.provider;
		}
		let id = this.getDefaultProvider();
		let bulk = this.getBulkProvider();
		if (entry.bulk && bulk && bulk != id && this.isProviderReady(bulk)) {
			return bulk;
		}
		return id;
	},
	
	
	getProviderName(id) {
		let provider = AgentParserProviders.get(id);
		return provider ? this.getString(provider.l10n.name) : Promise.resolve(id || '');
	},
	
	
	async getString(id, args) {
		try {
			let l10n = this._l10n || Zotero.getMainWindow().document.l10n;
			return (await l10n.formatValue(id, args)) || id;
		}
		catch (e) {
			return id;
		}
	},


	//
	// Notifier
	//
	async notify(event, type, ids, extraData) {
		if (type != 'item') {
			return;
		}
		if (event == 'delete') {
			let changed = false;
			for (let id of ids) {
				let data = extraData && extraData[id];
				if (data && data.key) {
					let key = `${data.libraryID}/${data.key}`;
					this._parsed.delete(key);
					changed = this._removeFailure(key) || changed;
				}
			}
			if (changed) {
				this._saveFailures();
				this._changed();
			}
			return;
		}
		if (event != 'add' || !this.getPref('autoParse')) {
			return;
		}
		for (let id of ids) {
			// Items saved by data sync were (or will be) parsed on the computer that added them,
			// and the results arrive with the file via WebDAV
			if (this.getPref('skipSyncedItems') && extraData && extraData[id] && extraData[id].skipRenameFile) {
				continue;
			}
			let item = Zotero.Items.get(id);
			if (!item) {
				continue;
			}
			// Attachments trigger their own 'add' event, but a parent saved after its children
			// (e.g., via some import paths) might already have some
			let attachments = item.isRegularItem()
				? Zotero.Items.get(item.getAttachments())
				: [item];
			for (let attachment of attachments) {
				if (this.isParsable(attachment)) {
					this.enqueue(attachment, { waitForFile: true });
					this._warnIfBlocked(attachment);
				}
			}
		}
	},


	isParsable(item) {
		if (!item || !item.isAttachment() || item.deleted || !item.isPDFAttachment()) {
			return false;
		}
		if (item.isImportedAttachment()) {
			return true;
		}
		return item.attachmentLinkMode == Zotero.Attachments.LINK_MODE_LINKED_FILE
			&& !!this.getPref('includeLinkedFiles');
	},


	/**
	 * Expand a selection of items into parsable PDF attachments
	 */
	getParsableAttachments(items) {
		let attachments = new Map();
		for (let item of items) {
			let candidates = item.isRegularItem() ? Zotero.Items.get(item.getAttachments()) : [item];
			for (let attachment of candidates) {
				if (this.isParsable(attachment)) {
					attachments.set(attachment.id, attachment);
				}
			}
		}
		return [...attachments.values()];
	},


	//
	// Queue
	//
	
	/**
	 * @param {Zotero.Item} attachment
	 * @param {Object} [options]
	 * @param {Boolean} [options.force] - Parse even if results for the same file exist
	 * @param {Boolean} [options.waitForFile] - Wait for the file to finish downloading
	 * @param {Boolean} [options.bulk] - Part of a large request (e.g., the whole library), which
	 *     backends that support it process in batches
	 * @param {String} [options.provider] - Service to use instead of the default
	 */
	enqueue(attachment, { force = false, waitForFile = false, bulk = false, provider = null } = {}) {
		let key = attachment.libraryKey;
		if (this._running.has(key)) {
			return false;
		}
		if (this._removeFailure(key)) {
			this._saveFailures();
		}
		let existing = this._queue.find(x => x.key == key);
		if (existing) {
			existing.force = existing.force || force;
			existing.provider = provider || existing.provider;
			this._persistQueue();
			return false;
		}
		this._queue.push({ key, force, waitForFile, bulk, provider });
		this._persistQueue();
		this._schedulePump();
		return true;
	},
	
	
	_loadQueue() {
		let saved;
		try {
			saved = JSON.parse(this.getPref('queue') || '[]');
		}
		catch (e) {
			saved = [];
		}
		for (let entry of saved) {
			if (entry && entry.key && !this._queue.some(x => x.key == entry.key)) {
				this._queue.push({
					key: entry.key,
					force: !!entry.force,
					waitForFile: false,
					bulk: !!entry.bulk,
					// `backend` before providers existed
					provider: AgentParserProviders.resolveID(entry.provider || entry.backend),
					variant: this._loadVariant(entry),
					fallbackReason: entry.fallbackReason || null,
					remote: entry.remote && typeof entry.remote == 'object' ? entry.remote : null
				});
			}
		}
	},
	
	
	_loadVariant(entry) {
		if (entry.variant && typeof entry.variant == 'object') {
			return entry.variant;
		}
		// Fallback model and OCR setting for MinerU cloud, from before providers existed
		if (entry.model || typeof entry.ocr == 'boolean') {
			return { model: entry.model || null, ocr: typeof entry.ocr == 'boolean' ? entry.ocr : null };
		}
		return null;
	},
	
	
	/**
	 * Start processing the queue once Zotero is initialized
	 */
	async restoreQueue() {
		// Find out whether services are set up (e.g., local MinerU installed) before starting jobs
		await Promise.all(AgentParserProviders.list().map(provider => this._refreshProviderSetup(provider.id)));
		this._started = true;
		if (this._queue.length) {
			Zotero.debug(`Agent Parser: Resuming ${this._queue.length} queued job(s)`);
		}
		this._pump();
		this._changed();
		
		// The first time, take the user to the settings if there's something to set up
		if (!this.getPref('firstRunDone')) {
			this.setPref('firstRunDone', true);
			if (this.getSetupIssue()) {
				setTimeout(() => this.openPreferences(), 3000);
			}
		}
	},
	
	
	getStatus() {
		return {
			queued: this._queue.length,
			running: [...this._running.values()].map(x => ({ key: x.key, status: x.status, service: x.service }))
		};
	},
	
	
	clearQueue() {
		this._queue = [];
		this._persistQueue();
	},
	
	
	//
	// Status
	//
	_loadFailures() {
		try {
			let saved = JSON.parse(this.getPref('failures') || '{}');
			this._failures = saved && typeof saved == 'object' && !Array.isArray(saved) ? saved : {};
		}
		catch (e) {
			this._failures = {};
		}
	},
	
	
	_saveFailures() {
		if (this._shuttingDown) {
			return;
		}
		let keys = Object.keys(this._failures);
		if (keys.length > this.MAX_FAILURES) {
			keys.sort((a, b) => this._failures[a].time - this._failures[b].time);
			for (let key of keys.slice(0, keys.length - this.MAX_FAILURES)) {
				delete this._failures[key];
			}
		}
		this.setPref('failures', JSON.stringify(this._failures));
	},
	
	
	/**
	 * @param {Object} job
	 * @param {String} message
	 * @param {Object} [options]
	 * @param {String} [options.kind] - 'limit' if the file is outside the service's limits, so
	 *     that trying again with the same service won't help; 'error' otherwise
	 */
	_recordFailure(job, message, { kind = 'error' } = {}) {
		if (this._shuttingDown) {
			return;
		}
		this._failures[job.key] = {
			message: String(message || '').substr(0, 500),
			kind,
			title: job.title || null,
			service: job.service || null,
			time: Date.now()
		};
		this._saveFailures();
		this._changed();
	},
	
	
	/**
	 * @return {Boolean} - Whether there was a failure to remove
	 */
	_removeFailure(key) {
		if (!this._failures[key]) {
			return false;
		}
		delete this._failures[key];
		return true;
	},
	
	
	_recordSuccess(job) {
		this._parsed.set(job.key, true);
		if (this._removeFailure(job.key)) {
			this._saveFailures();
		}
		this._lastDone = Date.now();
		// Go back from the check mark to the idle icon
		clearTimeout(this._doneTimer);
		this._doneTimer = setTimeout(() => this._changed(), this.DONE_DISPLAY_MS + 100);
		this._changed();
	},
	
	
	getFailures() {
		return Object.entries(this._failures)
			.map(([key, x]) => ({ key, ...x }))
			.sort((a, b) => b.time - a.time);
	},
	
	
	clearFailures() {
		this._failures = {};
		this._saveFailures();
		this._changed();
	},
	
	
	/**
	 * Queue every failed file again
	 *
	 * @return {Promise<Integer>} - Number of files queued
	 */
	async retryFailed() {
		let count = 0;
		for (let { key, kind, service } of this.getFailures()) {
			// Files outside a service's limits fail the same way again, unless they'd go elsewhere now
			if (kind == 'limit' && AgentParserProviders.resolveID(service) == this.getProviderFor({})) {
				continue;
			}
			let { libraryID, key: itemKey } = Zotero.Items.parseLibraryKey(key);
			let attachment = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
			if (!attachment || !this.isParsable(attachment)) {
				this._removeFailure(key);
				continue;
			}
			// A failed file has no up-to-date results, so it doesn't need to be forced
			if (this.enqueue(attachment, { force: false })) {
				count++;
			}
		}
		this._saveFailures();
		this._changed();
		return count;
	},
	
	
	/**
	 * Listen for changes in parse status (queue, running jobs, failures, results)
	 *
	 * @return {Function} - Call to stop listening
	 */
	onChange(listener) {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	},
	
	
	_changed() {
		if (this._changeTimer || this._shuttingDown) {
			return;
		}
		this._changeTimer = setTimeout(() => {
			this._changeTimer = null;
			for (let listener of [...this._listeners]) {
				try {
					listener();
				}
				catch (e) {
					Zotero.logError(e);
				}
			}
		}, 250);
	},
	
	
	/**
	 * What a service needs before files can be sent to it, if anything
	 *
	 * @return {Object|null} - { provider, id, installing }, where id is the l10n ID of the issue
	 */
	getProviderSetupIssue(id) {
		let provider = AgentParserProviders.get(id);
		if (!provider) {
			return { provider: id, id: 'agentparser-setup-unavailable' };
		}
		let issue = null;
		try {
			issue = provider.getSetupIssue?.(this.getProviderContext(id)) || null;
		}
		catch (e) {
			Zotero.logError(e);
		}
		return issue && { provider: id, id: issue.l10nID, installing: !!issue.installing };
	},
	
	
	/**
	 * Whether a service is configured well enough to accept jobs
	 *
	 * Jobs for a service that isn't stay in the queue until it is, instead of failing.
	 */
	isProviderReady(id) {
		return !this.getProviderSetupIssue(id);
	},
	
	
	/**
	 * What the user needs to do before files can be parsed, if anything
	 *
	 * @return {Object|null} - See getProviderSetupIssue()
	 */
	getSetupIssue() {
		let ids = new Set([this.getDefaultProvider()]);
		// Files queued for another service (e.g., "Reparse with Local MinerU") wait for it too
		for (let entry of this._queue) {
			ids.add(this.getProviderFor(entry));
		}
		for (let id of ids) {
			let issue = this.getProviderSetupIssue(id);
			if (issue) {
				return issue;
			}
		}
		return null;
	},
	
	
	async _refreshProviderSetup(id) {
		let provider = AgentParserProviders.get(id);
		try {
			await provider?.refreshSetup?.(this.getProviderContext(id));
		}
		catch (e) {
			Zotero.logError(e);
		}
	},
	
	
	/**
	 * Recheck a service's setup after its prefs changed
	 */
	_scheduleRefreshSetup(id) {
		clearTimeout(this._setupTimers.get(id));
		this._setupTimers.set(id, setTimeout(() => {
			this._setupTimers.delete(id);
			this.refreshSetup(id);
		}, 500));
	},
	
	
	/**
	 * Recheck whether services are set up (e.g., local MinerU installed), and start jobs that
	 * were waiting for them
	 *
	 * @param {String} [id] - Only this provider
	 */
	async refreshSetup(id = null) {
		let ids = id ? [id] : AgentParserProviders.list().map(x => x.id);
		await Promise.all(ids.map(x => this._refreshProviderSetup(x)));
		this._changed();
		this._schedulePump();
	},
	
	
	/**
	 * Overall status for the toolbar button and the preferences
	 */
	getSummary() {
		let running = [...this._running.values()];
		let now = Date.now();
		let setupIssue = this.getSetupIssue();
		let blocked = setupIssue
			? this._queue.filter(x => !this.isProviderReady(this.getProviderFor(x))).length
			: 0;
		let failed = Object.keys(this._failures).length;
		let state;
		if (setupIssue && (blocked || !running.length)) {
			state = 'setup';
		}
		else if (running.length || this._queue.some(x => !x.notBefore || x.notBefore <= now)) {
			state = 'running';
		}
		else if (failed) {
			state = 'failed';
		}
		else if (this._queue.length) {
			// Only jobs deferred because the service is busy
			state = 'queued';
		}
		else if (now - this._lastDone < this.DONE_DISPLAY_MS) {
			state = 'done';
		}
		else {
			state = this.getPref('autoParse') ? 'idle' : 'paused';
		}
		return {
			state,
			setupIssue,
			running,
			queued: this._queue.length,
			blocked,
			deferred: this._queue.filter(x => x.notBefore > now).length,
			failed,
			autoParse: !!this.getPref('autoParse')
		};
	},
	
	
	/**
	 * What each service is doing, for the toolbar status panel
	 *
	 * @return {Object} - { <provider ID>: { running, queued, deferred, blocked } }, where running
	 *     is a list of { key, title, status, progress, inBatch }
	 */
	getServiceDetails() {
		let now = Date.now();
		let details = {};
		let get = name => details[name] || (details[name] = { running: [], queued: 0, deferred: 0, blocked: 0 });
		for (let job of this._running.values()) {
			get(job.service).running.push({
				key: job.key,
				title: job.title,
				status: job.status,
				progress: job.progress || null,
				inBatch: !!job.inBatch
			});
		}
		for (let entry of this._queue) {
			let name = this.getProviderFor(entry);
			let service = get(name);
			service.queued++;
			if (!this.isProviderReady(name)) {
				service.blocked++;
			}
			else if (entry.notBefore > now) {
				service.deferred++;
			}
		}
		return details;
	},
	
	
	/**
	 * Parse status of a PDF attachment
	 *
	 * @return {Object} - { state, status, message, service }, where state is one of 'running',
	 *     'queued', 'setup' (queued, waiting for setup), 'failed', 'done', 'none', or 'unknown'
	 *     (not checked yet -- a change is emitted once it is)
	 */
	getAttachmentState(attachment) {
		let key = attachment.libraryKey;
		let job = this._running.get(key);
		if (job) {
			return { state: 'running', status: job.status, progress: job.progress || null, service: job.service };
		}
		let entry = this._queue.find(x => x.key == key);
		if (entry) {
			let service = this.getProviderFor(entry);
			if (!this.isProviderReady(service)) {
				return { state: 'setup', service };
			}
			return {
				state: 'queued',
				status: entry.notBefore > Date.now() ? 'deferred' : null,
				service,
				notBefore: entry.notBefore || null
			};
		}
		let failure = this._failures[key];
		if (failure) {
			return {
				state: 'failed',
				kind: failure.kind || 'error',
				message: failure.message,
				// Failures from before providers existed name the old backend
				service: AgentParserProviders.resolveID(failure.service) || failure.service,
				time: failure.time
			};
		}
		let parsed = this._parsed.get(key);
		if (parsed === undefined) {
			this._checkParsed(attachment);
			return { state: 'unknown' };
		}
		return { state: parsed ? 'done' : 'none' };
	},
	
	
	/**
	 * Combined status of an item's PDFs, for the item tree
	 *
	 * @return {String} - The most important state among its attachments, or '' if it has none
	 */
	getItemState(item) {
		let attachments;
		if (item.isRegularItem()) {
			attachments = Zotero.Items.get(item.getAttachments()).filter(x => this.isParsable(x));
		}
		else if (this.isParsable(item)) {
			attachments = [item];
		}
		if (!attachments || !attachments.length) {
			return '';
		}
		let order = ['failed', 'setup', 'running', 'queued', 'done', 'none', 'unknown'];
		let best = 'unknown';
		for (let attachment of attachments) {
			let { state } = this.getAttachmentState(attachment);
			if (order.indexOf(state) < order.indexOf(best)) {
				best = state;
			}
		}
		return best == 'unknown' ? 'none' : best;
	},
	
	
	/**
	 * Find out whether an attachment has results, in the background
	 */
	_checkParsed(attachment) {
		this._parsedPending.add(attachment.id);
		if (this._parsedCheckScheduled) {
			return;
		}
		this._parsedCheckScheduled = true;
		setTimeout(async () => {
			let ids = [...this._parsedPending];
			this._parsedPending.clear();
			this._parsedCheckScheduled = false;
			let dirName = this.getPref('outputDirName');
			for (let attachment of Zotero.Items.get(ids)) {
				if (this._shuttingDown) {
					return;
				}
				let parsed = false;
				try {
					let path = await attachment.getFilePathAsync();
					if (path) {
						let dir = AgentParserOutput.getOutputDir(attachment, path, dirName);
						parsed = await IOUtils.exists(PathUtils.join(dir, AgentParserOutput.MARKDOWN_FILE));
					}
				}
				catch (e) {
					Zotero.debug(`Agent Parser: Couldn't check results of ${attachment.libraryKey}: ${e}`);
				}
				this._parsed.set(attachment.libraryKey, parsed);
			}
			this._changed();
		}, 50);
	},
	
	
	/**
	 * Tell the user once per session when new files are waiting for setup
	 */
	async _warnIfBlocked(attachment) {
		let issue = this.getSetupIssue();
		if (!issue || this._setupNotified || !this.getPref('showNotifications')) {
			return;
		}
		this._setupNotified = true;
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline('⚠️ ' + await this.getString('agentparser-notify-setup'));
		pw.addDescription(await this.getString(issue.id));
		pw.addDescription(await this.getString('agentparser-notify-setup-hint'));
		pw.show();
		pw.startCloseTimer(12000);
	},
	
	
	openPreferences() {
		Zotero.Utilities.Internal.openPreferences(this.prefPaneID);
	},
	
	
	_persistQueue() {
		if (this._shuttingDown) {
			return;
		}
		let entries = [...this._running.values(), ...this._queue]
			.map(x => ({
				key: x.key,
				force: x.force,
				bulk: x.bulk,
				provider: x.provider || null,
				variant: x.variant || null,
				fallbackReason: x.fallbackReason || null,
				// What the service already has, so that it isn't submitted again after a restart
				remote: x.remote || null
			}));
		this.setPref('queue', JSON.stringify(entries));
		this._changed();
	},
	
	
	_supportsBatch(id) {
		return !!AgentParserProviders.get(id)?.maxBatch;
	},
	
	
	/**
	 * Start jobs once the caller is done adding them, so that items added together end up in the
	 * same batch
	 */
	_schedulePump() {
		if (this._pumpScheduled) {
			return;
		}
		this._pumpScheduled = true;
		setTimeout(() => {
			this._pumpScheduled = false;
			this._pump();
		});
	},
	
	
	_pump() {
		if (this._shuttingDown || !this._started) {
			return;
		}
		let now = Date.now();
		// A follow-up job (e.g., a fallback parse) waits for the current one on the same file
		let ready = x => (!x.notBefore || x.notBefore <= now) && !this._running.has(x.key)
			// Jobs for a service that isn't set up yet wait for it instead of failing
			&& this.isProviderReady(this.getProviderFor(x));
		let batched = x => x.bulk && this._supportsBatch(this.getProviderFor(x));
		this._scheduleRetry();
		
		// Batches run alongside regular jobs, so that newly added items don't wait for a whole
		// library to finish
		while (this._batchesRunning < this.MAX_BATCHES && this._queue.some(x => ready(x) && batched(x))) {
			let backend = this.getProviderFor(this._queue.find(x => ready(x) && batched(x)));
			let maxBatch = AgentParserProviders.get(backend).maxBatch;
			let entries = [];
			this._queue = this._queue.filter((x) => {
				if (ready(x) && batched(x) && this.getProviderFor(x) == backend && entries.length < maxBatch) {
					entries.push(x);
					return false;
				}
				return true;
			});
			let jobs = entries.map(x => ({ ...x, service: backend, status: 'preparing', inBatch: true }));
			for (let job of jobs) {
				this._running.set(job.key, job);
			}
			this._batchesRunning++;
			this._persistQueue();
			this._processBatch(jobs)
				.catch(e => Zotero.logError(e))
				.finally(() => {
					this._batchesRunning--;
					for (let job of jobs) {
						this._running.delete(job.key);
					}
					this._persistQueue();
					this._pump();
				});
		}
		
		let capacity = (id) => {
			let provider = AgentParserProviders.get(id);
			return Math.max(1, provider?.getConcurrency?.(this.getProviderContext(id)) || 1);
		};
		let running = name => [...this._running.values()].filter(x => !x.inBatch && x.service == name).length;
		while (true) {
			let index = this._queue.findIndex((x) => {
				let name = this.getProviderFor(x);
				return ready(x) && !batched(x) && running(name) < capacity(name);
			});
			if (index == -1) {
				break;
			}
			let [entry] = this._queue.splice(index, 1);
			// `provider` is an explicit choice that's persisted, `service` is what the job actually uses
			let job = { ...entry, service: this.getProviderFor(entry), status: 'preparing' };
			this._running.set(entry.key, job);
			this._persistQueue();
			this._process(job)
				.catch(async (e) => {
					if (this._shuttingDown) {
						return;
					}
					Zotero.logError(`Agent Parser: Failed to parse ${job.key} (${job.title}): ${e.message || e}`);
					let kind = this._classifyError(job.service, e) == 'limit' ? 'limit' : 'error';
					if (kind == 'limit' && this._rerouteToDefault(job, e.message)) {
						return;
					}
					this._recordFailure(job, e.message || String(e), { kind });
					await this._notify('failure', job, e.message || String(e), kind);
				})
				.finally(() => {
					this._running.delete(entry.key);
					this._persistQueue();
					this._pump();
				});
		}
	},
	
	
	/**
	 * Wake up the pump when the earliest deferred job becomes ready
	 */
	_scheduleRetry() {
		clearTimeout(this._retryTimer);
		this._retryTimer = null;
		// Jobs that are ready but waiting for capacity get picked up when a running job finishes
		let now = Date.now();
		let times = this._queue.filter(x => x.notBefore > now).map(x => x.notBefore);
		if (!times.length || this._shuttingDown) {
			return;
		}
		let delay = Math.min(...times) - now + 1000;
		this._retryTimer = setTimeout(() => this._pump(), delay);
	},
	
	
	/**
	 * Put a job back in the queue because the service refused new work for now
	 */
	_defer(job, e) {
		Zotero.debug(`Agent Parser: ${job.key} deferred for ${this.BUSY_RETRY_MINUTES} minutes (${e.message})`);
		if (!this._queue.some(x => x.key == job.key)) {
			this._queue.push({
				key: job.key,
				force: job.force,
				waitForFile: false,
				bulk: job.bulk,
				provider: job.provider,
				variant: job.variant,
				fallbackReason: job.fallbackReason,
				notBefore: Date.now() + this.BUSY_RETRY_MINUTES * 60 * 1000
			});
		}
		this._persistQueue();
		this._scheduleRetry();
	},
	
	
	/**
	 * @return {String} - 'busy', 'limit', or 'error' (see AgentParserProviders)
	 */
	_classifyError(id, e) {
		// Jobs can end after shutdown, once the providers are gone
		if (this._shuttingDown) {
			return 'error';
		}
		try {
			return AgentParserProviders.get(id)?.classifyError?.(e) || 'error';
		}
		catch (x) {
			Zotero.logError(x);
			return 'error';
		}
	},
	
	
	/**
	 * Progress from a provider
	 */
	_setStatus(job, phase, detail = null) {
		job.status = phase;
		job.progress = detail;
		this._changed();
	},
	
	
	_checkCancelled() {
		if (this._shuttingDown) {
			throw new Error("Agent Parser is shutting down");
		}
	},
	
	
	async _process(job) {
		let ctx = await this._prepare(job);
		if (!ctx) {
			return;
		}
		try {
			Zotero.debug(`Agent Parser: Parsing ${job.key} (${ctx.filePath}) with ${job.service}`);
			let parser = await this.createBackend(job.service, job.variant).parse({
				...ctx.backendJob,
				pollInterval: this._getPollInterval(),
				timeout: this._getTimeout(),
				queueTimeout: this._getQueueTimeout(),
				onStatus: (phase, detail) => {
					Zotero.debug(`Agent Parser: ${job.key}: ${phase}${detail ? ' ' + detail : ''}`);
					this._setStatus(job, phase, detail);
				},
				checkCancelled: () => this._checkCancelled()
			});
			if (await this._complete(ctx, parser)) {
				this._recordSuccess(job);
				await this._notify('success', job);
			}
		}
		catch (e) {
			if (this._classifyError(job.service, e) != 'busy') {
				throw e;
			}
			this._defer(job, e);
		}
		finally {
			await this._cleanup(ctx);
		}
	},
	
	
	async _processBatch(jobs) {
		let stats = { done: 0, failed: 0 };
		let finishJob = (job) => {
			this._running.delete(job.key);
			this._persistQueue();
			if (this._queue.some(x => x.key == job.key)) {
				this._schedulePump();
			}
		};
		
		let ctxs = [];
		let startedAt = Date.now();
		for (let job of jobs) {
			try {
				let ctx = await this._prepare(job);
				if (ctx) {
					ctxs.push(ctx);
					continue;
				}
				// Skipped because it's outside the service's limits or the file is missing
				if (this._failures[job.key]?.time >= startedAt) {
					stats.failed++;
				}
			}
			catch (e) {
				this._checkCancelled();
				Zotero.logError(e);
				this._recordFailure(job, e.message || String(e));
				stats.failed++;
			}
			finishJob(job);
		}
		
		let remaining = new Set(ctxs);
		try {
			if (ctxs.length) {
				Zotero.debug(`Agent Parser: Parsing batch of ${ctxs.length} file(s)`);
				await this.createBackend(jobs[0].service).parseBatch({
					jobs: ctxs.map(ctx => ctx.backendJob),
					pollInterval: this._getPollInterval(),
					timeout: this._getTimeout(),
					queueTimeout: this._getQueueTimeout(),
					checkCancelled: () => this._checkCancelled(),
					onStatus: (backendJob, phase, detail) => {
						this._setStatus(backendJob.ctx.job, phase, detail);
					},
					onDone: async (backendJob, parser) => {
						let ctx = backendJob.ctx;
						remaining.delete(ctx);
						try {
							if (await this._complete(ctx, parser)) {
								this._recordSuccess(ctx.job);
							}
							stats.done++;
						}
						catch (e) {
							Zotero.logError(e);
							this._recordFailure(ctx.job, e.message || String(e));
							stats.failed++;
						}
						finally {
							await this._cleanup(ctx);
							finishJob(ctx.job);
						}
					},
					onFailed: async (backendJob, e) => {
						let ctx = backendJob.ctx;
						remaining.delete(ctx);
						Zotero.logError(`Agent Parser: Failed to parse ${ctx.job.key} (${ctx.job.title}): ${e.message || e}`);
						let kind = this._classifyError(ctx.job.service, e) == 'limit' ? 'limit' : 'error';
						if (kind == 'limit' && this._rerouteToDefault(ctx.job, e.message)) {
							await this._cleanup(ctx);
							finishJob(ctx.job);
							return;
						}
						this._recordFailure(ctx.job, e.message || String(e), { kind });
						stats.failed++;
						await this._cleanup(ctx);
						finishJob(ctx.job);
					},
					onDeferred: async (backendJob, e) => {
						let ctx = backendJob.ctx;
						remaining.delete(ctx);
						this._defer(ctx.job, e);
						await this._cleanup(ctx);
						finishJob(ctx.job);
					}
				});
			}
		}
		catch (e) {
			if (this._shuttingDown) {
				return;
			}
			Zotero.logError(e);
			stats.failed += remaining.size;
			for (let ctx of remaining) {
				this._recordFailure(ctx.job, e.message || String(e));
			}
		}
		finally {
			for (let ctx of remaining) {
				await this._cleanup(ctx);
			}
		}
		
		if (stats.done || stats.failed) {
			await this._notifyBatch(stats);
		}
	},
	
	
	/**
	 * Find the file, skip it if it's already parsed, and set up a temp directory
	 *
	 * @return {Promise<Object|null>} - Job context, or null to skip
	 */
	async _prepare(job) {
		let { libraryID, key } = Zotero.Items.parseLibraryKey(job.key);
		let library = Zotero.Libraries.get(libraryID);
		if (!library) {
			return null;
		}
		// The queue is restored at startup, before Zotero loads item data for every library
		await library.waitForDataLoad('item');
		let attachment = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
		if (!attachment || !this.isParsable(attachment)) {
			return null;
		}
		job.title = attachment.parentItem ? attachment.parentItem.getDisplayTitle() : attachment.getDisplayTitle();
		
		let filePath = await this._waitForFile(job, attachment);
		if (!filePath) {
			Zotero.debug(`Agent Parser: File for ${job.key} not available -- skipping`);
			if (!this._shuttingDown && !attachment.deleted) {
				let message = await this.getString('agentparser-error-no-file');
				this._recordFailure(job, message);
				if (!job.inBatch) {
					await this._notify('failure', job, message);
				}
			}
			return null;
		}
		
		let limit = await this._checkLimits(job, attachment, filePath);
		if (limit) {
			Zotero.debug(`Agent Parser: ${job.key} is outside the limits of ${job.service} (${limit.reason})`);
			if (!this._rerouteToDefault(job, limit.reason)) {
				this._recordFailure(job, limit.message, { kind: 'limit' });
				if (!job.inBatch) {
					await this._notify('failure', job, limit.message, 'limit');
				}
			}
			return null;
		}
		
		let outputDir = AgentParserOutput.getOutputDir(attachment, filePath, this.getPref('outputDirName'));
		job.status = 'preparing';
		let sha256 = await AgentParserOutput.sha256(filePath);
		if (!job.force && (await AgentParserOutput.readSourceHash(outputDir)) == sha256) {
			Zotero.debug(`Agent Parser: ${job.key} is already parsed -- skipping`);
			this._parsed.set(job.key, true);
			this._changed();
			return null;
		}
		
		let tempDir = PathUtils.join(
			Zotero.getTempDirectory().path,
			`agent-parser-${attachment.key}-${Date.now()}`
		);
		let stagingDir = PathUtils.join(tempDir, 'out');
		await IOUtils.makeDirectory(stagingDir, { createAncestors: true });
		
		let ctx = { job, attachment, filePath, outputDir, sha256, tempDir, stagingDir };
		ctx.backendJob = {
			ctx,
			filePath,
			fileName: PathUtils.filename(filePath),
			// Services can choke on non-ASCII names, and the real name is recorded in full.md
			uploadName: attachment.key + '.pdf',
			// Unique within a batch even across libraries
			dataID: `${attachment.libraryID}-${attachment.key}`,
			sourceURL: attachment.attachmentLinkMode == Zotero.Attachments.LINK_MODE_IMPORTED_URL
				? attachment.getField('url') || null
				: null,
			fileSize: (await IOUtils.stat(filePath)).size,
			sha256,
			stagingDir,
			tempDir,
			// A submission belongs to the service it was made to. Ones from before providers existed
			// were made to MinerU cloud.
			resume: job.remote && AgentParserProviders.resolveID(job.remote.provider || 'cloudV4') == job.service
				? job.remote
				: null,
			onSubmitted: (remote) => {
				job.remote = { ...remote, provider: job.service };
				this._persistQueue();
			}
		};
		return ctx;
	},
	
	
	/**
	 * Check the file against the service's limits before submitting it, since the service would
	 * reject it anyway (after an upload, for the size limit)
	 *
	 * @return {Promise<Object|null>} - { reason, message } if the file is outside the limits
	 */
	async _checkLimits(job, attachment, filePath) {
		let limits = AgentParserProviders.get(job.service)?.limits || {};
		let maxSize = limits.maxFileSize;
		if (maxSize) {
			let size = (await IOUtils.stat(filePath)).size;
			if (size > maxSize) {
				let mb = n => String(Math.round(n / 1024 / 1024 * 10) / 10);
				return {
					reason: `${mb(size)} MB > ${mb(maxSize)} MB`,
					message: await this.getString('agentparser-error-too-large', { size: mb(size), max: mb(maxSize) })
				};
			}
		}
		let maxPages = limits.maxPages;
		if (maxPages) {
			let pages = await this._getPageCount(attachment);
			if (pages > maxPages) {
				return {
					reason: `${pages} pages > ${maxPages}`,
					message: await this.getString('agentparser-error-too-many-pages', { pages, max: maxPages })
				};
			}
		}
		return null;
	},
	
	
	/**
	 * Large requests can go to a different service than the default (see getProviderFor()). A
	 * file that service doesn't accept goes to the default service instead, as it would have
	 * without that.
	 *
	 * @return {Boolean} - Whether the file was queued for the default service
	 */
	_rerouteToDefault(job, reason) {
		let defaultID = this.getDefaultProvider();
		if (job.provider || job.service == defaultID || !this.isProviderReady(defaultID)) {
			return false;
		}
		Zotero.debug(`Agent Parser: Parsing ${job.key} with ${defaultID} instead (${reason})`);
		this._queue = this._queue.filter(x => x.key != job.key);
		this._queue.push({
			key: job.key,
			force: job.force,
			waitForFile: false,
			bulk: false,
			provider: defaultID
		});
		this._persistQueue();
		this._schedulePump();
		return true;
	},
	
	
	/**
	 * @return {Promise<Integer|null>} - Number of pages, or null if the PDF can't be read
	 */
	async _getPageCount(attachment) {
		try {
			let { totalPages } = await Zotero.PDFWorker.getFullText(attachment.id, 1);
			return totalPages || null;
		}
		catch (e) {
			Zotero.debug(`Agent Parser: Couldn't count pages of ${attachment.libraryKey}: ${e}`);
			return null;
		}
	},
	
	
	/**
	 * Save parse results next to the PDF
	 *
	 * @return {Promise<Boolean>} - False if the attachment went away in the meantime
	 */
	async _complete(ctx, parser) {
		let { job, attachment, filePath, outputDir, sha256, stagingDir } = ctx;
		if (attachment.deleted || !(await IOUtils.exists(filePath))) {
			Zotero.debug(`Agent Parser: ${job.key} went away during parsing -- discarding results`);
			return false;
		}
		
		job.status = 'saving';
		if (job.fallbackReason) {
			parser = { ...parser, fallbackReason: job.fallbackReason };
		}
		let provider = AgentParserProviders.get(job.service);
		let parserFields = {};
		try {
			parserFields = provider?.frontMatter?.(parser) || {};
		}
		catch (e) {
			Zotero.logError(e);
		}
		let { repetition } = await AgentParserOutput.finalize(stagingDir, {
			item: attachment.parentItem,
			attachment,
			filePath,
			sha256,
			parser,
			parserFields
		});
		let fallback = null;
		if (repetition) {
			let mode = provider?.describe?.(parser) || job.service;
			Zotero.debug(`Agent Parser: ${job.key} output repeats ${JSON.stringify(repetition.unit.substr(0, 40))} `
				+ `over ${repetition.length} characters (${parser.service}, ${mode})`);
			fallback = this._getFallback(job, parser);
			let reason = `${mode} output repeated ${repetition.length} characters`;
			if (fallback) {
				fallback.reason = job.fallbackReason ? `${job.fallbackReason}; ${reason}` : reason;
			}
			// A fallback that did no better doesn't replace what the first model produced
			if (job.fallbackReason) {
				if (fallback) {
					this._enqueueFallback(job, fallback);
				}
				else {
					Zotero.debug(`Agent Parser: Keeping existing results for ${job.key}`);
				}
				return false;
			}
		}
		await AgentParserOutput.install(stagingDir, outputDir);
		if (fallback) {
			this._enqueueFallback(job, fallback);
		}
		
		if (this.getPref('markForSync')) {
			try {
				await AgentParserOutput.markForSync(attachment, filePath);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		await this._addSuccessTag(attachment);
		
		Zotero.debug(`Agent Parser: Saved results for ${job.key} to ${outputDir}`);
		return true;
	},
	
	
	/**
	 * Ask the provider for another way to parse a file whose output repeated itself, since
	 * parsing it again the same way produces the same output
	 *
	 * @return {Object|null} - { variant, description }, or null if there's nothing left to try
	 */
	_getFallback(job, parser) {
		let provider = AgentParserProviders.get(job.service);
		try {
			return provider?.getFallback?.(parser, job.variant) || null;
		}
		catch (e) {
			Zotero.logError(e);
			return null;
		}
	},
	
	
	/**
	 * Queue a fallback parse from _getFallback()
	 *
	 * The existing results stay in place until a fallback without repetition replaces them.
	 */
	_enqueueFallback(job, { variant, description, reason }) {
		Zotero.debug(`Agent Parser: Parsing ${job.key} again with ${description} (${reason})`);
		this._queue = this._queue.filter(x => x.key != job.key);
		this._queue.push({
			key: job.key,
			force: true,
			waitForFile: false,
			bulk: false,
			provider: job.service,
			variant,
			fallbackReason: reason
		});
		this._persistQueue();
		this._schedulePump();
	},
	
	
	async _cleanup(ctx) {
		await IOUtils.remove(ctx.tempDir, { recursive: true, ignoreAbsent: true });
	},
	
	
	_getPollInterval() {
		return Math.max(1, this._getIntPref('pollIntervalSeconds', 3)) * 1000;
	},
	
	
	_getTimeout() {
		return Math.max(1, this._getIntPref('timeoutMinutes', 60)) * 60 * 1000;
	},
	
	
	_getQueueTimeout() {
		return this.QUEUE_TIMEOUT_HOURS * 60 * 60 * 1000;
	},
	
	
	/**
	 * Files can show up after the attachment item (e.g., while the connector or Find Available PDF
	 * is still downloading), so wait for the file to exist and stop changing size
	 */
	async _waitForFile(job, attachment) {
		let waitMinutes = job.waitForFile ? this._getIntPref('waitForFileMinutes', 10) : 0;
		let deadline = Date.now() + waitMinutes * 60 * 1000;
		let lastSize = -1;
		while (true) {
			if (this._shuttingDown || attachment.deleted) {
				return null;
			}
			let path = await attachment.getFilePathAsync();
			if (path) {
				let size = (await IOUtils.stat(path)).size;
				if (size > 0 && size == lastSize) {
					return path;
				}
				lastSize = size;
				if (!job.waitForFile && size > 0) {
					return path;
				}
			}
			if (Date.now() > deadline) {
				return null;
			}
			job.status = 'waiting-file';
			await Zotero.Promise.delay(3000);
		}
	},


	async _addSuccessTag(attachment) {
		let tag = (this.getPref('successTag') || '').trim();
		let item = attachment.parentItem || attachment;
		if (!tag || item.hasTag(tag)) {
			return;
		}
		item.addTag(tag);
		await item.saveTx();
	},


	/**
	 * @param {String} type - 'success' or 'failure'
	 * @param {Object} job
	 * @param {String} [message]
	 * @param {String} [kind] - For failures, 'limit' if the file is outside the service's limits
	 */
	async _notify(type, job, message, kind = 'error') {
		if (!this.getPref('showNotifications') || this._shuttingDown) {
			return;
		}
		let headline = await this.getString(type == 'success'
			? 'agentparser-notify-success'
			: 'agentparser-notify-failure');
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline((type == 'success' ? '✅ ' : '❌ ') + headline);
		let line = new pw.ItemProgress('attachmentPDF', job.title || job.key);
		line.setProgress(100);
		if (type != 'success') {
			line.setError();
		}
		if (message) {
			pw.addDescription(message);
			let hint = 'agentparser-notify-failure-hint';
			if (kind == 'limit') {
				hint = AgentParserProviders.list().length > 1
					? 'agentparser-notify-limit-hint'
					: 'agentparser-notify-limit-hint-single';
			}
			pw.addDescription(await this.getString(hint));
		}
		pw.show();
		pw.startCloseTimer(type == 'success' ? 4000 : 10000);
	},


	async _notifyBatch({ done, failed }) {
		if (!this.getPref('showNotifications') || this._shuttingDown) {
			return;
		}
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline((failed ? '⚠️ ' : '✅ ') + await this.getString('agentparser-notify-batch'));
		pw.addDescription(await this.getString('agentparser-notify-batch-result', { done, failed }));
		pw.show();
		pw.startCloseTimer(failed ? 10000 : 5000);
	},
	
	
	//
	// Actions
	//
	/**
	 * @param {Window} win
	 * @param {Boolean} force
	 * @param {String} [provider] - Service to use instead of the default
	 */
	async parseSelected(win, force, provider = null) {
		let attachments = this.getParsableAttachments(win.ZoteroPane.getSelectedItems());
		let bulk = attachments.length > 1;
		let count = 0;
		for (let attachment of attachments) {
			if (this.enqueue(attachment, { force, bulk, provider })) {
				count++;
			}
		}
		await this._showQueued(count);
	},


	/**
	 * @return {Promise<String|null>} - Path of full.md, if the attachment has results
	 */
	async getResultPath(attachment) {
		let path = await attachment.getFilePathAsync();
		if (!path) {
			return null;
		}
		let dir = AgentParserOutput.getOutputDir(attachment, path, this.getPref('outputDirName'));
		let md = PathUtils.join(dir, AgentParserOutput.MARKDOWN_FILE);
		let exists = await IOUtils.exists(md);
		if (this._parsed.get(attachment.libraryKey) !== exists) {
			this._parsed.set(attachment.libraryKey, exists);
			this._changed();
		}
		return exists ? md : null;
	},


	async revealSelected(win) {
		let attachments = this.getParsableAttachments(win.ZoteroPane.getSelectedItems());
		for (let attachment of attachments) {
			let path = await attachment.getFilePathAsync();
			if (!path) {
				continue;
			}
			let dir = AgentParserOutput.getOutputDir(attachment, path, this.getPref('outputDirName'));
			let md = PathUtils.join(dir, AgentParserOutput.MARKDOWN_FILE);
			if (await IOUtils.exists(md)) {
				Zotero.File.reveal(md);
				return;
			}
		}
		win.alert(await this.getString('agentparser-alert-not-parsed'));
	},


	/**
	 * Queue every PDF in the current library that has no up-to-date results
	 */
	async parseLibrary(win) {
		let libraryID = win.ZoteroPane.getSelectedLibraryID();
		let attachments = (await Zotero.Items.getAll(libraryID, false, false))
			.filter(item => this.isParsable(item));
		let missing = [];
		for (let attachment of attachments) {
			let path = await attachment.getFilePathAsync();
			if (!path) {
				continue;
			}
			let dir = AgentParserOutput.getOutputDir(attachment, path, this.getPref('outputDirName'));
			if (!(await IOUtils.exists(PathUtils.join(dir, AgentParserOutput.MARKDOWN_FILE)))) {
				missing.push(attachment);
			}
		}
		if (!missing.length) {
			win.alert(await this.getString('agentparser-alert-library-done'));
			return;
		}
		let provider = AgentParserProviders.get(this.getProviderFor({ bulk: true }));
		let ok = win.confirm(await this.getString(
			provider?.l10n.confirmBulk || 'agentparser-confirm-library',
			{ count: missing.length }
		));
		if (!ok) {
			return;
		}
		let count = 0;
		for (let attachment of missing) {
			if (this.enqueue(attachment, { bulk: true })) {
				count++;
			}
		}
		await this._showQueued(count);
	},


	async _showQueued(count) {
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(await this.getString('agentparser-name'));
		pw.addDescription(await this.getString('agentparser-notify-queued', { count }));
		pw.show();
		pw.startCloseTimer(3000);
	},


	//
	// UI
	//
	addToWindow(win) {
		let doc = win.document;
		if (this._windowElements.has(win)) {
			return;
		}
		for (let ftl of this.getFTLFiles()) {
			win.MozXULElement.insertFTLIfNeeded(ftl);
		}
		let elements = [];

		let makeItem = (l10nID, oncommand) => {
			let menuitem = doc.createXULElement('menuitem');
			menuitem.setAttribute('data-l10n-id', l10nID);
			menuitem.addEventListener('command', oncommand);
			return menuitem;
		};

		// Item context menu
		let itemMenu = doc.getElementById('zotero-itemmenu');
		if (itemMenu) {
			let sep = doc.createXULElement('menuseparator');
			let parse = makeItem('agentparser-menu-parse', () => this.parseSelected(win, false));
			let reparse = makeItem('agentparser-menu-reparse', () => this.parseSelected(win, true));
			let reveal = makeItem('agentparser-menu-reveal', () => this.revealSelected(win));
			let added = [sep, parse, reparse];
			// With more than one service, offer each of them
			let providers = AgentParserProviders.list();
			if (providers.length > 1) {
				for (let provider of providers) {
					let menuitem = makeItem('agentparser-menu-parse-with', () => this.parseSelected(win, true, provider.id));
					this.getString(provider.l10n.name)
						.then(name => doc.l10n.setAttributes(menuitem, 'agentparser-menu-parse-with', { provider: name }))
						.catch(() => {});
					added.push(menuitem);
				}
			}
			added.push(reveal);
			itemMenu.append(...added);
			elements.push(...added);

			let onShowing = (event) => {
				if (event.target != itemMenu) {
					return;
				}
				let hasPDF = this.getParsableAttachments(win.ZoteroPane.getSelectedItems()).length > 0;
				for (let elem of added) {
					elem.hidden = !hasPDF;
				}
			};
			itemMenu.addEventListener('popupshowing', onShowing);
			elements.push({ remove: () => itemMenu.removeEventListener('popupshowing', onShowing) });
		}

		// Tools menu
		let toolsMenu = doc.getElementById('menu_ToolsPopup');
		if (toolsMenu) {
			let parseLibrary = makeItem('agentparser-menu-parse-library', () => this.parseLibrary(win));
			toolsMenu.append(parseLibrary);
			elements.push(parseLibrary);
		}

		this._windowElements.set(win, elements);
		
		// Status button in the toolbar
		try {
			AgentParserUI.addToWindow(win);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},


	removeFromWindow(win) {
		if (typeof AgentParserUI != 'undefined') {
			AgentParserUI.removeFromWindow(win);
		}
		let elements = this._windowElements.get(win);
		if (!elements) {
			return;
		}
		for (let elem of elements) {
			elem.remove();
		}
		this._windowElements.delete(win);
		for (let ftl of this.getFTLFiles()) {
			win.document.querySelector(`[href="${ftl}"]`)?.remove();
		}
	}
};
