/* global Zotero, AgentParserHTTP, AgentParserOutput, AgentParserProviders */

/**
 * Example provider: any model behind a minimal HTTP endpoint, with as many instances as you like
 *
 * Use this to connect models that have no ready-made provider: wrap the model in a small HTTP
 * service (a few dozen lines with FastAPI or Flask) that implements
 *
 *     POST <url>/parse      multipart/form-data with the PDF in the "file" field, and the
 *                           instance's options as JSON in the "options" field
 *
 * and answers, once parsing is done, with one of
 *
 *     application/zip       a Markdown file plus images/ that it references
 *     application/json      { "markdown": "...", "images": { "fig1.png": "<base64>", ... } },
 *                           where the Markdown references images/fig1.png
 *     text/markdown         just the Markdown
 *
 * Optionally, GET <url>/health answers 2xx when the service is up (used by "Test connection").
 *
 * Each entry in INSTANCES below becomes its own service in the plugin, with its own settings,
 * so you can run several models (or the same model with different options) side by side.
 *
 * To use it, copy this file into <Zotero data directory>/agent-parser/providers/, edit
 * INSTANCES, and restart Zotero. Change the code as needed -- e.g., for a service that queues
 * jobs and has to be polled, see mineru-tasks-api.js, and docs/custom-providers.md for the
 * provider interface.
 */
(function () {
	const INSTANCES = [
		{
			// Unique; also the prefix of the instance's prefs (extensions.agentparser.providers.<id>.*)
			id: 'local-docling',
			name: { 'zh-CN': 'Docling（本机）', 'en-US': 'Docling (local)' },
			url: 'http://127.0.0.1:5001',
			// Sent to the service in the "options" field; editable in the settings as JSON
			options: { do_ocr: false },
			concurrency: 1,
		},
		// {
		// 	id: 'workstation-paddleocr-vl',
		// 	name: 'PaddleOCR-VL (workstation)',
		// 	url: 'http://192.168.1.20:8080',
		// 	options: {},
		// 	concurrency: 2,
		// },
	];


	class Backend {
		constructor(id, getPref) {
			this.id = id;
			this.baseURL = AgentParserProviders.trimURL(getPref('url'));
			this.apiKey = (getPref('apiKey') || '').trim();
			let options = getPref('options') || '{}';
			try {
				this.options = JSON.parse(options);
			}
			catch (e) {
				throw new Error(`Options for ${id} aren't valid JSON: ${options}`);
			}
		}

		_headers() {
			return this.apiKey ? { Authorization: 'Bearer ' + this.apiKey } : {};
		}

		async test() {
			let response = await AgentParserHTTP.request('GET', this.baseURL + '/health', {
				headers: this._headers(),
				timeout: 15000
			});
			return `HTTP ${response.status}`;
		}

		async parse(job) {
			job.onStatus('uploading');
			let body = AgentParserProviders.multipart(
				{ options: JSON.stringify(this.options) },
				job.uploadName,
				await AgentParserProviders.readFile(job.filePath)
			);
			// The service answers when it's done. job.onStatus('parsing') once the upload is sent
			// would need a streaming request, so the status stays at "uploading" until then.
			let response = await AgentParserHTTP.request('POST', this.baseURL + '/parse', {
				headers: { ...this._headers(), 'Content-Type': body.contentType },
				body: body.data,
				timeout: job.timeout + job.queueTimeout
			});
			job.checkCancelled();
			job.onStatus('downloading');
			let type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
			if (type == 'application/zip' || type == 'application/x-zip-compressed') {
				let zipPath = PathUtils.join(job.tempDir, 'result.zip');
				await IOUtils.write(zipPath, new Uint8Array(await response.arrayBuffer()));
				await AgentParserOutput.extractZip(zipPath, job.stagingDir);
			}
			else if (type == 'application/json') {
				let json = await response.json();
				if (typeof json.markdown != 'string') {
					throw new Error(`${this.id} returned JSON without "markdown"`);
				}
				await IOUtils.writeUTF8(PathUtils.join(job.stagingDir, 'full.md'), json.markdown);
				for (let [name, base64] of Object.entries(json.images || {})) {
					// Only plain file names, so that nothing is written outside images/
					if (!/^[\w.-]+$/.test(name)) {
						continue;
					}
					await IOUtils.makeDirectory(PathUtils.join(job.stagingDir, 'images'), { ignoreExisting: true });
					let bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
					await IOUtils.write(PathUtils.join(job.stagingDir, 'images', name), bytes);
				}
			}
			else {
				await IOUtils.writeUTF8(PathUtils.join(job.stagingDir, 'full.md'), await response.text());
			}
			// Goes into full.md as parser: <id> (and parser_<name> from frontMatter())
			return { service: this.id, url: this.baseURL };
		}
	}


	for (let instance of INSTANCES) {
		AgentParserProviders.register({
			apiVersion: 1,
			id: instance.id,
			name: instance.name,
			defaultPrefs: {
				url: instance.url,
				apiKey: '',
				options: JSON.stringify(instance.options || {}),
				concurrency: instance.concurrency || 1
			},
			settings: {
				fields: [
					{ pref: 'url', label: { 'zh-CN': '服务地址：', 'en-US': 'URL:' }, setupFocus: true },
					{ pref: 'apiKey', label: { 'zh-CN': 'API Key：', 'en-US': 'API key:' }, type: 'password' },
					{ pref: 'options', label: { 'zh-CN': '参数（JSON）：', 'en-US': 'Options (JSON):' } },
					{ pref: 'concurrency', label: { 'zh-CN': '并发任务数：', 'en-US': 'Concurrent jobs:' }, type: 'number' }
				],
				test: true
			},

			getConcurrency(ctx) {
				return Math.max(1, parseInt(ctx.getPref('concurrency')) || 1);
			},

			getSetupIssue(ctx) {
				if (!(ctx.getPref('url') || '').trim()) {
					return { message: { 'zh-CN': `未填写 ${instance.id} 的服务地址`, 'en-US': `no URL for ${instance.id}` } };
				}
				return null;
			},

			classifyError(e) {
				// Couldn't connect: the service isn't running. Try again in a while instead of
				// failing (mineru-tasks-api.js shows how to wait for it instead).
				return e && e.isNetworkError ? 'busy' : 'error';
			},

			create(ctx) {
				return new Backend(instance.id, ctx.getPref);
			}
		});
	}
})();
