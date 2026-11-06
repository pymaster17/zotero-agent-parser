/* global Zotero, window, document */

/**
 * Settings section for local MinerU: install, server, and the log
 */
window.AgentParserProviderSettings = window.AgentParserProviderSettings || {};

window.AgentParserProviderSettings['mineru-local'] = {
	_ctx: null,
	_refreshing: false,
	_hadTask: false,
	_lastLog: '',


	init(ctx) {
		this._ctx = ctx;
		this.update({ refresh: true });
	},


	get _runtime() {
		return this._ctx.provider.runtime;
	},


	get _plugin() {
		return this._ctx.plugin;
	},


	/**
	 * Called from oncommand handlers, which run before the pane copies the new value into the pref
	 */
	update({ refresh = false } = {}) {
		window.setTimeout(() => this._update({ refresh }));
	},


	_update({ refresh }) {
		let runtime = this._runtime;
		let managed = runtime.isManaged();
		document.getElementById('agentparser-local-managed-section').hidden = !managed;
		document.getElementById('agentparser-local-external-section').hidden = managed;
		document.l10n.setAttributes(document.getElementById('agentparser-tier-desc'),
			'agentparser-tier-desc-' + runtime.getTier());
		this.refresh({ refresh });
	},


	async refresh({ refresh = false } = {}) {
		if (!this._ctx || this._refreshing) {
			return;
		}
		this._refreshing = true;
		try {
			let status = await this._runtime.getStatus({ refresh: refresh || (this._hadTask && !this._runtime._task) });
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
		let tier = this._runtime.getTier();
		let message = await plugin.getString('agentparser-local-install-confirm', {
			size: tier == 'basic' ? '2.6' : '4.8',
			dir: this._runtime.getEnvDir()
		});
		if (!window.confirm(message)) {
			return;
		}
		this._runtime.install()
			.catch(e => Zotero.debug('Agent Parser: Install failed: ' + e))
			.finally(() => {
				this.refresh({ refresh: true });
				plugin.refreshSetup(this._ctx.provider.id);
			});
		this._hadTask = true;
		this.refresh();
		// Jobs for local MinerU wait while it's being installed
		plugin._changed();
	},


	cancelInstall() {
		this._runtime.cancelInstall();
	},


	async stopServer() {
		await this._runtime.stopServer();
		this.refresh();
	},


	async test() {
		let plugin = this._plugin;
		let resultLabel = document.getElementById('agentparser-mineru-local-test-result');
		resultLabel.value = this._runtime.isManaged()
			? await plugin.getString('agentparser-local-starting-hint')
			: '…';
		try {
			let result = await plugin.createBackend(this._ctx.provider.id).test();
			resultLabel.value = '✅ ' + result;
		}
		catch (e) {
			resultLabel.value = '❌ ' + (e.message || e);
		}
		this.refresh();
	}
};
