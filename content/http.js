/* global Zotero, fetch */

var AgentParserHTTP = {
	DEFAULT_TIMEOUT: 120 * 1000,
	UPLOAD_RETRY_DELAYS: [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000],
	// A direct connection to a storage host this fast doesn't need the accelerated endpoint
	ACCELERATE_DIRECT_MAX_MS: 300,
	ACCELERATE_TIMEOUT: 10 * 60 * 1000,
	// Per storage host: whether to use its accelerated endpoint (or a promise for it), decided
	// once per session
	_accelerate: new Map(),


	/**
	 * Thin wrapper around fetch() with timeouts and readable errors
	 *
	 * We use fetch() instead of Zotero.HTTP.request() because the latter forces a Content-Type
	 * on requests with a body, which breaks presigned upload URLs.
	 *
	 * @param {String} method
	 * @param {String} url
	 * @param {Object} [options]
	 * @param {Object} [options.headers]
	 * @param {*} [options.body]
	 * @param {Number} [options.timeout] - Milliseconds
	 * @param {Boolean} [options.allowErrorStatus] - Return the response instead of throwing on >= 400
	 * @param {Boolean} [options.quiet] - Don't log the request (e.g., for health checks)
	 * @return {Promise<Response>}
	 */
	async request(method, url, options = {}) {
		let timeout = options.timeout || this.DEFAULT_TIMEOUT;
		let controller = typeof AbortController != 'undefined' ? new AbortController() : null;
		let timer;
		let timeoutPromise = new Promise((resolve, reject) => {
			timer = setTimeout(() => {
				controller?.abort();
				let err = new Error(`${method} ${this.displayURL(url)} timed out after ${Math.round(timeout / 1000)}s`);
				err.isTimeout = true;
				reject(err);
			}, timeout);
		});

		if (!options.quiet) {
			Zotero.debug(`Agent Parser: ${method} ${this.displayURL(url)}`);
		}
		let response;
		try {
			response = await Promise.race([
				fetch(url, {
					method,
					headers: options.headers || {},
					body: options.body,
					redirect: 'follow',
					credentials: 'omit',
					cache: 'no-store',
					signal: controller?.signal,
				}),
				timeoutPromise
			]);
		}
		catch (e) {
			if (e instanceof TypeError) {
				let err = new Error(`Could not connect to ${this.displayURL(url)}: ${e.message}`);
				err.isNetworkError = true;
				throw err;
			}
			throw e;
		}
		finally {
			clearTimeout(timer);
		}

		if (response.status >= 400 && !options.allowErrorStatus) {
			let text = '';
			try {
				text = await response.text();
			}
			catch (e) {}
			throw new AgentParserHTTP.HTTPError(method, url, response.status, text);
		}
		return response;
	},


	async json(method, url, options = {}) {
		let response = await this.request(method, url, options);
		let text = await response.text();
		try {
			return JSON.parse(text);
		}
		catch (e) {
			throw new Error(`Invalid JSON from ${this.displayURL(url)}: ${text.substr(0, 200)}`);
		}
	},


	/**
	 * Download a URL to a local file
	 */
	async download(url, path, options = {}) {
		let response = await this.request('GET', url, {
			timeout: 30 * 60 * 1000,
			...options
		});
		let buf = await response.arrayBuffer();
		await IOUtils.write(path, new Uint8Array(buf));
		return response;
	},


	/**
	 * PUT a file, retrying if the connection drops
	 *
	 * Uploads to cloud storage can take a long time and occasionally get cut off. HTTP errors
	 * (e.g., an expired presigned URL) aren't retried.
	 *
	 * @param {Function} getBody - Returns the request body, read again for each attempt
	 * @param {Object} [options]
	 * @param {String} [options.accelerate] - 'auto', 'always', or 'off' (default): whether to
	 *     try the storage service's accelerated endpoint first. See acceleratedURL().
	 */
	async upload(url, getBody, options = {}) {
		let fastURL = await this._chooseAcceleratedURL(url, options.accelerate);
		if (fastURL) {
			try {
				return await this.request('PUT', fastURL, {
					timeout: this.ACCELERATE_TIMEOUT,
					...options,
					body: await getBody()
				});
			}
			catch (e) {
				// A refusal (e.g., acceleration turned off for the bucket) will happen every time
				if (e.status >= 400 && e.status < 500) {
					this._accelerate.set(new URL(url).host, false);
				}
				Zotero.debug(`Agent Parser: Accelerated upload failed (${e.message}) -- `
					+ `uploading to ${this.displayURL(url)} instead`);
				options.checkCancelled?.();
			}
		}
		
		let delays = options.retryDelays || this.UPLOAD_RETRY_DELAYS;
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.request('PUT', url, {
					timeout: 30 * 60 * 1000,
					...options,
					body: await getBody()
				});
			}
			catch (e) {
				if (!e.isNetworkError || attempt >= delays.length) {
					throw e;
				}
				Zotero.debug(`Agent Parser: Upload to ${this.displayURL(url)} failed (${e.message}) -- `
					+ `retrying in ${delays[attempt] / 1000}s`);
				await this.sleep(delays[attempt]);
				options.checkCancelled?.();
			}
		}
	},


	/**
	 * Presigned Alibaba Cloud OSS URL on the bucket's transfer acceleration endpoint
	 *
	 * Uploads from outside mainland China to a bucket in China cross congested international
	 * links and can crawl along at a few KB/s. The accelerated endpoint enters Alibaba's network
	 * nearby instead. V1 signatures don't cover the host, so the same presigned URL works there,
	 * as long as the bucket has acceleration turned on.
	 *
	 * @return {String|null} - Null if the URL isn't a V1-signed OSS URL on a regional endpoint
	 */
	acceleratedURL(url) {
		let parsed;
		try {
			parsed = new URL(url);
		}
		catch (e) {
			return null;
		}
		let match = parsed.host.match(/^([a-z0-9][a-z0-9-]*)\.oss-([a-z0-9-]+)\.aliyuncs\.com$/);
		if (!match || match[2].startsWith('accelerate')
				|| !parsed.searchParams.has('Signature') || parsed.searchParams.has('x-oss-signature-version')) {
			return null;
		}
		parsed.host = `${match[1]}.oss-accelerate.aliyuncs.com`;
		return parsed.href;
	},


	async _chooseAcceleratedURL(url, mode) {
		let fastURL = mode == 'auto' || mode == 'always' ? this.acceleratedURL(url) : null;
		if (!fastURL || mode == 'always') {
			return fastURL;
		}
		let host = new URL(url).host;
		// Store the promise, so that uploads starting together share one check
		if (!this._accelerate.has(host)) {
			this._accelerate.set(host, this._isFastHost(host).then((fast) => {
				Zotero.debug(`Agent Parser: ${fast ? 'Not using' : 'Using'} accelerated uploads for ${host}`);
				return !fast;
			}));
		}
		return (await this._accelerate.get(host)) ? fastURL : null;
	},


	/**
	 * Whether a request to the host's root (which storage services answer with an error right
	 * away) completes quickly, including the TLS handshake
	 */
	async _isFastHost(host) {
		let start = Date.now();
		try {
			await this.request('HEAD', `https://${host}/`, {
				timeout: 10 * 1000,
				allowErrorStatus: true,
				quiet: true
			});
		}
		catch (e) {
			return false;
		}
		return Date.now() - start <= this.ACCELERATE_DIRECT_MAX_MS;
	},


	isSameOrigin(a, b) {
		try {
			return new URL(a).origin == new URL(b).origin;
		}
		catch (e) {
			return false;
		}
	},


	/**
	 * Strip query strings, which can contain signatures for presigned URLs
	 */
	displayURL(url) {
		return String(url).replace(/\?.*$/, '?…');
	},


	/**
	 * Whether a request might succeed if tried again later
	 */
	isTransientError(e) {
		return !!e && (e.isNetworkError || e.isTimeout || e.status >= 500);
	},


	sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
};


AgentParserHTTP.HTTPError = class extends Error {
	constructor(method, url, status, text) {
		let detail = text;
		try {
			let json = JSON.parse(text);
			let err = json.error || json;
			detail = err.message || err.msg || err.detail || text;
			if (typeof detail != 'string') {
				detail = JSON.stringify(detail);
			}
		}
		catch (e) {}
		super(`HTTP ${status} from ${method} ${AgentParserHTTP.displayURL(url)}`
			+ (detail ? `: ${String(detail).substr(0, 500)}` : ''));
		this.name = 'HTTPError';
		this.status = status;
	}
};
