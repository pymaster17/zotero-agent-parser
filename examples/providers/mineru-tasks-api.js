/* global Zotero, AgentParserHTTP, AgentParserOutput, AgentParserProviders */

/**
 * Example provider: a MinerU service you run yourself
 *
 * Talks to MinerU's Tasks API (POST /v1/tasks), as served by `mineru-kit api-server` from
 * MinerU 4 or later, on this computer or another one on your network. The plugin doesn't install
 * or start anything: deploy and run MinerU however suits your machine, e.g.
 *
 *     mineru-kit api-server --host 127.0.0.1 --port 8000 --tier standard --concurrency 1 \
 *         --disable-image-analysis --preload-models
 *
 * To use it, copy this file into <Zotero data directory>/agent-parser/providers/ and restart
 * Zotero (Settings → Agent Parser → Custom Parsing Services → Open Folder). Change anything you
 * like -- see docs/custom-providers.md for the provider interface.
 *
 * While the service can't be reached, files for it wait in the queue instead of failing, and the
 * service is checked every 30 seconds while it's in use, so parsing resumes once it's back.
 */
(function () {
	// Also the prefix of the prefs (extensions.agentparser.providers.mineru-local.*). Earlier
	// versions had a built-in provider with this ID, so its settings and queued files carry over.
	const ID = 'mineru-local';
	const CHECK_INTERVAL = 30 * 1000;
	const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'canceled']);
	// File states -> progress phases (see AgentParserProviders.PHASES)
	const PHASES = {
		'waiting-file': 'pending',
		queued: 'pending',
		pending: 'pending',
		uploading: 'uploading',
		completed: 'downloading'
	};


	class Backend {
		constructor(getPref) {
			this.baseURL = AgentParserProviders.trimURL(getPref('url'));
			this.apiKey = (getPref('apiKey') || '').trim();
			this.tier = getPref('tier') || '';
			this.ocrMode = getPref('ocrMode') || 'auto';
		}

		_authHeaders(url) {
			if (!this.apiKey || (url && !AgentParserHTTP.isSameOrigin(this.baseURL, url))) {
				return {};
			}
			return { Authorization: 'Bearer ' + this.apiKey };
		}

		_resolve(url) {
			return new URL(url, this.baseURL + '/').href;
		}

		async test() {
			let json = await AgentParserHTTP.json('GET', this.baseURL + '/v1/health', {
				headers: this._authHeaders(),
				timeout: 15000
			});
			health.set('ok');
			return json.version ? `MinerU ${json.version}` : JSON.stringify(json).substr(0, 200);
		}

		async parse(job) {
			let payload = {
				files: [{ file_name: job.uploadName, bytes: job.fileSize, sha256sum: job.sha256 }],
				output_formats: ['default']
			};
			if (this.tier) {
				payload.tier = this.tier;
			}
			if (this.ocrMode) {
				payload.ocr_mode = this.ocrMode;
			}

			job.onStatus('preparing');
			let task = await AgentParserHTTP.json('POST', this.baseURL + '/v1/tasks', {
				headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			this._checkTask(task);
			Zotero.debug(`Agent Parser: Created MinerU task ${task.task_id}`);

			let uploaded = false;
			let first = true;
			task = await AgentParserProviders.poll(job, async () => {
				if (!first) {
					task = await AgentParserHTTP.json('GET', this.baseURL + '/v1/tasks/' + encodeURIComponent(task.task_id), {
						headers: this._authHeaders()
					});
					this._checkTask(task);
					job.onStatus(PHASES[task.files[0].status || task.status] || 'parsing');
				}
				first = false;
				let file = task.files[0];
				// The server skips the upload if it already has a file with the same hash
				if (!uploaded && file.status == 'waiting-file' && file.upload && file.upload.url) {
					await this._upload(job, file.upload);
					uploaded = true;
				}
				return TERMINAL_STATUSES.has(task.status) ? task : undefined;
			});

			let file = task.files[0];
			if (task.status == 'failed' || task.status == 'canceled' || file.status != 'completed') {
				let err = task.error || file.error || {};
				throw new Error(`MinerU task ${task.status}: ${err.message || err.code || file.status}`);
			}
			if (!file.result_url) {
				throw new Error("MinerU task completed without result_url");
			}

			// A ZIP with the Markdown and images/ -- the plugin keeps only what full.md needs
			job.onStatus('downloading');
			let resultURL = this._resolve(file.result_url);
			let zipPath = PathUtils.join(job.tempDir, 'result.zip');
			await AgentParserHTTP.download(resultURL, zipPath, { headers: this._authHeaders(resultURL) });
			await AgentParserOutput.extractZip(zipPath, job.stagingDir);

			// Describes the parser in full.md (see frontMatter() below)
			return {
				service: ID,
				url: this.baseURL,
				taskID: task.task_id,
				tier: task.tier || this.tier || null,
				ocrMode: this.ocrMode
			};
		}

		async _upload(job, upload) {
			job.onStatus('uploading');
			let url = this._resolve(upload.url);
			let headers = {};
			for (let [key, value] of Object.entries(upload.headers || {})) {
				// Set by fetch() itself
				if (!['content-length', 'transfer-encoding', 'host'].includes(key.toLowerCase())) {
					headers[key] = value;
				}
			}
			Object.assign(headers, this._authHeaders(url));
			await AgentParserHTTP.upload(url, () => AgentParserProviders.readFile(job.filePath), {
				headers,
				checkCancelled: () => job.checkCancelled()
			});
		}

		_checkTask(task) {
			if (!task || typeof task.task_id != 'string' || !Array.isArray(task.files) || task.files.length != 1) {
				throw new Error("Unexpected response from MinerU Tasks API: " + JSON.stringify(task).substr(0, 300));
			}
		}
	}


	/**
	 * Whether the service can be reached: null (not checked yet), 'ok', 'down', or 'auth'
	 */
	let health = {
		state: null,
		ctx: null,
		timer: null,

		set(state) {
			this.state = state;
			if (state == 'ok' || !this.ctx) {
				clearInterval(this.timer);
				this.timer = null;
			}
			else if (!this.timer) {
				this.timer = setInterval(() => this.recheck(), CHECK_INTERVAL);
			}
		},

		async check() {
			if (!this.ctx) {
				return;
			}
			let backend;
			try {
				backend = new Backend(this.ctx.getPref);
			}
			catch (e) {
				// No URL -- reported by getSetupIssue()
				this.set(null);
				return;
			}
			try {
				let response = await AgentParserHTTP.request('GET', backend.baseURL + '/v1/health', {
					headers: backend._authHeaders(),
					timeout: 5000,
					allowErrorStatus: true,
					quiet: true
				});
				this.set(response.status == 401 || response.status == 403 ? 'auth' : (response.ok ? 'ok' : 'down'));
			}
			catch (e) {
				this.set('down');
			}
		},

		// While the service is down, check again, but only while something is waiting for it
		async recheck() {
			let ctx = this.ctx;
			if (!ctx) {
				return;
			}
			let { plugin } = ctx;
			let details = plugin.getServiceDetails()[ID];
			let inUse = plugin.getDefaultProvider() == ID || plugin.getBulkProvider() == ID
				|| (details && details.queued + details.blocked + details.running.length > 0);
			if (!inUse) {
				return;
			}
			await this.check();
			if (this.state == 'ok') {
				plugin.refreshSetup(ID);
			}
		}
	};


	AgentParserProviders.register({
		apiVersion: 1,
		id: ID,
		name: { 'zh-CN': '本地 MinerU', 'en-US': 'Local MinerU' },
		defaultPrefs: {
			url: 'http://127.0.0.1:8000',
			apiKey: '',
			tier: 'standard',
			ocrMode: 'auto',
			// Inference on one GPU or Apple Silicon is serialized, so more tasks at once just
			// compete for memory
			concurrency: 1
		},
		// Settings from before providers existed
		legacy: {
			ids: ['local'],
			prefs: { 'local.url': 'url', 'local.apiKey': 'apiKey', 'local.tier': 'tier', 'local.ocrMode': 'ocrMode' }
		},
		settings: {
			description: {
				'zh-CN': '连接自己运行的 mineru-kit api-server（MinerU ≥ 4），本机或局域网内的其他电脑均可。',
				'en-US': 'Connects to a mineru-kit api-server (MinerU 4 or later) that you run, on this computer or another one on your network.'
			},
			fields: [
				{ pref: 'url', label: { 'zh-CN': '服务地址：', 'en-US': 'URL:' }, setupFocus: true },
				{ pref: 'apiKey', label: { 'zh-CN': 'API Key：', 'en-US': 'API key:' }, type: 'password' },
				{
					pref: 'tier', label: { 'zh-CN': '解析档位：', 'en-US': 'Tier:' }, type: 'menulist',
					options: [{ value: 'basic' }, { value: 'standard' }, { value: 'advanced' }]
				},
				{
					pref: 'ocrMode', label: { 'zh-CN': 'OCR 模式：', 'en-US': 'OCR mode:' }, type: 'menulist',
					options: [{ value: 'auto' }, { value: 'txt' }, { value: 'ocr' }]
				},
				{ pref: 'concurrency', label: { 'zh-CN': '并发任务数：', 'en-US': 'Concurrent jobs:' }, type: 'number' }
			],
			test: true
		},


		init(ctx) {
			health.ctx = ctx;
		},


		shutdown() {
			health.ctx = null;
			health.set(null);
		},


		getConcurrency(ctx) {
			return Math.max(1, parseInt(ctx.getPref('concurrency')) || 1);
		},


		getSetupIssue(ctx) {
			if (!(ctx.getPref('url') || '').trim()) {
				return { message: { 'zh-CN': '未填写本地 MinerU 的服务地址', 'en-US': 'no URL for local MinerU' } };
			}
			if (health.state == 'down') {
				return { message: { 'zh-CN': '本地 MinerU 服务未运行，启动后自动继续', 'en-US': 'local MinerU isn’t running -- parsing continues once it is' } };
			}
			if (health.state == 'auth') {
				return { message: { 'zh-CN': '本地 MinerU 服务拒绝了 API Key', 'en-US': 'local MinerU rejected the API key' } };
			}
			// Not checked yet counts as ready, so that jobs aren't held up
			return null;
		},


		async refreshSetup() {
			await health.check();
		},


		classifyError(e) {
			// Couldn't connect: the service isn't running. Keep the file queued until it is.
			if (e && e.isNetworkError) {
				health.set('down');
				return 'unavailable';
			}
			if (e && (e.status == 401 || e.status == 403)) {
				health.set('auth');
				return 'unavailable';
			}
			return 'error';
		},


		describe(parserInfo) {
			return parserInfo.tier || 'default';
		},


		frontMatter(parserInfo) {
			return { tier: parserInfo.tier };
		},


		create(ctx) {
			return new Backend(ctx.getPref);
		}
	});
})();
