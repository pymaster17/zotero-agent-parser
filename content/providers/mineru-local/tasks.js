/* global Zotero, AgentParserHTTP, AgentParserOutput, AgentParserProviders, AgentParserMinerULocal */

/**
 * MinerU >= 4 unified Tasks API (POST /v1/tasks), served by `mineru-kit api-server`
 */
AgentParserMinerULocal.Tasks = class {
	static TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'canceled']);
	// File states -> progress phases (see AgentParserProviders.PHASES)
	static PHASES = {
		'waiting-file': 'pending',
		queued: 'pending',
		pending: 'pending',
		uploading: 'uploading',
		completed: 'downloading'
	};

	constructor({ url, apiKey, tier, ocrMode }) {
		this.baseURL = AgentParserProviders.trimURL(url);
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

		job.onStatus('preparing');
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
		task = await AgentParserProviders.poll(job, async () => {
			if (!first) {
				task = await AgentParserHTTP.json('GET', this._taskURL(task.task_id), {
					headers: this._authHeaders()
				});
				this._checkTask(task);
				let status = task.files[0].status || task.status;
				job.onStatus(AgentParserMinerULocal.Tasks.PHASES[status] || 'parsing');
			}
			first = false;

			let file = task.files[0];
			// The server skips the upload if it already has a file with the same hash
			if (!uploaded && file.status == 'waiting-file' && file.upload && file.upload.url) {
				await this._upload(job, file.upload);
				uploaded = true;
			}
			if (AgentParserMinerULocal.Tasks.TERMINAL_STATUSES.has(task.status)) {
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
		await AgentParserHTTP.upload(url, () => AgentParserProviders.readFile(job.filePath), {
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
