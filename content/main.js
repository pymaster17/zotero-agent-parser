/* global Zotero, AgentParserBackends, AgentParserOutput, AgentParserLocal, Localization */

AgentParser = {
	PREF_PREFIX: 'extensions.agentparser.',
	FTL: 'agent-parser.ftl',
	// The v4 API accepts up to 50 files per request
	BATCH_SIZE: 50,

	id: null,
	version: null,
	rootURI: null,

	_notifierID: null,
	_queue: [],
	_running: new Map(),
	_batchRunning: false,
	_pumpScheduled: false,
	_windowElements: new WeakMap(),
	_shuttingDown: false,
	_l10n: null,


	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this._l10n = typeof Localization != 'undefined' ? new Localization([this.FTL]) : null;
		this._notifierID = Zotero.Notifier.registerObserver(this, ['item'], 'agentParser');
		// Only in the full edition
		this.local = typeof AgentParserLocal != 'undefined' ? AgentParserLocal : null;
		this.local?.init(name => this.getPref(name));
		// Let the preferences pane and other code reach us
		Zotero.AgentParser = this;
	},


	shutdown() {
		this._shuttingDown = true;
		if (this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
			this._notifierID = null;
		}
		for (let win of Zotero.getMainWindows()) {
			this.removeFromWindow(win);
		}
		this.local?.shutdown().catch(e => Zotero.logError(e));
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


	createBackend(name) {
		return AgentParserBackends.create(name, prefName => this.getPref(prefName));
	},
	
	
	getDefaultBackend() {
		return this.local && this.getPref('mode') == 'local' ? 'local' : 'cloudV4';
	},
	
	
	hasCloudToken() {
		return !!(this.getPref('cloudV4.token') || '').trim();
	},
	
	
	/**
	 * Pick the service for a queue entry
	 *
	 * Local parsing takes about a minute per paper on Apple Silicon, so large requests (e.g., the
	 * whole library) go to the cloud batch API when a token is configured, unless the user chose
	 * a service explicitly.
	 */
	getBackendFor(entry) {
		if (entry.backend && AgentParserBackends.classFor(entry.backend)) {
			return entry.backend;
		}
		let name = this.getDefaultBackend();
		if (name == 'local' && entry.bulk && this.getPref('bulkUseCloud') && this.hasCloudToken()) {
			return 'cloudV4';
		}
		return name;
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
		if (event != 'add' || type != 'item' || !this.getPref('autoParse')) {
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
	 * @param {String} [options.backend] - 'cloudV4' or 'local' instead of the default service
	 */
	enqueue(attachment, { force = false, waitForFile = false, bulk = false, backend = null } = {}) {
		let key = attachment.libraryKey;
		if (this._running.has(key)) {
			return false;
		}
		let existing = this._queue.find(x => x.key == key);
		if (existing) {
			existing.force = existing.force || force;
			existing.backend = backend || existing.backend;
			this._persistQueue();
			return false;
		}
		this._queue.push({ key, force, waitForFile, bulk, backend });
		this._persistQueue();
		this._schedulePump();
		return true;
	},
	
	
	restoreQueue() {
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
					backend: AgentParserBackends.classFor(entry.backend) ? entry.backend : null
				});
			}
		}
		if (this._queue.length) {
			Zotero.debug(`Agent Parser: Resuming ${this._queue.length} queued job(s)`);
		}
		this._pump();
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
	
	
	_persistQueue() {
		if (this._shuttingDown) {
			return;
		}
		let entries = [...this._running.values(), ...this._queue]
			.map(x => ({ key: x.key, force: x.force, bulk: x.bulk, backend: x.backend || null }));
		this.setPref('queue', JSON.stringify(entries));
	},
	
	
	_supportsBatch(name) {
		return typeof AgentParserBackends.classFor(name)?.prototype.parseBatch == 'function';
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
		if (this._shuttingDown) {
			return;
		}
		let batched = x => x.bulk && this._supportsBatch(this.getBackendFor(x));
		
		// One batch at a time, alongside regular jobs, so that newly added items don't wait for a
		// whole library to finish
		if (!this._batchRunning && this._queue.some(batched)) {
			let backend = this.getBackendFor(this._queue.find(batched));
			let entries = [];
			this._queue = this._queue.filter((x) => {
				if (batched(x) && this.getBackendFor(x) == backend && entries.length < this.BATCH_SIZE) {
					entries.push(x);
					return false;
				}
				return true;
			});
			let jobs = entries.map(x => ({ ...x, service: backend, status: 'starting', inBatch: true }));
			for (let job of jobs) {
				this._running.set(job.key, job);
			}
			this._batchRunning = true;
			this._persistQueue();
			this._processBatch(jobs)
				.catch(e => Zotero.logError(e))
				.finally(() => {
					this._batchRunning = false;
					for (let job of jobs) {
						this._running.delete(job.key);
					}
					this._persistQueue();
					this._pump();
				});
		}
		
		// The local server handles one task at a time
		let capacity = name => (name == 'local' ? 1 : Math.max(1, this._getIntPref('concurrency', 1)));
		let running = name => [...this._running.values()].filter(x => !x.inBatch && x.service == name).length;
		while (true) {
			let index = this._queue.findIndex((x) => {
				let name = this.getBackendFor(x);
				return !batched(x) && running(name) < capacity(name);
			});
			if (index == -1) {
				break;
			}
			let [entry] = this._queue.splice(index, 1);
			// `backend` is an explicit choice that's persisted, `service` is what the job actually uses
			let job = { ...entry, service: this.getBackendFor(entry), status: 'starting' };
			this._running.set(entry.key, job);
			this._persistQueue();
			this._process(job)
				.catch(async (e) => {
					if (this._shuttingDown) {
						return;
					}
					Zotero.logError(e);
					await this._notify('failure', job, e.message || String(e));
				})
				.finally(() => {
					this._running.delete(entry.key);
					this._persistQueue();
					this._pump();
				});
		}
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
			let backendName = job.service;
			Zotero.debug(`Agent Parser: Parsing ${job.key} (${ctx.filePath}) with ${backendName}`);
			let parser = await this.createBackend(backendName).parse({
				...ctx.backendJob,
				pollInterval: this._getPollInterval(),
				deadline: Date.now() + this._getTimeout(),
				onStatus: (status) => {
					job.status = status;
					Zotero.debug(`Agent Parser: ${job.key}: ${status}`);
				},
				checkCancelled: () => this._checkCancelled()
			});
			if (await this._complete(ctx, parser)) {
				await this._notify('success', job);
			}
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
		};
		
		let ctxs = [];
		for (let job of jobs) {
			try {
				let ctx = await this._prepare(job);
				if (ctx) {
					ctxs.push(ctx);
					continue;
				}
			}
			catch (e) {
				this._checkCancelled();
				Zotero.logError(e);
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
					checkCancelled: () => this._checkCancelled(),
					onStatus: (backendJob, status) => {
						backendJob.ctx.job.status = status;
					},
					onDone: async (backendJob, parser) => {
						let ctx = backendJob.ctx;
						remaining.delete(ctx);
						try {
							await this._complete(ctx, parser);
							stats.done++;
						}
						catch (e) {
							Zotero.logError(e);
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
						stats.failed++;
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
		let attachment = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
		if (!attachment || !this.isParsable(attachment)) {
			return null;
		}
		job.title = attachment.parentItem ? attachment.parentItem.getDisplayTitle() : attachment.getDisplayTitle();
		
		let filePath = await this._waitForFile(job, attachment);
		if (!filePath) {
			Zotero.debug(`Agent Parser: File for ${job.key} not available -- skipping`);
			return null;
		}
		
		let outputDir = AgentParserOutput.getOutputDir(attachment, filePath, this.getPref('outputDirName'));
		job.status = 'hashing';
		let sha256 = await AgentParserOutput.sha256(filePath);
		if (!job.force && (await AgentParserOutput.readSourceHash(outputDir)) == sha256) {
			Zotero.debug(`Agent Parser: ${job.key} is already parsed -- skipping`);
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
			tempDir
		};
		job.status = 'queued';
		return ctx;
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
		await AgentParserOutput.finalize(stagingDir, {
			item: attachment.parentItem,
			attachment,
			filePath,
			sha256,
			parser
		});
		await AgentParserOutput.install(stagingDir, outputDir);
		
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
	
	
	async _cleanup(ctx) {
		await IOUtils.remove(ctx.tempDir, { recursive: true, ignoreAbsent: true });
	},
	
	
	_getPollInterval() {
		return Math.max(1, this._getIntPref('pollIntervalSeconds', 3)) * 1000;
	},
	
	
	_getTimeout() {
		return Math.max(1, this._getIntPref('timeoutMinutes', 60)) * 60 * 1000;
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


	async _notify(type, job, message) {
		if (!this.getPref('showNotifications') || this._shuttingDown) {
			return;
		}
		let headline = await this.getString(type == 'success'
			? 'agentparser-notify-success'
			: 'agentparser-notify-failure');
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(headline);
		pw.addDescription(job.title || job.key);
		if (message) {
			pw.addDescription(message);
		}
		pw.show();
		pw.startCloseTimer(type == 'success' ? 4000 : 10000);
	},


	async _notifyBatch({ done, failed }) {
		if (!this.getPref('showNotifications') || this._shuttingDown) {
			return;
		}
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(await this.getString('agentparser-notify-batch'));
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
	 * @param {String} [backend] - Service to use instead of the default
	 */
	async parseSelected(win, force, backend = null) {
		let attachments = this.getParsableAttachments(win.ZoteroPane.getSelectedItems());
		let bulk = attachments.length > 1;
		let count = 0;
		for (let attachment of attachments) {
			if (this.enqueue(attachment, { force, bulk, backend })) {
				count++;
			}
		}
		await this._showQueued(count);
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
		let service = this.getBackendFor({ bulk: true });
		let ok = win.confirm(await this.getString(
			service == 'local' ? 'agentparser-confirm-library-local' : 'agentparser-confirm-library',
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
		win.MozXULElement.insertFTLIfNeeded(this.FTL);
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
			if (this.local) {
				added.push(
					makeItem('agentparser-menu-parse-cloud', () => this.parseSelected(win, true, 'cloudV4')),
					makeItem('agentparser-menu-parse-local', () => this.parseSelected(win, true, 'local'))
				);
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
	},


	removeFromWindow(win) {
		let elements = this._windowElements.get(win);
		if (!elements) {
			return;
		}
		for (let elem of elements) {
			elem.remove();
		}
		this._windowElements.delete(win);
		win.document.querySelector(`[href="${this.FTL}"]`)?.remove();
	}
};
