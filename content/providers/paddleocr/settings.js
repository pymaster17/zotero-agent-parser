/* global window, document */

/**
 * Settings section for PaddleOCR
 */
window.AgentParserProviderSettings = window.AgentParserProviderSettings || {};

window.AgentParserProviderSettings['paddleocr'] = {
	_ctx: null,


	init(ctx) {
		this._ctx = ctx;
		document.getElementById('agentparser-paddleocr-token')
			.addEventListener('input', () => window.setTimeout(() => this.update()));
		this.update();
	},


	/**
	 * Point out a missing token while this service is used
	 */
	update() {
		let { plugin, provider } = this._ctx;
		let warning = document.getElementById('agentparser-paddleocr-warning');
		let used = plugin.getDefaultProvider() == provider.id || plugin.getBulkProvider() == provider.id;
		let missing = used && !!plugin.getProviderSetupIssue(provider.id);
		warning.hidden = !missing;
		if (missing) {
			document.l10n.setAttributes(warning, plugin.providers.list().length > 1
				? 'agentparser-paddleocr-warn-no-token'
				: 'agentparser-paddleocr-warn-no-token-single');
		}
	},


	async test() {
		let { plugin, provider } = this._ctx;
		let resultLabel = document.getElementById('agentparser-paddleocr-test-result');
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
