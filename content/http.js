/* global Zotero, fetch */

var AgentParserHTTP = {
	DEFAULT_TIMEOUT: 120 * 1000,
	UPLOAD_RETRY_DELAYS: [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000],


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
	 */
	async upload(url, getBody, options = {}) {
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
