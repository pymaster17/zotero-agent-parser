/* global Zotero, AgentParser, AgentParserProviders */

/**
 * Status UI: a toolbar button, a column in the item tree, and a section in the item pane
 */
var AgentParserUI = {
	ICONS: 'chrome://agentparser/content/icons/',
	CSS: 'chrome://agentparser/content/ui.css',
	MAX_MENU_ITEMS: 8,

	_columnKey: null,
	_sectionID: null,
	_sectionRefreshers: new Set(),
	_unlisten: null,
	_windows: new Map(),
	// Localized tooltips for item tree cells, which are rendered too often to localize each time
	_tooltips: {},
	// Localized provider names, for labels built synchronously
	_providerNames: {},


	get plugin() {
		return AgentParser;
	},


	/**
	 * Register the item tree column and the item pane section
	 */
	register() {
		let plugin = this.plugin;
		this._unlisten = plugin.onChange(() => this._onChange());
		this._loadTooltips();
		this._loadProviderNames();

		this._columnKey = Zotero.ItemTreeManager.registerColumn({
			pluginID: plugin.id,
			dataKey: 'agentparser-status',
			label: 'Agent Parser',
			iconPath: this.ICONS + 'section16.svg',
			width: '28',
			fixedWidth: true,
			staticWidth: true,
			noPadding: true,
			// Sort by importance: failures first
			dataProvider: (item) => {
				let state = plugin.getItemState(item);
				return state ? `${this._stateRank(state)}${state}` : '';
			},
			renderCell: (index, data, column, isFirstColumn, doc) => {
				let cell = doc.createElement('span');
				cell.className = `cell ${column.className} agentparser-cell`;
				let state = (data || '').replace(/^\d/, '');
				if (state) {
					let icon = doc.createElement('span');
					icon.className = 'agentparser-icon';
					icon.dataset.state = state;
					cell.append(icon);
					cell.title = this._tooltips[state] || '';
				}
				return cell;
			}
		});

		this._sectionID = Zotero.ItemPaneManager.registerSection({
			paneID: 'agentparser-status',
			pluginID: plugin.id,
			header: {
				l10nID: 'agentparser-section-header',
				icon: this.ICONS + 'section16.svg'
			},
			sidenav: {
				l10nID: 'agentparser-section-sidenav',
				icon: this.ICONS + 'section20.svg'
			},
			onInit: ({ body, refresh }) => {
				body._agentParserRefresh = refresh;
				this._sectionRefreshers.add(refresh);
			},
			onDestroy: ({ body }) => {
				this._sectionRefreshers.delete(body._agentParserRefresh);
			},
			onItemChange: ({ item, setEnabled }) => {
				setEnabled(!!item && this._getAttachments(item).length > 0);
			},
			onRender: ({ doc, body, item, setSectionSummary }) => {
				this._renderSection(doc, body, item, setSectionSummary);
			}
		});
	},


	unregister() {
		this._unlisten?.();
		this._unlisten = null;
		if (this._columnKey) {
			Zotero.ItemTreeManager.unregisterColumn(this._columnKey);
			this._columnKey = null;
		}
		if (this._sectionID) {
			Zotero.ItemPaneManager.unregisterSection(this._sectionID);
			this._sectionID = null;
		}
		this._sectionRefreshers.clear();
		for (let win of [...this._windows.keys()]) {
			this.removeFromWindow(win);
		}
	},


	async _loadTooltips() {
		let states = ['failed', 'setup', 'running', 'queued', 'done', 'none', 'limit'];
		let values = await Promise.all(states.map(x => this.plugin.getString('agentparser-state-' + x)));
		states.forEach((state, i) => {
			this._tooltips[state] = values[i];
		});
	},


	async _loadProviderNames() {
		for (let provider of AgentParserProviders.list()) {
			this._providerNames[provider.id] = await this.plugin.getString(provider.l10n.name);
		}
	},


	_providerName(id) {
		return this._providerNames[id] || id || '';
	},


	_stateRank(state) {
		return Math.max(0, ['failed', 'setup', 'running', 'queued', 'done', 'none'].indexOf(state));
	},


	_getAttachments(item) {
		let plugin = this.plugin;
		if (item.isRegularItem()) {
			return Zotero.Items.get(item.getAttachments()).filter(x => plugin.isParsable(x));
		}
		return plugin.isParsable(item) ? [item] : [];
	},


	_onChange() {
		for (let [win, elements] of this._windows) {
			if (win.closed) {
				continue;
			}
			this._updateButton(win, elements.button);
			// Redraw the visible rows of the item tree
			try {
				let itemsView = win.ZoteroPane?.itemsView;
				if (itemsView?.tree) {
					// Rows cache their cell values
					itemsView.invalidateRowCache?.(true);
					itemsView.tree.invalidate();
				}
			}
			catch (e) {}
		}
		for (let refresh of this._sectionRefreshers) {
			refresh().catch(() => {});
		}
	},


	/**
	 * Localized description of what a running or queued job is doing
	 *
	 * Running jobs are in one of the phases providers report (see AgentParserProviders.PHASES), or
	 * in a phase of the core's own: 'waiting-file' or 'saving'.
	 */
	_statusL10nID(state) {
		let { status } = state;
		if (state.state == 'setup') {
			return 'agentparser-status-setup';
		}
		if (state.state == 'queued') {
			return status == 'deferred' ? 'agentparser-status-deferred' : 'agentparser-status-queued';
		}
		switch (status) {
			case 'waiting-file':
			case 'preparing':
			case 'uploading':
			case 'pending':
			case 'parsing':
				return 'agentparser-status-' + status;
			case 'downloading':
			case 'saving':
				return 'agentparser-status-saving';
			default:
				return 'agentparser-status-parsing';
		}
	},


	/**
	 * @return {Element} - The job's phase, with progress such as "3/10" if the provider gave one
	 */
	_statusElement(doc, state) {
		let elem = doc.createElement('span');
		doc.l10n.setAttributes(elem, this._statusL10nID(state));
		if (state.progress) {
			let wrapper = doc.createElement('span');
			wrapper.append(elem, ' ' + state.progress);
			return wrapper;
		}
		return elem;
	},


	//
	// Item pane section
	//
	_renderSection(doc, body, item, setSectionSummary) {
		let plugin = this.plugin;
		body.replaceChildren();
		if (!item) {
			return;
		}
		let attachments = this._getAttachments(item);
		let container = doc.createElement('div');
		container.className = 'agentparser-section';
		let summaryState = null;

		for (let attachment of attachments) {
			let state = plugin.getAttachmentState(attachment);
			let shown = state.state == 'unknown' ? 'none' : state.state;
			if (summaryState === null || this._stateRank(shown) < this._stateRank(summaryState)) {
				summaryState = shown;
			}

			let row = doc.createElement('div');
			row.className = 'agentparser-row';
			row.dataset.state = shown;

			let head = doc.createElement('div');
			head.className = 'agentparser-row-head';
			let icon = doc.createElement('span');
			icon.className = 'agentparser-icon';
			icon.dataset.state = shown;
			let label = doc.createElement('span');
			label.className = 'agentparser-row-state';
			let limit = shown == 'failed' && state.kind == 'limit';
			doc.l10n.setAttributes(label, limit ? 'agentparser-state-limit' : 'agentparser-state-' + shown);
			head.append(icon, label);
			if (attachments.length > 1) {
				let file = doc.createElement('span');
				file.className = 'agentparser-row-file';
				file.textContent = attachment.getField('title') || attachment.attachmentFilename;
				file.title = file.textContent;
				head.append(file);
			}
			row.append(head);

			// What's going on, or what went wrong
			let message = doc.createElement('div');
			message.className = 'agentparser-row-message';
			if (shown == 'failed') {
				message.textContent = state.message || '';
				if (limit) {
					let hint = doc.createElement('div');
					let others = AgentParserProviders.list().filter(x => x.id != state.service);
					doc.l10n.setAttributes(hint, others.length ? 'agentparser-limit-desc' : 'agentparser-limit-desc-single');
					message.append(hint);
				}
			}
			else if (['running', 'queued', 'setup'].includes(shown)) {
				message.append(this._statusElement(doc, state), ' · ' + this._providerName(state.service));
			}
			else if (shown == 'none') {
				doc.l10n.setAttributes(message, plugin.getPref('autoParse')
					? 'agentparser-state-none-desc'
					: 'agentparser-state-none-desc-paused');
			}
			if (shown != 'done') {
				row.append(message);
			}

			// Actions
			let buttons = doc.createElement('div');
			buttons.className = 'agentparser-row-buttons';
			let button = (l10nID, onClick, args) => {
				let elem = doc.createElement('button');
				doc.l10n.setAttributes(elem, l10nID, args);
				elem.addEventListener('click', (event) => {
					event.stopPropagation();
					onClick();
				});
				buttons.append(elem);
				return elem;
			};
			if (shown == 'setup') {
				button('agentparser-action-open-settings', () => plugin.openPreferences());
			}
			else if (shown == 'failed') {
				let others = AgentParserProviders.list().filter(x => x.id != state.service);
				// The same service would reject a file outside its limits again
				if (!limit) {
					button('agentparser-action-retry', () => plugin.enqueue(attachment, { force: true }));
				}
				for (let other of others) {
					button(limit ? 'agentparser-action-parse-with' : 'agentparser-action-retry-with',
						() => plugin.enqueue(attachment, { force: true, provider: other.id }),
						{ provider: this._providerName(other.id) });
				}
			}
			else if (shown == 'none') {
				button('agentparser-action-parse', () => plugin.enqueue(attachment, {}));
			}
			else if (shown == 'done') {
				button('agentparser-action-open', async () => {
					let md = await plugin.getResultPath(attachment);
					if (md) {
						Zotero.launchFile(md);
					}
				});
				button('agentparser-action-reveal', async () => {
					let md = await plugin.getResultPath(attachment);
					if (md) {
						Zotero.File.reveal(md);
					}
				});
				button('agentparser-action-reparse', () => plugin.enqueue(attachment, { force: true }));
			}
			if (buttons.childElementCount) {
				row.append(buttons);
			}
			container.append(row);
		}
		body.append(container);

		if (summaryState) {
			doc.l10n.formatValue('agentparser-state-' + summaryState)
				.then(text => setSectionSummary(text || ''))
				.catch(() => {});
		}
	},


	//
	// Toolbar status light
	//
	// Only shows what's going on: green when there's nothing to do, yellow while files are being
	// parsed, red when something needs attention. Clicking it shows details.
	//
	addToWindow(win) {
		let doc = win.document;
		if (this._windows.has(win)) {
			return;
		}
		let elements = { button: null, panel: null, nodes: [] };

		let link = doc.createElement('link');
		link.rel = 'stylesheet';
		link.href = this.CSS;
		link.id = 'agentparser-ui-css';
		doc.documentElement.append(link);
		elements.nodes.push(link);

		let button = doc.createXULElement('toolbarbutton');
		button.id = 'agentparser-tb-status';
		button.className = 'zotero-tb-button';
		button.setAttribute('badged', 'true');
		button.setAttribute('tabindex', '-1');

		let panel = doc.createXULElement('panel');
		panel.id = 'agentparser-status-panel';
		panel.setAttribute('type', 'arrow');
		panel.setAttribute('animate', 'false');
		let content = doc.createElement('div');
		content.className = 'agentparser-panel';
		panel.append(content);
		panel.addEventListener('popupshowing', (event) => {
			if (event.target == panel) {
				this._renderPanel(win, content);
			}
		});
		button.addEventListener('command', () => {
			if (panel.state == 'open' || panel.state == 'showing') {
				panel.hidePopup();
			}
			else {
				panel.openPopup(button, 'bottomright topright', 0, 0, false, false);
			}
		});
		(doc.getElementById('mainPopupSet') || doc.documentElement).append(panel);
		elements.nodes.push(panel);

		// Next to the sync button, which also shows background activity
		let anchor = doc.getElementById('zotero-tb-sync-error') || doc.getElementById('zotero-tb-sync');
		if (anchor) {
			anchor.before(button);
		}
		else {
			let toolbar = doc.getElementById('zotero-items-toolbar');
			if (!toolbar) {
				link.remove();
				panel.remove();
				return;
			}
			toolbar.append(button);
		}
		elements.button = button;
		elements.panel = panel;
		elements.content = content;
		elements.nodes.push(button);
		this._windows.set(win, elements);
		this._updateButton(win, button);
		this._showColumnOnce(win);
	},


	removeFromWindow(win) {
		let elements = this._windows.get(win);
		if (!elements) {
			return;
		}
		for (let node of elements.nodes) {
			node.remove();
		}
		this._windows.delete(win);
	},


	/**
	 * Zotero hides columns added by plugins until the user picks them, so show the status column
	 * the first time. After that, it stays however the user leaves it.
	 */
	async _showColumnOnce(win) {
		let plugin = this.plugin;
		if (plugin.getPref('columnShown')) {
			return;
		}
		for (let i = 0; i < 60; i++) {
			if (win.closed || !this._columnKey) {
				return;
			}
			let columns = win.ZoteroPane?.itemsView?.tree?._columns;
			let list = columns?._columns;
			if (list) {
				let index = list.findIndex(x => x.dataKey == this._columnKey);
				if (index != -1) {
					try {
						if (list[index].hidden) {
							columns.toggleHidden(index);
						}
						plugin.setPref('columnShown', true);
					}
					catch (e) {
						Zotero.logError(e);
					}
					return;
				}
			}
			await Zotero.Promise.delay(1000);
		}
	},


	/**
	 * @return {String} - 'ok', 'busy', or 'error'
	 */
	_getLight(summary) {
		let active = summary.running.length || summary.queued > summary.blocked;
		if (active) {
			return 'busy';
		}
		if (summary.failed || summary.setupIssue) {
			return 'error';
		}
		return 'ok';
	},


	_updateButton(win, button) {
		if (!button) {
			return;
		}
		let summary = this.plugin.getSummary();
		let light = this._getLight(summary);
		let active = summary.running.length + summary.queued - summary.blocked;
		button.setAttribute('state', light);
		let count = n => (n > 99 ? '99+' : String(n));
		if (summary.failed) {
			button.setAttribute('badge', count(summary.failed));
			button.setAttribute('badgekind', 'failed');
		}
		else if (light == 'busy' && active > 0) {
			button.setAttribute('badge', count(active));
			button.setAttribute('badgekind', 'active');
		}
		else {
			button.removeAttribute('badge');
			button.removeAttribute('badgekind');
		}
		let args = {
			running: summary.running.length,
			queued: summary.queued,
			failed: summary.failed
		};
		if (light == 'error' && summary.setupIssue && !summary.failed) {
			// The provider describes what's missing
			this.plugin.getString(summary.setupIssue.id)
				.then(issue => win.document.l10n.setAttributes(button, 'agentparser-light-setup-button', { issue }))
				.catch(() => {});
		}
		else {
			let tooltip = {
				busy: 'agentparser-light-busy-button',
				error: 'agentparser-light-error-button',
				ok: summary.autoParse ? 'agentparser-light-ok-button' : 'agentparser-light-ok-paused-button'
			}[light];
			win.document.l10n.setAttributes(button, tooltip, args);
		}
		let elements = this._windows.get(win);
		if (elements?.panel?.state == 'open') {
			this._renderPanel(win, elements.content);
		}
	},


	/**
	 * Fill the status panel: per-service queue, files being parsed, and failures
	 */
	_renderPanel(win, content) {
		let doc = win.document;
		let plugin = this.plugin;
		let summary = plugin.getSummary();
		let light = this._getLight(summary);
		let details = plugin.getServiceDetails();
		let failures = plugin.getFailures();

		let el = (tag, className, l10nID, args) => {
			let elem = doc.createElement(tag);
			if (className) {
				elem.className = className;
			}
			if (l10nID) {
				doc.l10n.setAttributes(elem, l10nID, args);
			}
			return elem;
		};
		let icon = (state) => {
			let elem = el('span', 'agentparser-icon');
			elem.dataset.state = state;
			return elem;
		};
		let titleOf = (key, fallback) => {
			let { libraryID, key: itemKey } = Zotero.Items.parseLibraryKey(key);
			let attachment = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
			if (!attachment) {
				return [null, fallback || key];
			}
			let title = attachment.parentItem ? attachment.parentItem.getDisplayTitle() : attachment.getDisplayTitle();
			return [attachment, title];
		};
		// Clicking a file shows it in the item list
		// detailL10n: an element describing what's going on, or detailText: plain text
		let fileRow = (key, fallbackTitle, state, detailL10n, detailText) => {
			let [attachment, title] = titleOf(key, fallbackTitle);
			let row = el('div', 'agentparser-panel-file');
			row.append(icon(state));
			let text = el('div', 'agentparser-panel-file-text');
			let name = el('div', 'agentparser-panel-file-title');
			name.textContent = title;
			let detail = el('div', 'agentparser-panel-file-detail');
			if (detailL10n) {
				detail.append(detailL10n);
			}
			if (detailText) {
				detail.textContent = detailText;
				detail.title = detailText;
			}
			text.append(name, detail);
			row.append(text);
			if (attachment) {
				row.classList.add('agentparser-clickable');
				row.addEventListener('click', () => {
					win.ZoteroPane.selectItem(attachment.id);
					content.closest('panel')?.hidePopup();
				});
			}
			return row;
		};

		let nodes = [];

		// Headline
		let head = el('div', 'agentparser-panel-head');
		head.dataset.light = light;
		let dot = el('span', 'agentparser-light');
		dot.dataset.light = light;
		head.append(dot, el('span', 'agentparser-panel-headline', 'agentparser-panel-' + light));
		nodes.push(head);

		// Setup needed
		if (summary.setupIssue) {
			let box = el('div', 'agentparser-panel-notice');
			box.append(icon('setup'), el('span', null, summary.setupIssue.id));
			if (!summary.setupIssue.installing) {
				let open = el('a', 'agentparser-panel-link', 'agentparser-panel-open-settings');
				open.addEventListener('click', () => {
					content.closest('panel')?.hidePopup();
					plugin.openPreferences();
				});
				box.append(open);
			}
			nodes.push(box);
		}

		// Each service's queue
		let order = AgentParserProviders.list().map(x => x.id);
		let rank = id => (order.includes(id) ? order.indexOf(id) : order.length);
		let services = Object.keys(details).sort((a, b) => rank(a) - rank(b));
		for (let name of services) {
			let service = details[name];
			let section = el('div', 'agentparser-panel-section');
			let title = el('div', 'agentparser-panel-section-title');
			title.append(
				Object.assign(el('span'), { textContent: this._providerName(name) }),
				el('span', 'agentparser-panel-counts', 'agentparser-panel-counts', {
					running: service.running.length,
					queued: service.queued,
					deferred: service.deferred,
					blocked: service.blocked
				})
			);
			section.append(title);
			for (let job of service.running.slice(0, this.MAX_MENU_ITEMS)) {
				section.append(fileRow(job.key, job.title, 'running',
					this._statusElement(doc, { state: 'running', status: job.status, progress: job.progress })));
			}
			if (service.running.length > this.MAX_MENU_ITEMS) {
				section.append(el('div', 'agentparser-panel-more', 'agentparser-menu-more',
					{ count: service.running.length - this.MAX_MENU_ITEMS }));
			}
			nodes.push(section);
		}

		// Failures
		if (failures.length) {
			let section = el('div', 'agentparser-panel-section');
			let title = el('div', 'agentparser-panel-section-title');
			title.append(el('span', null, 'agentparser-menu-failures', { count: failures.length }));
			section.append(title);
			for (let failure of failures.slice(0, this.MAX_MENU_ITEMS)) {
				let row = fileRow(failure.key, failure.title, 'failed', null,
					failure.kind == 'limit' ? `${this._tooltips.limit || ''}: ${failure.message}` : failure.message);
				section.append(row);
			}
			if (failures.length > this.MAX_MENU_ITEMS) {
				section.append(el('div', 'agentparser-panel-more', 'agentparser-menu-more',
					{ count: failures.length - this.MAX_MENU_ITEMS }));
			}
			section.append(el('div', 'agentparser-panel-hint', 'agentparser-panel-failure-hint'));
			nodes.push(section);
		}

		// Nothing going on
		if (!services.length && !failures.length && !summary.setupIssue) {
			nodes.push(el('div', 'agentparser-panel-hint',
				summary.autoParse ? 'agentparser-light-ok' : 'agentparser-light-ok-paused'));
		}

		content.replaceChildren(...nodes);
	}
};
