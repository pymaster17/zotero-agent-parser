/* global window, document */

/**
 * Settings section for MinerU cloud
 */
window.AgentParserProviderSettings = window.AgentParserProviderSettings || {};

window.AgentParserProviderSettings['mineru-cloud'] = {
	_ctx: null,


	init(ctx) {
		this._ctx = ctx;
		document.getElementById('agentparser-cloudv4-token')
			.addEventListener('input', () => window.setTimeout(() => this.update()));
		this.update();
	},


	/**
	 * Point out a missing token while this service is used
	 */
	update() {
		let { plugin, provider } = this._ctx;
		let warning = document.getElementById('agentparser-mineru-cloud-warning');
		let used = plugin.getDefaultProvider() == provider.id || plugin.getBulkProvider() == provider.id;
		let missing = used && !!plugin.getProviderSetupIssue(provider.id);
		warning.hidden = !missing;
		if (missing) {
			document.l10n.setAttributes(warning, plugin.providers.list().length > 1
				? 'agentparser-mineru-cloud-warn-no-token'
				: 'agentparser-mineru-cloud-warn-no-token-single');
		}
	},


	async test() {
		let { plugin, provider } = this._ctx;
		let resultLabel = document.getElementById('agentparser-mineru-cloud-test-result');
		resultLabel.value = '…';
		try {
			let result = await plugin.createBackend(provider.id).test();
			resultLabel.value = '✅ ' + result;
		}
		catch (e) {
			resultLabel.value = '❌ ' + (e.message || e);
		}
	}
};
