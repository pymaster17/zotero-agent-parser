/* global Zotero, AgentParserHTTP, AgentParserOutput, AgentParserProviders */

/**
 * MinerU cloud service (mineru.net v4 API)
 */
var AgentParserMinerUCloud = {};


/**
 * mineru.net v4 API (precise parsing)
 *
 * PDFs saved from an allowlisted host (e.g., arxiv.org) are submitted by URL so that MinerU
 * downloads them itself, which avoids slow uploads. Everything else, and any URL submission that
 * fails, is uploaded from the local file.
 *
 * https://mineru.net/apiManage/docs
 */
AgentParserMinerUCloud.Backend = class {
	static MAX_BATCH = 50;
	// The API rejects longer and larger files
	static MAX_PAGES = 200;
	static MAX_FILE_SIZE = 200 * 1024 * 1024;
	// -60009: submission queue is full, -60018: daily task limit reached
	static BUSY_CODES = new Set([-60009, -60018]);
	// -60005: file too large, -60006: too many pages. Trying again won't help.
	static LIMIT_CODES = new Set([-60005, -60006]);
	// States before the server starts working on a file
	static QUEUED_STATES = new Set(['waiting-file', 'pending']);
	// Server states -> progress phases (see AgentParserProviders.PHASES)
	static PHASES = {
		'waiting-file': 'pending',
		pending: 'pending',
		running: 'parsing',
		converting: 'parsing',
		done: 'downloading'
	};
	
	/**
	 * Whether the service refused new work for now, in which case the file should go back in the
	 * queue rather than fail
	 */
	static isBusy(e) {
		return !!e && AgentParserMinerUCloud.Backend.BUSY_CODES.has(e.code);
	}
	
	/**
	 * @return {Array} - [phase, detail] for a result's state
	 */
	static phaseOf(result) {
		let progress = result.extract_progress;
		return [
			AgentParserMinerUCloud.Backend.PHASES[result.state] || 'parsing',
			progress && progress.total_pages ? `${progress.extracted_pages}/${progress.total_pages}` : null
		];
	}
	
	// Submissions older than this aren't resumed after a restart, since the service may have
	// discarded them
	static RESUME_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
	
	/**
	 * @param {Function} getPref - This provider's prefs
	 * @param {Object} [variant] - { model, ocr } to use instead of the configured model and OCR
	 *     setting (see getFallback())
	 */
	constructor(getPref, variant = null) {
		this.baseURL = AgentParserProviders.trimURL(getPref('url'));
		this.token = (getPref('token') || '').trim();
		this.modelVersion = variant?.model || getPref('modelVersion') || 'vlm';
		this.isOCR = typeof variant?.ocr == 'boolean' ? variant.ocr : !!getPref('isOCR');
		this.enableFormula = !!getPref('enableFormula');
		this.enableTable = !!getPref('enableTable');
		this.language = getPref('language') || 'ch';
		this.uploadAcceleration = getPref('uploadAcceleration') || 'auto';
		this.urlHosts = AgentParserProviders.parseHosts(getPref('urlHosts'));
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
			e.limitExceeded = AgentParserMinerUCloud.Backend.LIMIT_CODES.has(e.code);
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
					if (AgentParserMinerUCloud.Backend.isBusy(e)) {
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
			&& Date.now() - remote.submittedAt < AgentParserMinerUCloud.Backend.RESUME_MAX_AGE;
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
		let result = await AgentParserProviders.poll(job, async () => {
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
				batch.onStatus(job, 'pending');
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
					if (!AgentParserMinerUCloud.Backend.isBusy(e)) {
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
							await AgentParserHTTP.upload(url, () => AgentParserProviders.readFile(job.filePath), {
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
				batch.onStatus(job, 'preparing');
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
				if (AgentParserMinerUCloud.Backend.isBusy(e)) {
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
						entry.queued = AgentParserMinerUCloud.Backend.QUEUED_STATES.has(result.state);
						if (!entry.queued && !entry.startedAt) {
							entry.startedAt = Date.now();
						}
						batch.onStatus(entry.job, ...AgentParserMinerUCloud.Backend.phaseOf(result));
					}
				}
			}
			
			for (let entry of [...pending.values()]) {
				if (entry.submittedAt && AgentParserProviders.isTimedOut(entry, entry.submittedAt)) {
					await fail(entry, new Error("Timed out waiting for parse results"));
				}
			}
		}
	}
	
	_chunk(jobs) {
		let chunks = [];
		for (let i = 0; i < jobs.length; i += AgentParserMinerUCloud.Backend.MAX_BATCH) {
			chunks.push(jobs.slice(i, i + AgentParserMinerUCloud.Backend.MAX_BATCH));
		}
		return chunks;
	}
	
	isAllowedURL(url) {
		return AgentParserProviders.isAllowedURL(url, this.urlHosts);
	}
	
	checkURL(url, fileSize) {
		return AgentParserProviders.checkURL(url, fileSize);
	}
	
	async _parseURL(job, url) {
		job.queued = false;
		job.startedAt = null;
		job.onStatus('preparing');
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
		
		let result = await AgentParserProviders.poll(job, async () => {
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
		job.onStatus('preparing');
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
		await AgentParserHTTP.upload(uploadURL, () => AgentParserProviders.readFile(job.filePath), {
			accelerate: this.uploadAcceleration,
			checkCancelled: () => job.checkCancelled()
		});
		this._submitted(job, { kind: 'batch', id: batchID, mode: 'upload' });
		
		let result = await AgentParserProviders.poll(job, async () => {
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
		job.queued = AgentParserMinerUCloud.Backend.QUEUED_STATES.has(result.state);
		if (!job.queued && !job.startedAt) {
			job.startedAt = Date.now();
		}
		job.onStatus(...AgentParserMinerUCloud.Backend.phaseOf(result));
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


AgentParserProviders.register({
	apiVersion: 1,
	id: 'mineru-cloud',
	kind: 'cloud',
	ftl: 'agent-parser-mineru-cloud.ftl',
	l10n: {
		name: 'agentparser-provider-mineru-cloud',
		confirmBulk: 'agentparser-mineru-cloud-confirm-library'
	},
	defaultPrefs: {
		url: 'https://mineru.net/api/v4',
		token: '',
		modelVersion: 'vlm',
		isOCR: false,
		enableFormula: true,
		enableTable: true,
		language: 'ch',
		// "auto", "always", or "off": upload through the storage service's accelerated endpoint
		uploadAcceleration: 'auto',
		// Hosts whose PDFs are submitted by URL instead of being uploaded
		urlHosts: 'arxiv.org, aclanthology.org, isca-archive.org, jmlr.org, openaccess.thecvf.com, '
			+ 'proceedings.iclr.cc, proceedings.mlr.press, proceedings.neurips.cc',
		concurrency: '4'
	},
	legacy: {
		ids: ['cloudV4', 'cloud'],
		prefs: {
			'cloudV4.url': 'url',
			'cloudV4.token': 'token',
			'cloudV4.modelVersion': 'modelVersion',
			'cloudV4.isOCR': 'isOCR',
			'cloudV4.enableFormula': 'enableFormula',
			'cloudV4.enableTable': 'enableTable',
			'cloudV4.language': 'language',
			'cloudV4.uploadAcceleration': 'uploadAcceleration',
			'cloudV4.urlHosts': 'urlHosts',
			concurrency: 'concurrency'
		}
	},
	limits: {
		maxPages: AgentParserMinerUCloud.Backend.MAX_PAGES,
		maxFileSize: AgentParserMinerUCloud.Backend.MAX_FILE_SIZE
	},
	maxBatch: AgentParserMinerUCloud.Backend.MAX_BATCH,
	settings: {
		fragment: 'content/providers/mineru-cloud/settings.xhtml',
		script: 'content/providers/mineru-cloud/settings.js'
	},


	getConcurrency(ctx) {
		let value = parseInt(ctx.getPref('concurrency'));
		return value > 0 ? value : 1;
	},


	getSetupIssue(ctx) {
		if (!(ctx.getPref('token') || '').trim()) {
			return { l10nID: 'agentparser-mineru-cloud-setup-token' };
		}
		return null;
	},


	classifyError(e) {
		if (AgentParserMinerUCloud.Backend.isBusy(e)) {
			return 'busy';
		}
		if (e && AgentParserMinerUCloud.Backend.LIMIT_CODES.has(e.code)) {
			return 'limit';
		}
		return 'error';
	},


	/**
	 * Choose how to parse a file again after its output repeated itself
	 *
	 * Parsing again the same way doesn't help, since the service produces the same output for
	 * the same file. Without OCR, the "vlm" model (actually MinerU's hybrid backend) takes text
	 * from the PDF's text layer and reads inline formulas with a small formula model, which is
	 * where most loops come from -- and the pipeline model uses that same formula model. With
	 * OCR, the VLM reads whole lines, formulas included. If that still loops, the pipeline model's
	 * separate layout, OCR, and table models are the last resort.
	 */
	getFallback(parserInfo) {
		if (parserInfo.modelVersion != 'vlm') {
			return null;
		}
		if (!parserInfo.isOCR) {
			return { variant: { model: 'vlm', ocr: true }, description: 'the vlm model and OCR' };
		}
		return { variant: { model: 'pipeline', ocr: null }, description: 'the pipeline model' };
	},


	describe(parserInfo) {
		return (parserInfo.modelVersion || 'default') + (parserInfo.isOCR ? '+ocr' : '');
	},


	frontMatter(parserInfo) {
		return {
			model: parserInfo.modelVersion,
			ocr: parserInfo.isOCR || null,
			input: parserInfo.input,
			source_url: parserInfo.input == 'url' ? parserInfo.sourceURL : null
		};
	},


	create(ctx, variant) {
		return new AgentParserMinerUCloud.Backend(ctx.getPref, variant);
	}
});
