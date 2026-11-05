/* global Zotero, AgentParserHTTP, AgentParserOutput */

/**
 * Parsing backends
 *
 * Each backend exposes `async parse(job)`, which must leave the raw parse results in
 * `job.stagingDir` and return an object describing the parser.
 *
 * job = {
 *   filePath, fileName, fileSize, sha256,
 *   uploadName      -- ASCII-safe file name to send to the service
 *   stagingDir      -- empty directory for the extracted results
 *   tempDir         -- scratch directory for downloads
 *   pollInterval    -- milliseconds
 *   timeout         -- milliseconds to wait once the service starts working on the file
 *   queueTimeout    -- milliseconds to wait while the service still has the file queued
 *   onStatus(str)   -- progress callback
 *   checkCancelled()-- throws if the job should stop
 * }
 */
var AgentParserBackends = {
	create(name, getPref) {
		let cls = this.classFor(name);
		if (!cls) {
			throw new Error(`Unknown backend '${name}'`);
		}
		return new cls(getPref);
	},
	
	
	classFor(name) {
		switch (name) {
			case 'local':
				// Not included in the lite (cloud-only) edition
				return AgentParserBackends.Local || null;
			case 'cloudV4':
				return AgentParserBackends.CloudV4;
			default:
				return null;
		}
	},


	trimURL(url) {
		url = (url || '').trim().replace(/\/+$/, '');
		if (!url) {
			throw new Error("Service URL is not configured");
		}
		return url;
	},


	async readFile(path) {
		return IOUtils.read(path);
	},


	/**
	 * Poll until `fn` returns a non-undefined value
	 *
	 * Services that report queueing set `job.queued` while the file waits on the server and
	 * `job.startedAt` once processing starts, so that `job.timeout` only covers actual parsing.
	 * Otherwise the timeout runs from the start of polling.
	 */
	async poll(job, fn, since = Date.now()) {
		while (true) {
			job.checkCancelled();
			let result;
			try {
				result = await fn();
			}
			catch (e) {
				// Keep polling through dropped connections and server hiccups
				if (!AgentParserHTTP.isTransientError(e)) {
					throw e;
				}
				job.checkCancelled();
				Zotero.debug(`Agent Parser: Polling for ${job.dataID} failed (${e.message}) -- trying again`);
			}
			if (result !== undefined) {
				return result;
			}
			if (this.isTimedOut(job, since)) {
				throw new Error("Timed out waiting for parse results");
			}
			await AgentParserHTTP.sleep(job.pollInterval);
		}
	},
	
	
	isTimedOut({ queued, startedAt, timeout, queueTimeout }, submittedAt) {
		let now = Date.now();
		if (queued) {
			return now - submittedAt > queueTimeout;
		}
		return now - (startedAt || submittedAt) > timeout;
	},
	
	
	/**
	 * Whether the service refused new work for now, in which case the file should go back in the
	 * queue rather than fail
	 */
	isServerBusy(e) {
		return !!e && AgentParserBackends.CloudV4.BUSY_CODES.has(e.code);
	}
};


/**
 * MinerU >= 4 unified Tasks API (POST /v1/tasks), served by `mineru-kit api-server`
 */
AgentParserBackends.Tasks = class {
	static TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'canceled']);

	constructor({ url, apiKey, tier, ocrMode }) {
		this.baseURL = AgentParserBackends.trimURL(url);
		this.apiKey = (apiKey || '').trim();
		this.tier = tier || '';
		this.ocrMode = ocrMode || 'auto';
		this.serviceName = 'mineru-tasks';
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

	_taskURL(taskID) {
		return this.baseURL + '/v1/tasks/' + encodeURIComponent(taskID);
	}

	async test() {
		let json = await AgentParserHTTP.json('GET', this.baseURL + '/v1/health', {
			headers: this._authHeaders(),
			timeout: 15000
		});
		return json.version ? `MinerU ${json.version}` : JSON.stringify(json).substr(0, 200);
	}

	async parse(job) {
		let payload = {
			files: [{
				file_name: job.uploadName,
				bytes: job.fileSize,
				sha256sum: job.sha256
			}],
			output_formats: ['default']
		};
		if (this.tier) {
			payload.tier = this.tier;
		}
		if (this.ocrMode) {
			payload.ocr_mode = this.ocrMode;
		}

		job.onStatus('submitting');
		let task = await AgentParserHTTP.json('POST', this.baseURL + '/v1/tasks', {
			headers: {
				...this._authHeaders(),
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});
		this._checkTask(task);
		Zotero.debug(`Agent Parser: Created MinerU task ${task.task_id}`);

		let uploaded = false;
		let first = true;
		task = await AgentParserBackends.poll(job, async () => {
			if (!first) {
				task = await AgentParserHTTP.json('GET', this._taskURL(task.task_id), {
					headers: this._authHeaders()
				});
				this._checkTask(task);
				job.onStatus(task.files[0].status || task.status);
			}
			first = false;

			let file = task.files[0];
			// The server skips the upload if it already has a file with the same hash
			if (!uploaded && file.status == 'waiting-file' && file.upload && file.upload.url) {
				await this._upload(job, file.upload);
				uploaded = true;
			}
			if (AgentParserBackends.Tasks.TERMINAL_STATUSES.has(task.status)) {
				return task;
			}
			return undefined;
		});

		let file = task.files[0];
		if (task.status == 'failed' || task.status == 'canceled' || file.status != 'completed') {
			let err = task.error || file.error || {};
			throw new Error(`MinerU task ${task.status}: ${err.message || err.code || file.status}`);
		}
		if (!file.result_url) {
			throw new Error("MinerU task completed without result_url");
		}

		job.onStatus('downloading');
		let resultURL = this._resolve(file.result_url);
		let zipPath = PathUtils.join(job.tempDir, 'result.zip');
		await AgentParserHTTP.download(resultURL, zipPath, {
			headers: this._authHeaders(resultURL)
		});
		await AgentParserOutput.extractZip(zipPath, job.stagingDir);

		return {
			service: this.serviceName,
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
			if (['content-length', 'transfer-encoding', 'host'].includes(key.toLowerCase())) {
				continue;
			}
			headers[key] = value;
		}
		Object.assign(headers, this._authHeaders(url));
		await AgentParserHTTP.upload(url, () => AgentParserBackends.readFile(job.filePath), {
			headers,
			checkCancelled: () => job.checkCancelled()
		});
	}

	_checkTask(task) {
		if (!task || typeof task.task_id != 'string' || !Array.isArray(task.files) || task.files.length != 1) {
			throw new Error("Unexpected response from MinerU Tasks API: "
				+ JSON.stringify(task).substr(0, 300));
		}
	}
};


/**
 * mineru.net v4 API (precise parsing)
 *
 * PDFs saved from an allowlisted host (e.g., arxiv.org) are submitted by URL so that MinerU
 * downloads them itself, which avoids slow uploads. Everything else, and any URL submission that
 * fails, is uploaded from the local file.
 *
 * https://mineru.net/apiManage/docs
 */
AgentParserBackends.CloudV4 = class {
	static MAX_BATCH = 50;
	// The API rejects longer files
	static MAX_PAGES = 200;
	// -60009: submission queue is full, -60018: daily task limit reached
	static BUSY_CODES = new Set([-60009, -60018]);
	// States before the server starts working on a file
	static QUEUED_STATES = new Set(['waiting-file', 'pending']);
	
	// Submissions older than this aren't resumed after a restart, since the service may have
	// discarded them
	static RESUME_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
	
	constructor(getPref) {
		this.baseURL = AgentParserBackends.trimURL(getPref('cloudV4.url'));
		this.token = (getPref('cloudV4.token') || '').trim();
		this.modelVersion = getPref('cloudV4.modelVersion') || 'vlm';
		this.isOCR = !!getPref('cloudV4.isOCR');
		this.enableFormula = !!getPref('cloudV4.enableFormula');
		this.enableTable = !!getPref('cloudV4.enableTable');
		this.language = getPref('cloudV4.language') || 'ch';
		this.uploadAcceleration = getPref('cloudV4.uploadAcceleration') || 'auto';
		this.urlHosts = (getPref('cloudV4.urlHosts') || '')
			.split(/[\s,;]+/)
			.map(x => x.trim().toLowerCase().replace(/^\*?\./, ''))
			.filter(Boolean);
	}
	
	_headers() {
		if (!this.token) {
			throw new Error("MinerU API token is not configured");
		}
		return {
			Authorization: 'Bearer ' + this.token,
			'Content-Type': 'application/json'
		};
	}
	
	_check(json) {
		if (!json || json.code !== 0) {
			let e = new Error(`MinerU API error: ${json && (json.msg || json.msgCode || json.code)}`);
			e.code = json && json.code;
			throw e;
		}
		return json.data;
	}
	
	_options() {
		return {
			model_version: this.modelVersion,
			enable_formula: this.enableFormula,
			enable_table: this.enableTable,
			language: this.language
		};
	}
	
	async test() {
		// Querying a nonexistent batch tells us whether the token is accepted
		let response = await AgentParserHTTP.request('GET', this.baseURL + '/extract-results/batch/agent-parser-test', {
			headers: this._headers(),
			timeout: 15000,
			allowErrorStatus: true
		});
		let text = await response.text();
		let json;
		try {
			json = JSON.parse(text);
		}
		catch (e) {}
		if (response.status == 401 || (json && (json.msgCode == 'A0202' || /authenticate/i.test(json.msg || '')))) {
			throw new Error(`Token rejected: ${json ? json.msg : response.status}`);
		}
		// -60012: task not found, which means the token was accepted
		if (json && json.code == -60012) {
			return 'Token OK';
		}
		return `HTTP ${response.status}` + (json && json.msg ? ` (${json.msg})` : '');
	}
	
	_info() {
		return {
			service: 'mineru-cloud-v4',
			url: this.baseURL,
			modelVersion: this.modelVersion,
			isOCR: this.isOCR,
			enableFormula: this.enableFormula,
			enableTable: this.enableTable,
			language: this.language
		};
	}
	
	async parse(job) {
		let info = this._info();
		
		if (this._canResume(job)) {
			try {
				return await this._resume(job);
			}
			catch (e) {
				job.checkCancelled();
				Zotero.debug(`Agent Parser: Couldn't resume ${job.dataID} (${e.message}) -- submitting again`);
			}
		}
		
		if (job.sourceURL && this.isAllowedURL(job.sourceURL)) {
			let reason = await this.checkURL(job.sourceURL, job.fileSize);
			if (!reason) {
				try {
					let taskID = await this._parseURL(job, job.sourceURL);
					return { ...info, input: 'url', sourceURL: job.sourceURL, taskID };
				}
				catch (e) {
					job.checkCancelled();
					if (AgentParserBackends.isServerBusy(e)) {
						throw e;
					}
					reason = e.message || String(e);
				}
			}
			Zotero.debug(`Agent Parser: Not using URL for ${job.dataID} (${reason}) -- uploading instead`);
		}
		
		let batchID = await this._parseUpload(job);
		return { ...info, input: 'upload', batchID };
	}
	
	/**
	 * Settings that change what the service produces, to tell whether an earlier submission
	 * still matches
	 */
	_resumeKey() {
		return JSON.stringify({ ...this._options(), is_ocr: this.isOCR });
	}
	
	/**
	 * Tell the caller about a submission the service accepted, so that it can be resumed after
	 * a restart instead of being submitted (and paid for) again
	 *
	 * @param {Object} remote - { kind: 'task' or 'batch', id, mode: 'url' or 'upload' }
	 */
	_submitted(job, remote) {
		job.onSubmitted?.({
			...remote,
			sha256: job.sha256,
			options: this._resumeKey(),
			submittedAt: Date.now()
		});
	}
	
	_canResume(job) {
		let remote = job.resume;
		return !!remote
			&& (remote.kind == 'task' || remote.kind == 'batch')
			&& typeof remote.id == 'string'
			&& !!job.sha256 && remote.sha256 == job.sha256
			&& remote.options == this._resumeKey()
			&& Date.now() - remote.submittedAt < AgentParserBackends.CloudV4.RESUME_MAX_AGE;
	}
	
	/**
	 * Keep polling a submission from before a restart
	 *
	 * @throws If the service no longer has it, or the upload never finished
	 */
	async _resume(job) {
		let remote = job.resume;
		Zotero.debug(`Agent Parser: Resuming MinerU ${remote.kind} ${remote.id} for ${job.dataID}`);
		job.queued = true;
		job.startedAt = null;
		let path = remote.kind == 'task' ? '/extract/task/' : '/extract-results/batch/';
		let result = await AgentParserBackends.poll(job, async () => {
			let data = this._check(await AgentParserHTTP.json(
				'GET',
				this.baseURL + path + encodeURIComponent(remote.id),
				{ headers: this._headers() }
			));
			let result = remote.kind == 'task'
				? data
				: (data.extract_result || []).find(x => x.data_id == job.dataID);
			if (!result || result.state == 'waiting-file') {
				throw new Error(`MinerU ${remote.kind} ${remote.id} has no file for ${job.dataID}`);
			}
			return this._handleResult(job, result);
		}, remote.submittedAt);
		job.onStatus('downloading');
		await this._downloadResult(job, result);
		let info = { ...this._info(), input: remote.mode, resumed: true };
		info[remote.kind == 'task' ? 'taskID' : 'batchID'] = remote.id;
		if (remote.mode == 'url') {
			info.sourceURL = job.sourceURL;
		}
		return info;
	}
	
	/**
	 * Parse many files with as few requests as possible
	 *
	 * Allowlisted URLs go out as one URL batch, everything else as one upload batch. Files are
	 * uploaded one at a time while the server is already parsing earlier ones, and results are
	 * handed back as soon as each file is done. URL submissions that fail are retried as uploads.
	 *
	 * @param {Object} batch
	 * @param {Object[]} batch.jobs - Same fields as the job passed to parse()
	 * @param {Number} batch.pollInterval
	 * @param {Number} batch.timeout - Milliseconds to wait for each file once the server starts on it
	 * @param {Number} batch.queueTimeout - Milliseconds to wait while the server has a file queued
	 * @param {Function} batch.checkCancelled
	 * @param {Function} batch.onStatus - (job, status)
	 * @param {Function} batch.onDone - async (job, parserInfo)
	 * @param {Function} batch.onFailed - async (job, error)
	 * @param {Function} batch.onDeferred - async (job, error) -- the server refused new work for now
	 */
	async parseBatch(batch) {
		let { jobs, checkCancelled } = batch;
		// dataID -> { job, mode, batchID, submittedAt, queued, startedAt }
		let pending = new Map();
		let uploadQueue = [];
		let fallback = [];
		let uploader = null;
		
		let track = (chunk, batchID, mode, resumedAt = null) => {
			for (let job of chunk) {
				pending.set(job.dataID, {
					job,
					mode,
					batchID,
					submittedAt: resumedAt || (mode == 'url' ? Date.now() : null),
					resumed: !!resumedAt,
					queued: true,
					startedAt: null,
					timeout: batch.timeout,
					queueTimeout: batch.queueTimeout
				});
				batch.onStatus(job, resumedAt || mode == 'url' ? 'pending' : 'waiting-upload');
			}
		};
		// A submission from before a restart that the service no longer has gets submitted again
		let resubmit = (entry, reason) => {
			pending.delete(entry.job.dataID);
			Zotero.debug(`Agent Parser: Couldn't resume ${entry.job.dataID} (${reason}) -- submitting again`);
			fallback.push(entry.job);
		};
		let fail = async (entry, e) => {
			pending.delete(entry.job.dataID);
			if (entry.mode == 'url') {
				Zotero.debug(`Agent Parser: URL submission for ${entry.job.dataID} failed (${e.message}) -- uploading instead`);
				fallback.push(entry.job);
			}
			else {
				await batch.onFailed(entry.job, e);
			}
		};
		
		let busyError = null;
		let defer = async (chunk, e) => {
			busyError = e;
			Zotero.debug(`Agent Parser: MinerU refused ${chunk.length} file(s) for now (${e.message})`);
			for (let job of chunk) {
				await batch.onDeferred(job, e);
			}
		};
		
		let requestUploads = async (uploadJobs) => {
			for (let chunk of this._chunk(uploadJobs)) {
				// Once the server is busy, don't keep asking within this batch
				if (busyError) {
					await defer(chunk, busyError);
					continue;
				}
				let data;
				try {
					data = this._check(await AgentParserHTTP.json('POST', this.baseURL + '/file-urls/batch', {
						headers: this._headers(),
						body: JSON.stringify({
							files: chunk.map(job => ({ name: job.uploadName, data_id: job.dataID, is_ocr: this.isOCR })),
							...this._options()
						})
					}));
				}
				catch (e) {
					if (!AgentParserBackends.isServerBusy(e)) {
						throw e;
					}
					await defer(chunk, e);
					continue;
				}
				if (!data.batch_id || !data.file_urls || data.file_urls.length != chunk.length) {
					throw new Error("MinerU API did not return upload URLs");
				}
				Zotero.debug(`Agent Parser: Created MinerU upload batch ${data.batch_id} with ${chunk.length} file(s)`);
				track(chunk, data.batch_id, 'upload');
				chunk.forEach((job, i) => uploadQueue.push({ job, url: data.file_urls[i] }));
			}
			// Upload in the background so that results for earlier files come in meanwhile
			if (!uploader) {
				uploader = (async () => {
					while (uploadQueue.length) {
						let { job, url } = uploadQueue.shift();
						let entry = pending.get(job.dataID);
						if (!entry) {
							continue;
						}
						checkCancelled();
						batch.onStatus(job, 'uploading');
						try {
							await AgentParserHTTP.upload(url, () => AgentParserBackends.readFile(job.filePath), {
								accelerate: this.uploadAcceleration,
								checkCancelled
							});
							entry.submittedAt = Date.now();
							this._submitted(job, { kind: 'batch', id: entry.batchID, mode: 'upload' });
							batch.onStatus(job, 'pending');
						}
						catch (e) {
							checkCancelled();
							await fail(entry, e);
						}
					}
					uploader = null;
				})();
				uploader.catch(() => {});
			}
		};
		
		// Split into resumed, URL, and upload submissions
		let urlJobs = [];
		let uploadJobs = [];
		for (let job of jobs) {
			checkCancelled();
			if (this._canResume(job)) {
				Zotero.debug(`Agent Parser: Resuming MinerU batch ${job.resume.id} for ${job.dataID}`);
				track([job], job.resume.id, job.resume.mode, job.resume.submittedAt);
				continue;
			}
			if (job.sourceURL && this.isAllowedURL(job.sourceURL)) {
				batch.onStatus(job, 'checking-url');
				let reason = await this.checkURL(job.sourceURL, job.fileSize);
				if (!reason) {
					urlJobs.push(job);
					continue;
				}
				Zotero.debug(`Agent Parser: Not using URL for ${job.dataID} (${reason})`);
			}
			uploadJobs.push(job);
		}
		
		for (let chunk of this._chunk(urlJobs)) {
			if (busyError) {
				await defer(chunk, busyError);
				continue;
			}
			try {
				let data = this._check(await AgentParserHTTP.json('POST', this.baseURL + '/extract/task/batch', {
					headers: this._headers(),
					body: JSON.stringify({
						files: chunk.map(job => ({ url: job.sourceURL, data_id: job.dataID, is_ocr: this.isOCR })),
						...this._options()
					})
				}));
				if (!data.batch_id) {
					throw new Error("MinerU API did not return a batch ID");
				}
				Zotero.debug(`Agent Parser: Created MinerU URL batch ${data.batch_id} with ${chunk.length} file(s)`);
				track(chunk, data.batch_id, 'url');
				for (let job of chunk) {
					this._submitted(job, { kind: 'batch', id: data.batch_id, mode: 'url' });
				}
			}
			catch (e) {
				checkCancelled();
				if (AgentParserBackends.isServerBusy(e)) {
					await defer(chunk, e);
					continue;
				}
				Zotero.debug(`Agent Parser: URL batch submission failed (${e.message}) -- uploading instead`);
				uploadJobs.push(...chunk);
			}
		}
		if (uploadJobs.length) {
			await requestUploads(uploadJobs);
		}
		
		let info = this._info();
		while (pending.size || fallback.length) {
			checkCancelled();
			if (fallback.length) {
				let retry = fallback.splice(0);
				try {
					await requestUploads(retry);
				}
				catch (e) {
					checkCancelled();
					for (let job of retry) {
						await batch.onFailed(job, e);
					}
				}
				continue;
			}
			await AgentParserHTTP.sleep(batch.pollInterval);
			
			let batchIDs = new Set([...pending.values()].map(x => x.batchID));
			for (let batchID of batchIDs) {
				let data;
				try {
					data = this._check(await AgentParserHTTP.json(
						'GET',
						this.baseURL + '/extract-results/batch/' + encodeURIComponent(batchID),
						{ headers: this._headers() }
					));
				}
				catch (e) {
					// Try again on the next round
					checkCancelled();
					Zotero.debug(`Agent Parser: Polling batch ${batchID} failed: ${e.message}`);
					if (!AgentParserHTTP.isTransientError(e)) {
						for (let entry of [...pending.values()]) {
							if (entry.resumed && entry.batchID == batchID) {
								resubmit(entry, e.message);
							}
						}
					}
					continue;
				}
				for (let entry of [...pending.values()]) {
					if (!entry.resumed || entry.batchID != batchID) {
						continue;
					}
					let result = (data.extract_result || []).find(x => x.data_id == entry.job.dataID);
					if (!result || result.state == 'waiting-file') {
						resubmit(entry, `batch ${batchID} has no file for it`);
					}
				}
				for (let result of data.extract_result || []) {
					let entry = pending.get(result.data_id);
					if (!entry || entry.batchID != batchID) {
						continue;
					}
					if (result.state == 'done') {
						pending.delete(result.data_id);
						let parserInfo = { ...info, input: entry.mode, batchID };
						if (entry.mode == 'url') {
							parserInfo.sourceURL = entry.job.sourceURL;
						}
						try {
							batch.onStatus(entry.job, 'downloading');
							await this._downloadResult(entry.job, result);
						}
						catch (e) {
							checkCancelled();
							// Results from before a restart may have expired
							if (entry.resumed) {
								resubmit(entry, e.message);
							}
							else {
								await batch.onFailed(entry.job, e);
							}
							continue;
						}
						await batch.onDone(entry.job, parserInfo);
					}
					else if (result.state == 'failed') {
						await fail(entry, new Error(`MinerU parsing failed: ${result.err_msg || 'unknown error'}`));
					}
					else if (entry.submittedAt) {
						entry.queued = AgentParserBackends.CloudV4.QUEUED_STATES.has(result.state);
						if (!entry.queued && !entry.startedAt) {
							entry.startedAt = Date.now();
						}
						let progress = result.extract_progress;
						batch.onStatus(entry.job, result.state
							+ (progress && progress.total_pages ? ` ${progress.extracted_pages}/${progress.total_pages}` : ''));
					}
				}
			}
			
			for (let entry of [...pending.values()]) {
				if (entry.submittedAt && AgentParserBackends.isTimedOut(entry, entry.submittedAt)) {
					await fail(entry, new Error("Timed out waiting for parse results"));
				}
			}
		}
	}
	
	_chunk(jobs) {
		let chunks = [];
		for (let i = 0; i < jobs.length; i += AgentParserBackends.CloudV4.MAX_BATCH) {
			chunks.push(jobs.slice(i, i + AgentParserBackends.CloudV4.MAX_BATCH));
		}
		return chunks;
	}
	
	isAllowedURL(url) {
		let host;
		try {
			let uri = new URL(url);
			if (uri.protocol != 'https:' && uri.protocol != 'http:') {
				return false;
			}
			host = uri.hostname.toLowerCase();
		}
		catch (e) {
			return false;
		}
		return this.urlHosts.some(x => host == x || host.endsWith('.' + x));
	}
	
	/**
	 * Make sure the URL still serves the same file we have locally
	 *
	 * @return {Promise<String|null>} - Reason the URL can't be used, or null if it can
	 */
	async checkURL(url, fileSize) {
		try {
			let response = await AgentParserHTTP.request('GET', url, {
				headers: { Range: 'bytes=0-1023' },
				timeout: 30000,
				allowErrorStatus: true
			});
			let total;
			if (response.status == 206) {
				total = parseInt((response.headers.get('Content-Range') || '').split('/')[1]);
			}
			else if (response.status == 200) {
				total = parseInt(response.headers.get('Content-Length'));
			}
			else {
				return `HTTP ${response.status}`;
			}
			let reader = response.body.getReader();
			let { value } = await reader.read();
			reader.cancel().catch(() => {});
			if (!value || String.fromCharCode(...value.slice(0, 5)) != '%PDF-') {
				return "not a PDF";
			}
			if (total !== fileSize) {
				return `size ${total} doesn't match local file (${fileSize})`;
			}
			return null;
		}
		catch (e) {
			return e.message || String(e);
		}
	}
	
	async _parseURL(job, url) {
		job.queued = false;
		job.startedAt = null;
		job.onStatus('submitting-url');
		let data = this._check(await AgentParserHTTP.json('POST', this.baseURL + '/extract/task', {
			headers: this._headers(),
			body: JSON.stringify({
				url,
				data_id: job.dataID,
				is_ocr: this.isOCR,
				...this._options()
			})
		}));
		let taskID = data.task_id;
		if (!taskID) {
			throw new Error("MinerU API did not return a task ID");
		}
		Zotero.debug(`Agent Parser: Created MinerU URL task ${taskID}`);
		this._submitted(job, { kind: 'task', id: taskID, mode: 'url' });
		
		let result = await AgentParserBackends.poll(job, async () => {
			let result = this._check(await AgentParserHTTP.json(
				'GET',
				this.baseURL + '/extract/task/' + encodeURIComponent(taskID),
				{ headers: this._headers() }
			));
			return this._handleResult(job, result);
		});
		job.onStatus('downloading');
		await this._downloadResult(job, result);
		return taskID;
	}
	
	async _parseUpload(job) {
		job.queued = false;
		job.startedAt = null;
		job.onStatus('submitting');
		let dataID = job.dataID;
		let data = this._check(await AgentParserHTTP.json('POST', this.baseURL + '/file-urls/batch', {
			headers: this._headers(),
			body: JSON.stringify({
				files: [{
					name: job.uploadName,
					data_id: dataID,
					is_ocr: this.isOCR
				}],
				...this._options()
			})
		}));
		let batchID = data.batch_id;
		let uploadURL = data.file_urls && data.file_urls[0];
		if (!batchID || !uploadURL) {
			throw new Error("MinerU API did not return an upload URL");
		}
		Zotero.debug(`Agent Parser: Created MinerU batch ${batchID}`);
		
		// Presigned URL -- must not send Content-Type or Authorization
		job.onStatus('uploading');
		await AgentParserHTTP.upload(uploadURL, () => AgentParserBackends.readFile(job.filePath), {
			accelerate: this.uploadAcceleration,
			checkCancelled: () => job.checkCancelled()
		});
		this._submitted(job, { kind: 'batch', id: batchID, mode: 'upload' });
		
		let result = await AgentParserBackends.poll(job, async () => {
			let data = this._check(await AgentParserHTTP.json(
				'GET',
				this.baseURL + '/extract-results/batch/' + encodeURIComponent(batchID),
				{ headers: this._headers() }
			));
			let results = data.extract_result || [];
			return this._handleResult(job, results.find(x => x.data_id == dataID) || results[0]);
		});
		job.onStatus('downloading');
		await this._downloadResult(job, result);
		return batchID;
	}
	
	/**
	 * @return {Object|undefined} - The result once it's done, or undefined to keep polling
	 */
	_handleResult(job, result) {
		if (!result) {
			return undefined;
		}
		if (result.state == 'done') {
			return result;
		}
		if (result.state == 'failed') {
			throw new Error(`MinerU parsing failed: ${result.err_msg || 'unknown error'}`);
		}
		job.queued = AgentParserBackends.CloudV4.QUEUED_STATES.has(result.state);
		if (!job.queued && !job.startedAt) {
			job.startedAt = Date.now();
		}
		let progress = result.extract_progress;
		job.onStatus(result.state
			+ (progress && progress.total_pages ? ` ${progress.extracted_pages}/${progress.total_pages}` : ''));
		return undefined;
	}
	
	async _downloadResult(job, result) {
		if (!result.full_zip_url) {
			throw new Error("MinerU result is missing full_zip_url");
		}
		let zipPath = PathUtils.join(job.tempDir, 'result.zip');
		await AgentParserHTTP.download(result.full_zip_url, zipPath);
		await AgentParserOutput.extractZip(zipPath, job.stagingDir);
	}
};
