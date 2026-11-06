/* global Zotero, AgentParser */

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
		let states = ['failed', 'setup', 'running', 'queued', 'done', 'none'];
		let values = await Promise.all(states.map(x => this.plugin.getString('agentparser-state-' + x)));
		states.forEach((state, i) => {
			this._tooltips[state] = values[i];
		});
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
			this._buildMenu(win, elements.popup).catch(e => Zotero.logError(e));
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
				return 'agentparser-status-waiting-file';
			case 'starting':
			case 'counting pages':
			case 'hashing':
			case 'checking-url':
				return 'agentparser-status-preparing';
			case 'queued':
			case 'pending':
			case 'waiting-upload':
			case 'waiting-file-upload':
				return 'agentparser-status-pending';
			case 'submitting':
			case 'submitting-url':
			case 'uploading':
				return 'agentparser-status-uploading';
			case 'downloading':
			case 'saving':
			case 'done':
				return 'agentparser-status-saving';
			default:
				return 'agentparser-status-parsing';
		}
	},


	_serviceL10nID(service) {
		return service == 'local' ? 'agentparser-service-local' : 'agentparser-service-cloud';
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
					doc.l10n.setAttributes(hint, plugin.local && state.service != 'local'
						? 'agentparser-limit-desc'
						: 'agentparser-limit-desc-lite');
					message.append(hint);
				}
			}
			else if (['running', 'queued', 'setup'].includes(shown)) {
				let status = doc.createElement('span');
				doc.l10n.setAttributes(status, this._statusL10nID(state));
				let service = doc.createElement('span');
				doc.l10n.setAttributes(service, this._serviceL10nID(state.service));
				message.append(status, ' · ', service);
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
			let button = (l10nID, onClick) => {
				let elem = doc.createElement('button');
				doc.l10n.setAttributes(elem, l10nID);
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
			else if (limit) {
				// The same service would reject it again
				if (plugin.local && state.service != 'local') {
					button('agentparser-action-parse-local', () => plugin.enqueue(attachment, { force: true, backend: 'local' }));
				}
				else if (state.service == 'local') {
					button('agentparser-action-retry', () => plugin.enqueue(attachment, { force: true }));
				}
			}
			else if (shown == 'failed') {
				button('agentparser-action-retry', () => plugin.enqueue(attachment, { force: true }));
				if (plugin.local) {
					let other = state.service == 'local' ? 'cloudV4' : 'local';
					button(other == 'local' ? 'agentparser-action-retry-local' : 'agentparser-action-retry-cloud',
						() => plugin.enqueue(attachment, { force: true, backend: other }));
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
	// Toolbar button
	//
	addToWindow(win) {
		let doc = win.document;
		if (this._windows.has(win)) {
			return;
		}
		let elements = { button: null, nodes: [] };

		let link = doc.createElement('link');
		link.rel = 'stylesheet';
		link.href = this.CSS;
		link.id = 'agentparser-ui-css';
		doc.documentElement.append(link);
		elements.nodes.push(link);

		let button = doc.createXULElement('toolbarbutton');
		button.id = 'agentparser-tb-status';
		button.className = 'zotero-tb-button';
		button.setAttribute('type', 'menu');
		button.setAttribute('badged', 'true');
		button.setAttribute('tabindex', '-1');
		let popup = doc.createXULElement('menupopup');
		popup.id = 'agentparser-tb-status-popup';
		// The menu is kept up to date as the status changes, so that it's ready when opened
		popup.addEventListener('popupshowing', (event) => {
			if (event.target == popup) {
				this._buildMenu(win, popup).catch(e => Zotero.logError(e));
			}
		});
		button.append(popup);
		elements.popup = popup;

		// Next to the sync button, which also shows background activity
		let anchor = doc.getElementById('zotero-tb-sync-error') || doc.getElementById('zotero-tb-sync');
		if (anchor) {
			anchor.before(button);
		}
		else {
			let toolbar = doc.getElementById('zotero-items-toolbar');
			if (!toolbar) {
				link.remove();
				return;
			}
			toolbar.append(button);
		}
		elements.button = button;
		elements.nodes.push(button);
		this._windows.set(win, elements);
		this._updateButton(win, button);
		this._buildMenu(win, popup).catch(e => Zotero.logError(e));
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


	_updateButton(win, button) {
		if (!button) {
			return;
		}
		let summary = this.plugin.getSummary();
		let active = summary.running.length + summary.queued;
		button.setAttribute('state', summary.state);
		if (summary.failed) {
			button.setAttribute('badge', summary.failed > 99 ? '99+' : String(summary.failed));
			button.setAttribute('badgekind', 'failed');
		}
		else if (summary.state == 'running' && active > 1) {
			button.setAttribute('badge', active > 99 ? '99+' : String(active));
			button.setAttribute('badgekind', 'active');
		}
		else {
			button.removeAttribute('badge');
			button.removeAttribute('badgekind');
		}
		let [id, args] = this._summaryL10n(summary);
		win.document.l10n.setAttributes(button, id + '-button', args);
	},


	/**
	 * @return {Array} - [l10n ID, args] describing the overall status in a sentence
	 */
	_summaryL10n(summary) {
		let args = {
			running: summary.running.length,
			queued: summary.queued,
			failed: summary.failed
		};
		switch (summary.state) {
			case 'setup':
				return [summary.setupIssue.id, args];
			case 'running':
				return ['agentparser-summary-running', args];
			case 'queued':
				return ['agentparser-summary-deferred', args];
			case 'failed':
				return ['agentparser-summary-failed', args];
			case 'paused':
				return ['agentparser-summary-paused', args];
			default:
				return ['agentparser-summary-idle', args];
		}
	},


	/**
	 * Fill the status menu
	 *
	 * Strings are resolved before the menu is touched, so that it never shows half-built.
	 */
	async _buildMenu(win, popup) {
		let doc = win.document;
		let plugin = this.plugin;
		let generation = (popup._agentParserGeneration || 0) + 1;
		popup._agentParserGeneration = generation;
		let summary = plugin.getSummary();
		let failures = plugin.getFailures();
		let getString = (id, args) => plugin.getString(id, args);

		// [label, { onCommand, icon, disabled, header, checked, tooltip }] or 'separator'
		let entries = [];
		let titleOf = (key, fallback) => {
			let { libraryID, key: itemKey } = Zotero.Items.parseLibraryKey(key);
			let attachment = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
			if (!attachment) {
				return [null, fallback || key];
			}
			let title = attachment.parentItem ? attachment.parentItem.getDisplayTitle() : attachment.getDisplayTitle();
			return [attachment, title];
		};
		let select = attachment => attachment && win.ZoteroPane.selectItem(attachment.id);

		// Overall status
		let [summaryID, summaryArgs] = this._summaryL10n(summary);
		entries.push([await getString(summaryID, summaryArgs), {
			icon: { setup: 'warning', running: 'running', failed: 'failed', done: 'done', queued: 'queued' }[summary.state],
			disabled: true,
			header: true
		}]);
		if (summary.setupIssue) {
			entries.push([await getString('agentparser-menu-finish-setup'), { onCommand: () => plugin.openPreferences() }]);
		}

		// Files being parsed
		if (summary.running.length) {
			entries.push('separator');
			for (let job of summary.running.slice(0, this.MAX_MENU_ITEMS)) {
				let [attachment, title] = titleOf(job.key, job.title);
				let status = await getString(this._statusL10nID({ state: 'running', status: job.status }));
				let service = await getString(this._serviceL10nID(job.service));
				entries.push([`${title} — ${status} · ${service}`, { icon: 'running', onCommand: () => select(attachment) }]);
			}
			if (summary.running.length > this.MAX_MENU_ITEMS) {
				entries.push([await getString('agentparser-menu-more', { count: summary.running.length - this.MAX_MENU_ITEMS }), { disabled: true }]);
			}
		}
		if (summary.queued) {
			if (!summary.running.length) {
				entries.push('separator');
			}
			entries.push([await getString('agentparser-menu-queued', {
				count: summary.queued,
				deferred: summary.deferred,
				blocked: summary.blocked
			}), { icon: summary.blocked ? 'warning' : 'queued', disabled: true }]);
		}

		// Failures
		if (failures.length) {
			entries.push('separator');
			entries.push([await getString('agentparser-menu-failures', { count: failures.length }), { disabled: true, header: true }]);
			for (let failure of failures.slice(0, this.MAX_MENU_ITEMS)) {
				let [attachment, title] = titleOf(failure.key, failure.title);
				let prefix = failure.kind == 'limit' ? (await getString('agentparser-state-limit')) + ': ' : '';
				entries.push([`${title} — ${prefix}${failure.message}`, {
					icon: 'failed',
					tooltip: failure.message,
					onCommand: () => select(attachment)
				}]);
			}
			if (failures.length > this.MAX_MENU_ITEMS) {
				entries.push([await getString('agentparser-menu-more', { count: failures.length - this.MAX_MENU_ITEMS }), { disabled: true }]);
			}
			let limited = failures.filter(x => x.kind == 'limit').length;
			if (limited) {
				entries.push([await getString(plugin.local ? 'agentparser-menu-limit-hint' : 'agentparser-menu-limit-hint-lite', { count: limited }), {
					icon: 'warning',
					disabled: true
				}]);
			}
			entries.push([await getString('agentparser-menu-retry-failed'), {
				onCommand: async () => {
					let count = await plugin.retryFailed();
					await plugin._showQueued(count);
				}
			}]);
			entries.push([await getString('agentparser-menu-clear-failures'), { onCommand: () => plugin.clearFailures() }]);
		}

		// Controls
		entries.push('separator');
		entries.push([await getString('agentparser-menu-auto-parse'), {
			checked: summary.autoParse,
			onCommand: () => plugin.setPref('autoParse', !plugin.getPref('autoParse'))
		}]);
		entries.push([await getString('agentparser-menu-parse-library-short'), { onCommand: () => plugin.parseLibrary(win) }]);
		if (summary.queued) {
			entries.push([await getString('agentparser-menu-clear-queue'), { onCommand: () => plugin.clearQueue() }]);
		}
		entries.push([await getString('agentparser-menu-settings'), { onCommand: () => plugin.openPreferences() }]);

		// A newer build started in the meantime
		if (popup._agentParserGeneration != generation || win.closed) {
			return;
		}
		let nodes = entries.map((entry) => {
			if (entry == 'separator') {
				return doc.createXULElement('menuseparator');
			}
			let [label, { onCommand, icon, disabled, header, checked, tooltip } = {}] = entry;
			let menuitem = doc.createXULElement('menuitem');
			menuitem.setAttribute('label', label);
			if (icon) {
				menuitem.classList.add('menuitem-iconic');
				menuitem.setAttribute('image', this.ICONS + icon + '.svg');
			}
			if (header) {
				menuitem.classList.add('agentparser-menu-header');
			}
			if (disabled) {
				menuitem.setAttribute('disabled', 'true');
			}
			if (checked !== undefined) {
				menuitem.setAttribute('type', 'checkbox');
				menuitem.setAttribute('checked', checked ? 'true' : 'false');
			}
			if (tooltip) {
				menuitem.setAttribute('tooltiptext', tooltip);
			}
			if (onCommand) {
				menuitem.addEventListener('command', onCommand);
			}
			return menuitem;
		});
		popup.replaceChildren(...nodes);
	}
};
