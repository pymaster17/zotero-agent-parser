/* global Zotero, Services, window, document */

/**
 * Agent Parser settings
 *
 * The core settings (status, which service parses what, general options, output) are in
 * preferences.xhtml. Each provider brings its own section: an XHTML fragment and a script that
 * defines AgentParserProviderSettings[<provider ID>] = { init(ctx), refresh(), update() }, where
 * ctx = { plugin, provider, container }.
 */
window.AgentParserProviderSettings = window.AgentParserProviderSettings || {};

window.AgentParserPrefs = {
	_timer: null,


	async init() {
		await this._renderRouting();
		await this._loadProviderSections();
		this.update();
		this.updateQueueStatus();
		this._timer = window.setInterval(() => {
			Promise.all([this.updateQueueStatus(), this._eachProviderSettings(x => x.refresh?.())])
				.catch(() => window.clearInterval(this._timer));
		}, 1500);
		window.addEventListener('unload', () => window.clearInterval(this._timer), { once: true });
	},


	get _plugin() {
		return Zotero.AgentParser;
	},


	get _providers() {
		return this._plugin ? this._plugin.providers.list() : [];
	},


	/**
	 * Called from oncommand/oninput handlers, which run before the pane copies the new value
	 * into the pref
	 */
	update() {
		window.setTimeout(() => this._update());
	},


	_update() {
		if (!this._plugin) {
			return;
		}
		this._updateRoutingWarning();
		this._eachProviderSettings(x => x.update?.());
	},


	async _eachProviderSettings(fn) {
		for (let provider of this._providers) {
			let settings = window.AgentParserProviderSettings[provider.id];
			if (settings) {
				try {
					await fn(settings);
				}
				catch (e) {
					Zotero.logError(e);
				}
			}
		}
	},


	/**
	 * The default service, and the one for large requests
	 */
	async _renderRouting() {
		let plugin = this._plugin;
		if (!plugin) {
			return;
		}
		let providers = this._providers;
		let names = {};
		for (let provider of providers) {
			names[provider.id] = await plugin.getString(provider.l10n.name);
		}

		// Bind the prefs only once the choices exist, so that the current value gets selected
		let radiogroup = document.getElementById('agentparser-default-provider');
		radiogroup.removeAttribute('preference');
		radiogroup.replaceChildren(...providers.map((provider) => {
			let radio = document.createXULElement('radio');
			radio.setAttribute('value', provider.id);
			radio.setAttribute('label', names[provider.id]);
			return radio;
		}));
		radiogroup.setAttribute('preference', 'extensions.agentparser.defaultProvider');

		let batchProviders = providers.filter(x => x.maxBatch);
		let menulist = document.getElementById('agentparser-bulk-provider');
		menulist.removeAttribute('preference');
		let popup = menulist.menupopup;
		let same = document.createXULElement('menuitem');
		same.setAttribute('value', '');
		document.l10n.setAttributes(same, 'agentparser-pref-bulk-provider-default');
		popup.replaceChildren(same, ...batchProviders.map((provider) => {
			let item = document.createXULElement('menuitem');
			item.setAttribute('value', provider.id);
			item.setAttribute('label', names[provider.id]);
			return item;
		}));
		menulist.setAttribute('preference', 'extensions.agentparser.bulkProvider');

		// With a single service there's nothing to choose
		let single = providers.length < 2;
		radiogroup.hidden = single;
		document.getElementById('agentparser-bulk-row').hidden = single || !batchProviders.length;
		document.getElementById('agentparser-single-provider-desc').hidden = !single;
	},


	_updateRoutingWarning() {
		let plugin = this._plugin;
		let warning = document.getElementById('agentparser-routing-warning');
		let bulk = plugin.getBulkProvider();
		let issue = bulk && bulk != plugin.getDefaultProvider() && plugin.getProviderSetupIssue(bulk);
		warning.hidden = !issue;
		if (issue) {
			plugin.getProviderName(bulk).then((name) => {
				document.l10n.setAttributes(warning, 'agentparser-pref-bulk-not-ready', { provider: name });
			});
		}
	},


	/**
	 * Insert each provider's settings section
	 */
	async _loadProviderSections() {
		let plugin = this._plugin;
		let container = document.getElementById('agentparser-provider-sections');
		if (!plugin || !container) {
			return;
		}
		container.replaceChildren();
		document.l10n.addResourceIds(plugin.getFTLFiles().slice(1));
		for (let provider of this._providers) {
			if (!provider.settings) {
				continue;
			}
			try {
				let section = document.createXULElement('groupbox');
				section.id = 'agentparser-provider-' + provider.id;
				let heading = document.createXULElement('label');
				let h2 = document.createElementNS('http://www.w3.org/1999/xhtml', 'h2');
				document.l10n.setAttributes(h2, provider.l10n.name);
				heading.append(h2);
				section.append(heading);

				let markup = await Zotero.File.getContentsFromURLAsync(plugin.rootURI + provider.settings.fragment);
				section.append(window.MozXULElement.parseXULToFragment(markup));
				container.append(section);

				if (provider.settings.script) {
					Services.scriptloader.loadSubScript(plugin.rootURI + provider.settings.script, window);
					await window.AgentParserProviderSettings[provider.id]?.init?.({
						plugin,
						provider,
						container: section
					});
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	},


	async updateQueueStatus() {
		let plugin = this._plugin;
		let label = document.getElementById('agentparser-queue-status');
		if (!plugin || !label) {
			return;
		}
		this._renderSummary();
		let { queued, running } = plugin.getStatus();
		let names = {};
		for (let provider of this._providers) {
			names[provider.id] = await plugin.getString(provider.l10n.name);
		}
		label.value = await plugin.getString('agentparser-pref-queue-status', {
			queued,
			running: running.length,
			details: running.length
				? ' — ' + running.slice(0, 3).map(x => `${x.key} (${names[x.service] || x.service}: ${x.status})`).join(', ')
					+ (running.length > 3 ? ', …' : '')
				: ''
		});
	},


	clearQueue() {
		Zotero.AgentParser?.clearQueue();
		this.updateQueueStatus();
	},


	_renderSummary() {
		let plugin = this._plugin;
		let summary = plugin.getSummary();
		let icon = document.getElementById('agentparser-status-icon');
		let text = document.getElementById('agentparser-status-text');
		let iconName;
		let textID;
		if (summary.setupIssue) {
			iconName = 'warning';
			textID = summary.setupIssue.id;
		}
		else {
			iconName = summary.autoParse ? 'done' : 'none';
			textID = summary.autoParse ? 'agentparser-pref-status-ok' : 'agentparser-pref-status-paused';
		}
		icon.src = `chrome://agentparser/content/icons/${iconName}.svg`;
		if (text.getAttribute('data-l10n-id') != textID) {
			document.l10n.setAttributes(text, textID);
		}
		document.getElementById('agentparser-status-setup').hidden = !summary.setupIssue
			|| summary.setupIssue.installing;

		let failuresLine = document.getElementById('agentparser-failures-line');
		failuresLine.hidden = !summary.failed;
		if (summary.failed) {
			document.l10n.setAttributes(document.getElementById('agentparser-failures-status'),
				'agentparser-pref-failures', { count: summary.failed });
		}
	},


	/**
	 * Take the user to what needs to be set up
	 */
	scrollToSetup() {
		let issue = this._plugin?.getSetupIssue();
		if (!issue) {
			return;
		}
		let section = document.getElementById('agentparser-provider-' + issue.provider);
		let target = section?.querySelector('[data-setup-focus]') || section;
		target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		target?.focus?.();
	},


	async retryFailed() {
		let plugin = this._plugin;
		if (!plugin) {
			return;
		}
		await plugin.retryFailed();
		this.updateQueueStatus();
	},


	clearFailures() {
		this._plugin?.clearFailures();
		this.updateQueueStatus();
	}
};
