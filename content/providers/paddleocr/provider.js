/* global Zotero, AgentParserHTTP, AgentParserProviders */

/**
 * PaddleOCR (Baidu AI Studio async API, PaddleOCR-VL models)
 *
 * https://ai.baidu.com/ai-doc/AISTUDIO/fml7mozw5
 *
 * The service runs in Beijing and is only fast from mainland China: uploads from elsewhere crawl
 * along at ~15 KB/s per connection, and URLs are downloaded by the server, which generally can't
 * reach hosts outside mainland China (arXiv, CDNs, ...). So nothing is submitted by URL unless the
 * user lists hosts that the server can reach.
 */
var AgentParserPaddleOCR = {};


AgentParserPaddleOCR.Backend = class {
	// The service parses only the first 1000 pages; uploads over 50 MB are refused (URLs: 200 MB)
	static MAX_PAGES = 1000;
	static MAX_FILE_SIZE = 50 * 1024 * 1024;
	// 10010: submission queue full, 12001: daily page quota used up, 12002: too many requests
	static BUSY_CODES = new Set([10010, 12001, 12002]);
	static BUSY_STATUS = new Set([429, 503]);
	// 10003: file too large, 10006: too many pages. Trying again won't help.
	static LIMIT_CODES = new Set([10003, 10006]);
	// Result URLs are valid for 7 days
	static RESUME_MAX_AGE = 6 * 24 * 60 * 60 * 1000;
	// Uploads can be very slow from outside mainland China, so allow at least this rate
	static MIN_UPLOAD_RATE = 8 * 1024;
	static PHASES = {
		pending: 'pending',
		running: 'parsing',
		done: 'downloading'
	};

	static isBusy(e) {
		return !!e && (AgentParserPaddleOCR.Backend.BUSY_CODES.has(e.code)
			|| AgentParserPaddleOCR.Backend.BUSY_STATUS.has(e.status));
	}

	constructor(getPref) {
		this.baseURL = AgentParserProviders.trimURL(getPref('url'));
		this.token = (getPref('token') || '').trim();
		this.model = getPref('model') || 'PaddleOCR-VL-1.5';
		this.chartRecognition = !!getPref('chartRecognition');
		this.urlHosts = AgentParserProviders.parseHosts(getPref('urlHosts'));
	}

	_auth() {
		if (!this.token) {
			throw new Error("PaddleOCR access token is not configured");
		}
		return { Authorization: 'bearer ' + this.token };
	}

	_options() {
		return {
			useDocOrientationClassify: false,
			useDocUnwarping: false,
			useChartRecognition: this.chartRecognition
		};
	}

	/**
	 * Send a request and unwrap the service's { code, msg, data } response
	 *
	 * Errors carry .code (the service's) and .status (HTTP), for classifyError()
	 */
	async _call(method, path, options = {}) {
		let response = await AgentParserHTTP.request(method, this.baseURL + path, {
			...options,
			headers: { ...this._auth(), ...options.headers },
			allowErrorStatus: true
		});
		let text = await response.text();
		let json = null;
		try {
			json = JSON.parse(text);
		}
		catch (e) {}
		if (!json || json.code !== 0) {
			let message = json ? (json.data?.errorMsg || json.msg || json.code) : `HTTP ${response.status}`;
			let e = new Error(`PaddleOCR API error: ${message}`);
			e.code = json ? json.code : null;
			e.status = response.status;
			e.limitExceeded = AgentParserPaddleOCR.Backend.LIMIT_CODES.has(e.code);
			throw e;
		}
		return json.data;
	}

	async test() {
		try {
			await this._call('GET', '/jobs/agent-parser-test', { timeout: 15000 });
		}
		catch (e) {
			if (e.status == 401 || e.code == 401) {
				throw new Error("Token rejected");
			}
			// 11001: job not found, which means the token was accepted
			if (e.code == 11001) {
				return 'Token OK';
			}
			throw e;
		}
		return 'Token OK';
	}

	_info() {
		return {
			service: 'paddleocr',
			url: this.baseURL,
			model: this.model,
			chartRecognition: this.chartRecognition
		};
	}

	_resumeKey() {
		return JSON.stringify({ model: this.model, ...this._options() });
	}

	_canResume(job) {
		let remote = job.resume;
		return !!remote
			&& remote.kind == 'job'
			&& typeof remote.id == 'string'
			&& !!job.sha256 && remote.sha256 == job.sha256
			&& remote.options == this._resumeKey()
			&& Date.now() - remote.submittedAt < AgentParserPaddleOCR.Backend.RESUME_MAX_AGE;
	}

	async parse(job) {
		let info = this._info();

		if (this._canResume(job)) {
			try {
				Zotero.debug(`Agent Parser: Resuming PaddleOCR job ${job.resume.id} for ${job.dataID}`);
				await this._finish(job, job.resume.id, job.resume.submittedAt);
				let parserInfo = { ...info, input: job.resume.mode, jobID: job.resume.id, resumed: true };
				if (job.resume.mode == 'url') {
					parserInfo.sourceURL = job.sourceURL;
				}
				return parserInfo;
			}
			catch (e) {
				job.checkCancelled();
				Zotero.debug(`Agent Parser: Couldn't resume ${job.dataID} (${e.message}) -- submitting again`);
			}
		}

		job.queued = false;
		job.startedAt = null;
		job.onStatus('preparing');

		if (job.sourceURL && AgentParserProviders.isAllowedURL(job.sourceURL, this.urlHosts)) {
			let reason = await AgentParserProviders.checkURL(job.sourceURL, job.fileSize);
			if (!reason) {
				try {
					let jobID = await this._submitURL(job);
					await this._finish(job, jobID);
					return { ...info, input: 'url', sourceURL: job.sourceURL, jobID };
				}
				catch (e) {
					job.checkCancelled();
					if (AgentParserPaddleOCR.Backend.isBusy(e) || e.limitExceeded) {
						throw e;
					}
					reason = e.message || String(e);
				}
			}
			Zotero.debug(`Agent Parser: Not using URL for ${job.dataID} (${reason}) -- uploading instead`);
			job.onStatus('preparing');
		}

		let jobID = await this._submitUpload(job);
		await this._finish(job, jobID);
		return { ...info, input: 'upload', jobID };
	}

	async _submitURL(job) {
		let data = await this._call('POST', '/jobs', {
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: this.model,
				fileUrl: job.sourceURL,
				optionalPayload: this._options()
			}),
			// The server downloads the file before it answers
			timeout: 5 * 60 * 1000
		});
		return this._submitted(job, data, 'url');
	}

	/**
	 * Upload the file with the submission itself -- the API has no separate upload URL
	 */
	async _submitUpload(job) {
		job.onStatus('uploading');
		let body = AgentParserProviders.multipart({
			model: this.model,
			optionalPayload: JSON.stringify(this._options())
		}, job.uploadName, await AgentParserProviders.readFile(job.filePath));
		let timeout = Math.max(
			10 * 60 * 1000,
			Math.round(body.data.length / AgentParserPaddleOCR.Backend.MIN_UPLOAD_RATE * 1000)
		);
		let delays = AgentParserHTTP.UPLOAD_RETRY_DELAYS;
		for (let attempt = 0; ; attempt++) {
			try {
				let data = await this._call('POST', '/jobs', {
					headers: { 'Content-Type': body.contentType },
					body: body.data,
					timeout
				});
				return this._submitted(job, data, 'upload');
			}
			catch (e) {
				if (!(e.isNetworkError || e.isTimeout) || attempt >= delays.length) {
					throw e;
				}
				Zotero.debug(`Agent Parser: Uploading ${job.dataID} to PaddleOCR failed (${e.message}) -- `
					+ `retrying in ${delays[attempt] / 1000}s`);
				await AgentParserHTTP.sleep(delays[attempt]);
				job.checkCancelled();
			}
		}
	}

	_submitted(job, data, mode) {
		let jobID = data && data.jobId;
		if (!jobID) {
			throw new Error("PaddleOCR API did not return a job ID");
		}
		Zotero.debug(`Agent Parser: Created PaddleOCR job ${jobID} (${mode})`);
		job.onSubmitted?.({
			kind: 'job',
			id: String(jobID),
			mode,
			sha256: job.sha256,
			options: this._resumeKey(),
			submittedAt: Date.now()
		});
		return String(jobID);
	}

	/**
	 * Wait for a job and save its results
	 */
	async _finish(job, jobID, submittedAt = Date.now()) {
		job.queued = true;
		job.startedAt = null;
		job.onStatus('pending');
		let result = await AgentParserProviders.poll(job, async () => {
			let data = await this._call('GET', '/jobs/' + encodeURIComponent(jobID));
			if (data.state == 'done') {
				return data;
			}
			if (data.state == 'failed') {
				throw new Error(`PaddleOCR parsing failed: ${data.errorMsg || 'unknown error'}`);
			}
			job.queued = data.state == 'pending';
			if (!job.queued && !job.startedAt) {
				job.startedAt = Date.now();
			}
			let progress = data.extractProgress;
			job.onStatus(
				AgentParserPaddleOCR.Backend.PHASES[data.state] || 'parsing',
				progress && parseInt(progress.totalPages) ? `${progress.extractedPages}/${progress.totalPages}` : null
			);
			return undefined;
		}, submittedAt);
		job.onStatus('downloading');
		let url = result.resultUrl && result.resultUrl.jsonUrl;
		if (!url) {
			throw new Error("PaddleOCR result is missing jsonUrl");
		}
		let response = await AgentParserHTTP.request('GET', url, { timeout: 10 * 60 * 1000 });
		let pages = AgentParserPaddleOCR.Markdown.pagesFromJSONL(await response.text());
		await this._save(job, pages);
	}

	async _save(job, pages) {
		let imagesDir = PathUtils.join(job.stagingDir, 'images');
		let texts = [];
		for (let [index, page] of pages.entries()) {
			// Image names come from coordinates on the page, so they can repeat across pages
			let rename = path => `images/p${index + 1}_${path.split('/').pop()}`;
			for (let [path, url] of Object.entries(page.images || {})) {
				job.checkCancelled();
				if (!(await IOUtils.exists(imagesDir))) {
					await IOUtils.makeDirectory(imagesDir, { createAncestors: true });
				}
				await AgentParserHTTP.download(url, PathUtils.join(job.stagingDir, ...rename(path).split('/')));
			}
			texts.push(AgentParserPaddleOCR.Markdown.clean(page.text || '', path => (page.images || {})[path] ? rename(path) : path));
		}
		await IOUtils.writeUTF8(PathUtils.join(job.stagingDir, 'full.md'),
			AgentParserPaddleOCR.Markdown.joinPages(texts));
	}
};


/**
 * Turn the service's per-page Markdown into what other providers produce
 */
AgentParserPaddleOCR.Markdown = {
	/**
	 * @return {Object[]} - { text, images: { path: url } } for each page, in order
	 */
	pagesFromJSONL(jsonl) {
		let pages = [];
		for (let line of jsonl.split('\n')) {
			if (!line.trim()) {
				continue;
			}
			let json = JSON.parse(line);
			if (json.errorCode) {
				throw new Error(`PaddleOCR parsing failed: ${json.errorMsg || json.errorCode}`);
			}
			for (let result of json.result?.layoutParsingResults || []) {
				pages.push({
					text: result.markdown?.text || '',
					images: result.markdown?.images || {}
				});
			}
		}
		if (!pages.length) {
			throw new Error("PaddleOCR result contains no pages");
		}
		return pages;
	},


	/**
	 * @param {String} md - One page
	 * @param {Function} mapImage - Image path in the result -> path in the output
	 */
	clean(md, mapImage) {
		return md
			// Centered figures: <div style="text-align: center;"><img src="imgs/x.jpg" alt="Image" width="52%" /></div>
			.replace(/<div[^>]*>\s*<img\s[^>]*?src="([^"]+)"[^>]*>\s*<\/div>/g, (m, src) => `![](${mapImage(src)})`)
			// Images elsewhere, e.g., inside tables
			.replace(/(<img\s[^>]*?src=")([^"]+)(")/g, (m, a, src, b) => a + mapImage(src) + b)
			// Centered captions and other text
			.replace(/<div style="text-align: center;">([\s\S]*?)<\/div>/g, '$1')
			// Inline styles and borders on every table cell double the size of the file
			.replace(/<(table|tr|td|th)\b([^>]*)>/g, (m, tag, attrs) => {
				let kept = (attrs.match(/\s(?:colspan|rowspan)=(?:"[^"]*"|'[^']*'|\S+)/g) || []).join('');
				return `<${tag}${kept}>`;
			})
			// $$ x $$ -> display block
			.replace(/^[ \t]*\$\$ ?([\s\S]+?) ?\$\$[ \t]*$/gm, (m, tex) => `$$\n${tex.trim()}\n$$`)
			// $ x $ -> $x$, since Markdown renderers don't treat "$ " as the start of a formula
			.replace(/(^|[^$\\])\$ ([^$\n]+?) \$(?!\$)/g, (m, before, tex) => `${before}$${tex.trim()}$`);
	},


	/**
	 * Join pages, continuing a paragraph that runs over a page break
	 */
	joinPages(pages) {
		let out = '';
		for (let page of pages) {
			let text = page.trim();
			if (!text) {
				continue;
			}
			if (!out) {
				out = text;
				continue;
			}
			let continues = /[\p{L}\p{N},;\-–]$/u.test(out)
				&& /^[\p{Ll}\p{N}(]/u.test(text)
				&& !/^(#|!\[|<|\$\$|\||[-*+] )/.test(text);
			if (continues && /[\p{L}]-$/u.test(out)) {
				out = out.slice(0, -1) + text;
			}
			else if (continues) {
				out += ' ' + text;
			}
			else if (/[一-鿿]$/.test(out) && /^[一-鿿]/.test(text)) {
				out += text;
			}
			else {
				out += '\n\n' + text;
			}
		}
		return out + '\n';
	}
};


AgentParserProviders.register({
	apiVersion: 1,
	id: 'paddleocr',
	ftl: 'agent-parser-paddleocr.ftl',
	l10n: {
		name: 'agentparser-provider-paddleocr',
		confirmBulk: 'agentparser-paddleocr-confirm-library'
	},
	defaultPrefs: {
		url: 'https://paddleocr.aistudio-app.com/api/v2/ocr',
		token: '',
		model: 'PaddleOCR-VL-1.5',
		chartRecognition: false,
		// The server generally can't download from hosts outside mainland China, so this is empty
		urlHosts: '',
		// Each upload connection is slow from outside mainland China, but several add up
		concurrency: '3'
	},
	limits: {
		maxPages: AgentParserPaddleOCR.Backend.MAX_PAGES,
		maxFileSize: AgentParserPaddleOCR.Backend.MAX_FILE_SIZE
	},
	settings: {
		fragment: 'content/providers/paddleocr/settings.xhtml',
		script: 'content/providers/paddleocr/settings.js'
	},


	getConcurrency(ctx) {
		let value = parseInt(ctx.getPref('concurrency'));
		return value > 0 ? value : 1;
	},


	getSetupIssue(ctx) {
		if (!(ctx.getPref('token') || '').trim()) {
			return { l10nID: 'agentparser-paddleocr-setup-token' };
		}
		return null;
	},


	classifyError(e) {
		if (AgentParserPaddleOCR.Backend.isBusy(e)) {
			return 'busy';
		}
		if (e && e.limitExceeded) {
			return 'limit';
		}
		return 'error';
	},


	getFallback() {
		return null;
	},


	describe(parserInfo) {
		return parserInfo.model || 'default';
	},


	frontMatter(parserInfo) {
		return {
			model: parserInfo.model,
			input: parserInfo.input,
			source_url: parserInfo.input == 'url' ? parserInfo.sourceURL : null
		};
	},


	create(ctx) {
		return new AgentParserPaddleOCR.Backend(ctx.getPref);
	}
});
