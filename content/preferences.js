/* global Zotero, window, document */

window.AgentParserPrefs = {
	_timer: null,
	_refreshing: false,
	_hadTask: false,
	_lastLog: '',


	init() {
		this.update();
		this.updateQueueStatus();
		this._timer = window.setInterval(() => {
			Promise.all([this.updateQueueStatus(), this.refreshLocal()])
				.catch(() => window.clearInterval(this._timer));
		}, 1500);
		window.addEventListener('unload', () => window.clearInterval(this._timer), { once: true });
	},


	get _plugin() {
		return Zotero.AgentParser;
	},


	/**
	 * Called from oncommand/oninput handlers, which run before the pane copies the new value
	 * into the pref
	 */
	update({ refresh = false } = {}) {
		window.setTimeout(() => this._update({ refresh }));
	},


	_update({ refresh }) {
		let plugin = this._plugin;
		if (!plugin) {
			return;
		}
		let managed = !!plugin.getPref('local.managed');
		document.getElementById('agentparser-local-managed-section').hidden = !managed;
		document.getElementById('agentparser-local-external-section').hidden = managed;

		let tier = plugin.local.getTier();
		document.l10n.setAttributes(document.getElementById('agentparser-tier-desc'), 'agentparser-tier-desc-' + tier);

		let warning = document.getElementById('agentparser-mode-warning');
		let warningID = null;
		if (!plugin.hasCloudToken()) {
			if (plugin.getPref('mode') != 'local') {
				warningID = 'agentparser-warn-no-token';
			}
			else if (plugin.getPref('bulkUseCloud')) {
				warningID = 'agentparser-warn-bulk-no-token';
			}
		}
		warning.hidden = !warningID;
		if (warningID) {
			document.l10n.setAttributes(warning, warningID);
		}

		this.refreshLocal({ refresh });
	},


	async refreshLocal({ refresh = false } = {}) {
		let plugin = this._plugin;
		if (!plugin || this._refreshing) {
			return;
		}
		this._refreshing = true;
		try {
			let status = await plugin.local.getStatus({ refresh: refresh || (this._hadTask && !plugin.local._task) });
			this._hadTask = !!status.task;
			this._renderLocal(status);
		}
		finally {
			this._refreshing = false;
		}
	},


	_renderLocal(status) {
		let $ = id => document.getElementById(id);
		let l10n = (elem, id, args) => document.l10n.setAttributes($(elem), id, args);

		if (status.task) {
			let minutes = Math.floor((Date.now() - status.task.startedAt) / 60000);
			l10n('agentparser-local-env-status', 'agentparser-local-step-' + status.task.step, { minutes });
		}
		else if (status.installed) {
			l10n('agentparser-local-env-status', 'agentparser-local-env-ok', {
				version: status.mineruVersion,
				engine: status.engine == 'mlx' ? 'MLX' : 'auto',
				dir: status.envDir
			});
		}
		else {
			l10n('agentparser-local-env-status', 'agentparser-local-env-missing', { dir: status.envDir });
		}

		if (!status.installed) {
			l10n('agentparser-local-models-status', 'agentparser-local-unknown');
		}
		else {
			l10n('agentparser-local-models-status',
				status.modelsReady ? 'agentparser-local-models-ok' : 'agentparser-local-models-missing',
				{ tier: status.tier });
		}

		if (status.server) {
			l10n('agentparser-local-server-status',
				status.server.starting ? 'agentparser-local-server-starting' : 'agentparser-local-server-running',
				{ pid: String(status.server.pid || ''), url: status.server.url });
		}
		else {
			l10n('agentparser-local-server-status', 'agentparser-local-server-stopped');
		}

		let busy = !!status.task;
		let install = $('agentparser-local-install');
		install.disabled = busy;
		document.l10n.setAttributes(install,
			status.installed && status.modelsReady ? 'agentparser-local-update' : 'agentparser-local-install');
		$('agentparser-local-cancel').hidden = !busy;
		$('agentparser-local-start').disabled = busy || !status.installed || !status.modelsReady || !!status.server;
		$('agentparser-local-stop').disabled = !status.server;

		let log = $('agentparser-local-log');
		let text = status.log.join('\n');
		if (text != this._lastLog) {
			this._lastLog = text;
			log.value = text;
			log.scrollTop = log.scrollHeight;
		}
	},


	async install() {
		let plugin = this._plugin;
		let tier = plugin.local.getTier();
		let message = await plugin.getString('agentparser-local-install-confirm', {
			size: tier == 'basic' ? '2.6' : '4.8',
			dir: plugin.local.getEnvDir()
		});
		if (!window.confirm(message)) {
			return;
		}
		plugin.local.install()
			.catch(e => Zotero.debug('Agent Parser: Install failed: ' + e))
			.finally(() => this.refreshLocal({ refresh: true }));
		this._hadTask = true;
		this.refreshLocal();
	},


	cancelInstall() {
		this._plugin?.local.cancelInstall();
	},


	async stopServer() {
		await this._plugin?.local.stopServer();
		this.refreshLocal();
	},


	async test(backend) {
		let plugin = this._plugin;
		let resultLabel = document.getElementById('agentparser-test-result-' + backend);
		if (!plugin) {
			return;
		}
		resultLabel.value = backend == 'local' && plugin.local.isManaged()
			? await plugin.getString('agentparser-local-starting-hint')
			: '…';
		try {
			let result = await plugin.createBackend(backend).test();
			resultLabel.value = '✅ ' + result;
		}
		catch (e) {
			resultLabel.value = '❌ ' + (e.message || e);
		}
		this.refreshLocal();
	},


	async updateQueueStatus() {
		let plugin = this._plugin;
		let label = document.getElementById('agentparser-queue-status');
		if (!plugin || !label) {
			return;
		}
		let { queued, running } = plugin.getStatus();
		label.value = await plugin.getString('agentparser-pref-queue-status', {
			queued,
			running: running.length,
			details: running.length
				? ' — ' + running.slice(0, 3).map(x => `${x.key} (${x.service == 'local' ? 'local' : 'cloud'}: ${x.status})`).join(', ')
					+ (running.length > 3 ? ', …' : '')
				: ''
		});
	},


	clearQueue() {
		Zotero.AgentParser?.clearQueue();
		this.updateQueueStatus();
	}
};
