/* global Zotero, Services, ChromeUtils, window, document */

/**
 * Agent Parser settings
 *
 * The core settings (status, which service parses what, general options, output) are in
 * preferences.xhtml. Each provider brings its own section: fields declared in its descriptor
 * (settings.fields), which are bound to its prefs, and/or an XHTML fragment and a script that
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
			names[provider.id] = await plugin.getProviderName(provider.id);
		}

		// Bind the prefs only once the choices exist, so that the current value gets selected
		let radiogroup = document.getElementById('agentparser-default-provider');
		radiogroup.removeAttribute('preference');
		let choices = providers.map(x => x.id);
		// A service that isn't loaded (e.g., a custom provider whose script is gone) stays visible
		let current = plugin.getDefaultProvider();
		if (current && !choices.includes(current)) {
			choices.push(current);
			names[current] = await plugin.getString('agentparser-pref-provider-missing', { provider: current });
		}
		radiogroup.replaceChildren(...choices.map((id) => {
			let radio = document.createXULElement('radio');
			radio.setAttribute('value', id);
			radio.setAttribute('label', names[id]);
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
		let single = choices.length < 2;
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
				h2.textContent = await plugin.getProviderName(provider.id);
				heading.append(h2);
				section.append(heading);
				container.append(section);

				let { fields, fragment, script, description, test } = provider.settings;
				let base = provider.rootURI || plugin.rootURI;
				let resolve = path => (/^[a-z][a-z0-9+.-]*:/i.test(path) ? path : base + path);
				if (description) {
					let desc = document.createXULElement('description');
					desc.textContent = plugin.providers.localize(description);
					section.append(desc);
				}
				if (fields?.length) {
					section.append(this._renderFields(plugin, provider, fields));
				}
				if (fragment) {
					let markup = this._readURL(resolve(fragment));
					section.append(window.MozXULElement.parseXULToFragment(markup));
				}
				if (test) {
					section.append(this._renderTestButton(plugin, provider));
				}
				if (script) {
					Services.scriptloader.loadSubScript(resolve(script), window);
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
		this._renderUserScripts();
	},


	/**
	 * Read a file inside a plugin
	 *
	 * Installed plugins are packed, so their files have jar: URLs, which Zotero's HTTP helpers
	 * can't read -- a channel can, as well as chrome: and file: URLs.
	 */
	_readURL(url) {
		let { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
		let channel = NetUtil.newChannel({ uri: url, loadUsingSystemPrincipal: true });
		let stream = channel.open();
		try {
			return NetUtil.readInputStreamToString(stream, stream.available(), { charset: 'UTF-8' });
		}
		finally {
			stream.close();
		}
	},


	/**
	 * Form for a provider's declared fields, bound to its prefs
	 *
	 * @param {Object[]} fields - { pref, label, type, options, description, placeholder }, where
	 *     type is 'text' (default), 'password', 'number', 'checkbox' or 'menulist', and options
	 *     (for menulist) is [{ value, label }]
	 */
	_renderFields(plugin, provider, fields) {
		let localize = value => plugin.providers.localize(value);
		let fragment = document.createDocumentFragment();
		let grid = document.createXULElement('grid');
		grid.className = 'form-grid';
		let notes = [];
		for (let field of fields) {
			let prefName = plugin.providers.prefName(provider.id, field.pref);
			let id = `agentparser-${provider.id}-${field.pref}`.replace(/[^a-z0-9_-]/gi, '_');
			if (field.type == 'checkbox') {
				let checkbox = document.createXULElement('checkbox');
				checkbox.id = id;
				checkbox.setAttribute('native', 'true');
				checkbox.setAttribute('label', localize(field.label));
				checkbox.setAttribute('preference', prefName);
				notes.push(checkbox);
			}
			else {
				let label = document.createElementNS('http://www.w3.org/1999/xhtml', 'label');
				label.setAttribute('for', id);
				label.textContent = localize(field.label);
				let input;
				if (field.type == 'menulist') {
					input = document.createXULElement('menulist');
					input.setAttribute('native', 'true');
					let popup = document.createXULElement('menupopup');
					for (let option of field.options || []) {
						let item = document.createXULElement('menuitem');
						item.setAttribute('value', String(option.value));
						item.setAttribute('label', localize(option.label ?? String(option.value)));
						popup.append(item);
					}
					input.append(popup);
				}
				else {
					input = document.createElementNS('http://www.w3.org/1999/xhtml', 'input');
					input.type = ['password', 'number'].includes(field.type) ? field.type : 'text';
					input.style.flex = field.type == 'number' ? '' : '1';
					if (field.type == 'number') {
						input.style.width = '6em';
					}
					if (field.placeholder) {
						input.placeholder = localize(field.placeholder);
					}
				}
				input.id = id;
				input.setAttribute('preference', prefName);
				if (field.setupFocus) {
					input.setAttribute('data-setup-focus', 'true');
				}
				grid.append(label, input);
			}
			if (field.description) {
				let desc = document.createXULElement('description');
				desc.textContent = localize(field.description);
				notes.push(desc);
			}
		}
		fragment.append(grid, ...notes);
		return fragment;
	},


	_renderTestButton(plugin, provider) {
		let box = document.createXULElement('hbox');
		box.setAttribute('align', 'center');
		let button = document.createXULElement('button');
		document.l10n.setAttributes(button, 'agentparser-pref-test');
		let result = document.createXULElement('label');
		result.setAttribute('flex', '1');
		result.setAttribute('crop', 'end');
		button.addEventListener('command', async () => {
			result.value = '…';
			try {
				result.value = '✅ ' + await plugin.createBackend(provider.id).test();
			}
			catch (e) {
				result.value = '❌ ' + (e.message || e);
			}
			// Start files that were waiting for the service, or hold them if it's down
			plugin.refreshSetup(provider.id);
		});
		box.append(button, result);
		return box;
	},


	/**
	 * Scripts in the user's provider folder, and what they registered
	 */
	_renderUserScripts() {
		let plugin = this._plugin;
		let list = document.getElementById('agentparser-custom-list');
		let path = document.getElementById('agentparser-custom-dir');
		if (!plugin || !list) {
			return;
		}
		path.textContent = plugin.providers.getUserDir();
		let scripts = plugin.providers.userScripts;
		if (!scripts.length) {
			let empty = document.createXULElement('description');
			document.l10n.setAttributes(empty, 'agentparser-pref-custom-none');
			list.replaceChildren(empty);
			return;
		}
		list.replaceChildren(...scripts.map((script) => {
			let row = document.createXULElement('description');
			if (script.error) {
				document.l10n.setAttributes(row, 'agentparser-pref-custom-error', { file: script.file, error: script.error });
				row.style.color = 'var(--accent-red, #d70022)';
			}
			else {
				document.l10n.setAttributes(row, 'agentparser-pref-custom-loaded', { file: script.file, ids: script.ids.join(', ') });
			}
			return row;
		}));
	},


	async openUserDir() {
		let dir = this._plugin.providers.getUserDir();
		await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
		Zotero.File.reveal(dir);
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
			names[provider.id] = await plugin.getProviderName(provider.id);
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
		let textArgs = {};
		if (summary.setupIssue) {
			iconName = 'warning';
			textID = summary.setupIssue.id;
			textArgs = summary.setupIssue.args || {};
		}
		else {
			iconName = summary.autoParse ? 'done' : 'none';
			textID = summary.autoParse ? 'agentparser-pref-status-ok' : 'agentparser-pref-status-paused';
		}
		icon.src = `chrome://agentparser/content/icons/${iconName}.svg`;
		let args = JSON.stringify(textArgs);
		if (text.getAttribute('data-l10n-id') != textID || text.dataset.args != args) {
			text.dataset.args = args;
			document.l10n.setAttributes(text, textID, textArgs);
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
