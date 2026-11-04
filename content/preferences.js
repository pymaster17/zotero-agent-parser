/* global Zotero, window, document */

window.AgentParserPrefs = {
	_timer: null,

	init() {
		this.updateSections();
		this.updateQueueStatus();
		this._timer = window.setInterval(() => {
			this.updateQueueStatus().catch(() => window.clearInterval(this._timer));
		}, 2000);
		window.addEventListener('unload', () => window.clearInterval(this._timer), { once: true });
	},


	updateSections() {
		let backend = document.getElementById('agentparser-backend').value
			|| Zotero.Prefs.get('extensions.agentparser.backend', true);
		for (let section of document.querySelectorAll('.agentparser-section')) {
			section.hidden = section.id != 'agentparser-section-' + backend;
		}
		document.getElementById('agentparser-test-result').value = '';
	},


	async test() {
		let plugin = Zotero.AgentParser;
		let resultLabel = document.getElementById('agentparser-test-result');
		let button = document.getElementById('agentparser-test');
		if (!plugin) {
			return;
		}
		button.disabled = true;
		resultLabel.value = '…';
		try {
			let backend = plugin.getPref('backend');
			let instance = Zotero.AgentParser.createBackend(backend);
			let result = await instance.test();
			resultLabel.value = '✅ ' + result;
		}
		catch (e) {
			resultLabel.value = '❌ ' + (e.message || e);
		}
		finally {
			button.disabled = false;
		}
	},


	async updateQueueStatus() {
		let plugin = Zotero.AgentParser;
		let label = document.getElementById('agentparser-queue-status');
		if (!plugin || !label) {
			return;
		}
		let { queued, running } = plugin.getStatus();
		label.value = await plugin.getString('agentparser-pref-queue-status', {
			queued,
			running: running.length,
			details: running.length
				? ' \u2014 ' + running.slice(0, 3).map(x => `${x.key} (${x.status})`).join(', ')
					+ (running.length > 3 ? ', \u2026' : '')
				: ''
		});
	},


	clearQueue() {
		Zotero.AgentParser?.clearQueue();
		this.updateQueueStatus();
	}
};
