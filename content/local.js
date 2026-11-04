/* global Zotero, Services, ChromeUtils, Components, AgentParserHTTP, AgentParserBackends */

/**
 * Local MinerU support, left out of the lite (cloud-only) edition
 *
 * Plugin-managed local MinerU: Python environment, model download and `mineru-kit api-server`
 *
 * The environment is a virtualenv created with uv (or `python3 -m venv` if uv isn't installed).
 * Models go to MinerU's default location (~/.mineru/models), so they're shared with any other
 * MinerU install. The server is started on demand, runs one task at a time (the MLX engine
 * serializes inference anyway), and is stopped after a period of inactivity to free memory.
 */
var AgentParserLocal = {
	MINERU_SPEC: 'mineru>=4.1,<5',
	MLX_SPEC: 'mineru-vl-utils[mlx]',
	PYTHON_VERSION: '3.12',
	LOG_LINES: 300,
	START_TIMEOUT: 10 * 60 * 1000,

	_getPref: null,
	_Subprocess: null,
	// Running install task: { proc, cancelled, step, startedAt }
	_task: null,
	_lastTaskError: null,
	// Server we started: { proc, key, url, pid, exited }
	_server: null,
	_starting: null,
	_active: 0,
	_idleTimer: null,
	_log: [],
	_envInfo: undefined,
	_modelsReady: new Map(),


	init(getPref) {
		this._getPref = getPref;
		({ Subprocess: this._Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs'));
	},


	async shutdown() {
		clearTimeout(this._idleTimer);
		if (this._task) {
			this.cancelInstall();
		}
		await this.stopServer();
	},


	//
	// Configuration
	//
	isManaged() {
		return !!this._getPref('local.managed');
	},


	isAppleSilicon() {
		try {
			return Zotero.isMac && Services.sysinfo.getProperty('arch') == 'aarch64';
		}
		catch (e) {
			return false;
		}
	},


	/**
	 * MinerU picks llama.cpp on Macs by default, but MLX is ~1.5x faster on Apple Silicon
	 */
	getVLMEngine() {
		return this.isAppleSilicon() ? 'mlx' : 'auto';
	},


	getTier() {
		let tier = this._getPref('local.tier');
		return ['basic', 'standard', 'advanced'].includes(tier) ? tier : 'standard';
	},


	/**
	 * Advanced uses the same models as Standard, just more inference per page
	 */
	getModelTier(tier = this.getTier()) {
		return tier == 'basic' ? 'basic' : 'standard';
	},


	getPort() {
		let port = parseInt(this._getPref('local.port'));
		return port > 0 && port < 65536 ? port : 8000;
	},


	getBaseURL() {
		if (this.isManaged()) {
			return `http://127.0.0.1:${this.getPort()}`;
		}
		return (this._getPref('local.url') || '').trim().replace(/\/+$/, '');
	},


	/**
	 * Working directory for MinerU processes, which write uploads and lock files relative to it
	 */
	getDataDir() {
		let home = Services.dirsvc.get('Home', Components.interfaces.nsIFile).path;
		return PathUtils.join(home, '.zotero-agent-parser');
	},
	
	
	getEnvDir() {
		let dir = (this._getPref('local.envDir') || '').trim();
		return dir || PathUtils.join(this.getDataDir(), 'mineru-env');
	},


	_bin(name) {
		let dir = this.getEnvDir();
		return Zotero.isWin
			? PathUtils.join(dir, 'Scripts', name + '.exe')
			: PathUtils.join(dir, 'bin', name);
	},


	/**
	 * Environment for MinerU processes
	 *
	 * GUI apps on macOS don't get the login shell's PATH, so add the usual install locations.
	 */
	_environment() {
		let env = {
			MINERU_MODEL_VLM_ENGINE: this.getVLMEngine(),
			PYTHONUNBUFFERED: '1',
			PYTHONIOENCODING: 'utf-8',
			// English output, which we parse
			LANG: 'en_US.UTF-8',
			LC_ALL: 'en_US.UTF-8',
			// Progress bars are noise in our log
			HF_HUB_DISABLE_PROGRESS_BARS: '1',
			TQDM_DISABLE: '1',
		};
		if (!Zotero.isWin) {
			let home = Services.dirsvc.get('Home', Components.interfaces.nsIFile).path;
			let current = Services.env.get('PATH') || '/usr/bin:/bin:/usr/sbin:/sbin';
			let extra = [
				PathUtils.join(home, '.local', 'bin'),
				PathUtils.join(home, '.cargo', 'bin'),
				'/opt/homebrew/bin',
				'/usr/local/bin',
			].filter(x => !current.split(':').includes(x));
			env.PATH = [...extra, current].join(':');
		}
		return env;
	},


	//
	// Status
	//

	/**
	 * @return {Promise<Object>} - { installed, mineruVersion, mlx, modelsReady, server, task, ... }
	 */
	async getStatus({ refresh = false } = {}) {
		let status = {
			managed: this.isManaged(),
			envDir: this.getEnvDir(),
			engine: this.getVLMEngine(),
			tier: this.getTier(),
			task: this._task ? { step: this._task.step, startedAt: this._task.startedAt } : null,
			lastError: this._lastTaskError,
			server: this._server && !this._server.exited
				? { pid: this._server.pid, url: this._server.url, starting: !!this._starting }
				: null,
			log: this._log.slice(-20),
		};
		if (!status.managed) {
			return status;
		}
		if (refresh || this._envInfo === undefined) {
			this._envInfo = await this._readEnvInfo();
		}
		Object.assign(status, this._envInfo || { installed: false });
		if (status.installed) {
			let modelTier = this.getModelTier();
			if (refresh || !this._modelsReady.has(modelTier)) {
				this._modelsReady.set(modelTier, await this._verifyModels(modelTier));
			}
			status.modelsReady = this._modelsReady.get(modelTier);
		}
		return status;
	},


	async _readEnvInfo() {
		let python = this._bin('python');
		if (!(await IOUtils.exists(python))) {
			return null;
		}
		try {
			let script = 'import importlib.metadata as m\n'
				+ 'def v(n):\n'
				+ '    try: return m.version(n)\n'
				+ '    except Exception: return ""\n'
				+ 'print(v("mineru") + "|" + v("mlx-vlm"))';
			let { exitCode, output } = await this._run(python, ['-c', script], { log: false });
			if (exitCode) {
				return { installed: false };
			}
			let lastLine = output.trim().split('\n').pop();
			let [mineru, mlx] = lastLine.split('|');
			return { installed: !!mineru, mineruVersion: mineru || null, mlxVersion: mlx || null };
		}
		catch (e) {
			Zotero.logError(e);
			return { installed: false };
		}
	},


	async _verifyModels(modelTier) {
		try {
			let { exitCode } = await this._run(this._bin('mineru-kit'), [
				'models', 'verify', '--tier', modelTier, ...this._engineArgs()
			], { log: false });
			return exitCode == 0;
		}
		catch (e) {
			return false;
		}
	},


	_engineArgs() {
		let engine = this.getVLMEngine();
		return engine == 'auto' ? [] : ['--vlm-engine', engine];
	},


	//
	// Install
	//

	/**
	 * Create (or update) the environment and download the models for the selected tier
	 */
	async install() {
		if (this._task) {
			throw new Error("Installation is already running");
		}
		let task = { cancelled: false, step: 'starting', startedAt: Date.now(), proc: null };
		this._task = task;
		this._lastTaskError = null;
		this._log = [];
		try {
			// The server holds files in the environment open
			await this.stopServer();

			let envDir = this.getEnvDir();
			let python = this._bin('python');
			let uv = await this._findUV();
			let packages = [this.MINERU_SPEC];
			if (this.getVLMEngine() == 'mlx') {
				packages.push(this.MLX_SPEC);
			}

			if (!(await IOUtils.exists(python))) {
				task.step = 'venv';
				await IOUtils.makeDirectory(PathUtils.parent(envDir), { createAncestors: true, ignoreExisting: true });
				if (uv) {
					await this._step(task, uv, ['venv', envDir, '--python', this.PYTHON_VERSION, '--seed']);
				}
				else {
					let systemPython = await this._findPython();
					if (!systemPython) {
						throw new Error("Neither uv nor Python 3.11+ was found. Install uv "
							+ "(https://docs.astral.sh/uv/) and try again.");
					}
					await this._step(task, systemPython, ['-m', 'venv', envDir]);
				}
			}

			task.step = 'packages';
			if (uv) {
				await this._step(task, uv, ['pip', 'install', '--python', python, '-U', ...packages]);
			}
			else {
				await this._step(task, python, ['-m', 'pip', 'install', '-U', ...packages]);
			}
			this._envInfo = undefined;

			task.step = 'models';
			let args = ['models', 'download', '--tier', this.getModelTier(), ...this._engineArgs()];
			let source = this._getPref('local.modelSource');
			if (source && source != 'auto') {
				args.push('--source', source);
			}
			await this._step(task, this._bin('mineru-kit'), args);
			this._modelsReady.clear();

			this._appendLog('✔ Done');
		}
		catch (e) {
			if (!task.cancelled) {
				this._lastTaskError = e.message || String(e);
				this._appendLog('✘ ' + this._lastTaskError);
			}
			throw e;
		}
		finally {
			this._task = null;
			this._envInfo = undefined;
			this._modelsReady.clear();
		}
	},


	cancelInstall() {
		if (!this._task) {
			return;
		}
		this._task.cancelled = true;
		this._appendLog('✘ Cancelled');
		this._task.proc?.kill(3000);
	},


	async _step(task, command, args) {
		if (task.cancelled) {
			throw new Error("Cancelled");
		}
		let { exitCode } = await this._run(command, args, {
			onStart: (proc) => {
				task.proc = proc;
			}
		});
		task.proc = null;
		if (task.cancelled) {
			throw new Error("Cancelled");
		}
		if (exitCode) {
			let lastLine = this._log.filter(x => x.trim()).slice(-1)[0] || '';
			throw new Error(`${PathUtils.filename(command)} ${args[0]} failed (exit code ${exitCode}): ${lastLine}`);
		}
	},


	async _findUV() {
		let configured = (this._getPref('local.uvPath') || '').trim();
		if (configured) {
			return configured;
		}
		return this._pathSearch('uv');
	},


	async _findPython() {
		for (let name of ['python3.13', 'python3.12', 'python3.11', 'python3']) {
			let path = await this._pathSearch(name);
			if (!path) {
				continue;
			}
			let { exitCode } = await this._run(path, ['-c',
				'import sys; sys.exit(0 if (3, 11) <= sys.version_info[:2] < (3, 15) else 1)'], { log: false });
			if (!exitCode) {
				return path;
			}
		}
		return null;
	},


	async _pathSearch(name) {
		try {
			return await this._Subprocess.pathSearch(name, this._environment());
		}
		catch (e) {
			return null;
		}
	},


	//
	// Server
	//

	/**
	 * Make sure the server is up before a local job, starting it if necessary
	 *
	 * Callers must call release() when done.
	 */
	async acquire(onStatus) {
		clearTimeout(this._idleTimer);
		this._active++;
		try {
			await this.ensureRunning(onStatus);
		}
		catch (e) {
			this.release();
			throw e;
		}
	},


	release() {
		this._active = Math.max(0, this._active - 1);
		this._scheduleIdleStop();
	},


	_scheduleIdleStop() {
		clearTimeout(this._idleTimer);
		let minutes = parseInt(this._getPref('local.idleStopMinutes'));
		if (!this._server || this._active || !(minutes > 0)) {
			return;
		}
		this._idleTimer = setTimeout(() => {
			if (!this._active) {
				Zotero.debug(`Agent Parser: Stopping idle local MinerU server`);
				this.stopServer();
			}
		}, minutes * 60 * 1000);
	},


	async ensureRunning(onStatus) {
		let url = this.getBaseURL();
		if (!this.isManaged()) {
			if (!url) {
				throw new Error("Local MinerU server URL is not configured");
			}
			return url;
		}

		if (this._starting) {
			return this._starting;
		}
		let key = this._serverKey();
		if (this._server && !this._server.exited) {
			if (this._server.key == key && await this._isHealthy(url)) {
				return url;
			}
			// Settings changed (or the server hung) -- restart. Jobs run one at a time, so nothing
			// else is using it.
			await this.stopServer();
		}
		else if (await this._isHealthy(url)) {
			// Someone else's server on our port (e.g., started by hand) -- use it as is
			Zotero.debug(`Agent Parser: Using existing MinerU server at ${url}`);
			return url;
		}

		this._starting = this._startServer(key, url, onStatus);
		try {
			return await this._starting;
		}
		finally {
			this._starting = null;
		}
	},


	_serverKey() {
		return JSON.stringify([this.getEnvDir(), this.getPort(), this.getTier(), this.getVLMEngine()]);
	},


	async _startServer(key, url, onStatus) {
		if (this._task) {
			throw new Error("Local MinerU is being installed -- try again when it's done");
		}
		let status = await this.getStatus();
		if (!status.installed) {
			throw new Error("Local MinerU is not installed. Install it in the Agent Parser preferences.");
		}
		if (!status.modelsReady) {
			// Recheck in case models were downloaded outside the plugin
			this._modelsReady.delete(this.getModelTier());
			if (!(await this.getStatus()).modelsReady) {
				throw new Error(`Models for the ${this.getTier()} tier are missing. `
					+ "Click Install in the Agent Parser preferences to download them.");
			}
		}

		onStatus?.('starting-server');
		let options = {
			'--host': '127.0.0.1',
			'--port': this.getPort(),
			'--tier': this.getTier(),
			// Inference is serialized, so parallel tasks just compete for memory
			'--concurrency': 1,
			// We download results right away
			'--retention-seconds': 3600,
			// Skip per-request access logs from our polling
			'--log-level': 'warning',
			'--upload-dir': PathUtils.join(this.getDataDir(), 'uploads'),
		};
		let args = [
			'api-server',
			...Object.entries(options).flatMap(([key, value]) => [key, String(value)]),
			// Image analysis rarely helps agents and can loop on diagrams
			'--disable-image-analysis',
			'--preload-models',
		];
		this._appendLog(`$ mineru-kit ${args.join(' ')}`);
		let server = { key, url, exited: false, proc: null, pid: null };
		this._server = server;
		let exitPromise = this._run(this._bin('mineru-kit'), args, {
			onStart: (proc) => {
				server.proc = proc;
				server.pid = proc.pid;
			}
		}).then(({ exitCode }) => {
			server.exited = true;
			this._appendLog(`MinerU server exited (code ${exitCode})`);
			if (this._server == server) {
				this._server = null;
			}
			return exitCode;
		}, (e) => {
			server.exited = true;
			if (this._server == server) {
				this._server = null;
			}
			throw e;
		});

		let deadline = Date.now() + this.START_TIMEOUT;
		while (true) {
			if (server.exited) {
				let exitCode = await exitPromise;
				let lastLines = this._log.filter(x => x.trim()).slice(-3).join(' / ');
				throw new Error(`Local MinerU server exited during startup (code ${exitCode}): ${lastLines}`);
			}
			if (await this._isHealthy(url)) {
				Zotero.debug(`Agent Parser: Local MinerU server ready at ${url}`);
				this._scheduleIdleStop();
				return url;
			}
			if (Date.now() > deadline) {
				await this.stopServer();
				throw new Error("Timed out waiting for the local MinerU server to start");
			}
			await AgentParserHTTP.sleep(1000);
		}
	},


	async _isHealthy(url) {
		try {
			let response = await AgentParserHTTP.request('GET', url + '/v1/health', {
				timeout: 3000,
				allowErrorStatus: true,
				quiet: true
			});
			return response.ok;
		}
		catch (e) {
			return false;
		}
	},


	async stopServer() {
		clearTimeout(this._idleTimer);
		let server = this._server;
		if (!server || server.exited || !server.proc) {
			return;
		}
		this._appendLog('Stopping MinerU server');
		try {
			// SIGTERM, then SIGKILL after the timeout. Uvicorn shuts down its workers on SIGTERM.
			await server.proc.kill(10000);
		}
		catch (e) {
			Zotero.logError(e);
		}
		if (this._server == server) {
			this._server = null;
		}
	},


	//
	// Processes
	//

	/**
	 * Run a command, collecting combined stdout/stderr
	 *
	 * @return {Promise<{ exitCode: Number, output: String }>}
	 */
	async _run(command, args, { log = true, onStart } = {}) {
		if (log) {
			this._appendLog(`$ ${PathUtils.filename(command)} ${args.join(' ')}`);
		}
		// Zotero's own working directory may not be writable
		let workdir = this.getDataDir();
		await IOUtils.makeDirectory(workdir, { createAncestors: true, ignoreExisting: true });
		let proc = await this._Subprocess.call({
			command,
			arguments: args,
			workdir,
			environment: this._environment(),
			environmentAppend: true,
			stderr: 'stdout',
		});
		onStart?.(proc);
		let output = '';
		let partial = '';
		let str;
		// The pipe must be drained continuously, or the process blocks once it fills up
		while ((str = await proc.stdout.readString())) {
			if (!log) {
				output += str;
				continue;
			}
			partial += str;
			let lines = partial.split(/\r\n|\r|\n/);
			partial = lines.pop();
			for (let line of lines) {
				this._appendLog(line);
			}
		}
		if (log && partial) {
			this._appendLog(partial);
		}
		let { exitCode } = await proc.wait();
		return { exitCode, output };
	},


	_appendLog(line) {
		line = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
		if (!line) {
			return;
		}
		this._log.push(line);
		if (this._log.length > this.LOG_LINES) {
			this._log.splice(0, this._log.length - this.LOG_LINES);
		}
		Zotero.debug('Agent Parser [MinerU]: ' + line, 5);
	}
};


/**
 * Local MinerU via the Tasks API
 *
 * By default the plugin manages the server itself (see local.js) and starts it on demand. It can
 * also point at a server the user runs, on this computer or elsewhere.
 */
AgentParserBackends.Local = class extends AgentParserBackends.Tasks {
	constructor(getPref) {
		super({
			url: AgentParserLocal.getBaseURL(),
			apiKey: AgentParserLocal.isManaged() ? '' : getPref('local.apiKey'),
			tier: AgentParserLocal.getTier(),
			ocrMode: getPref('local.ocrMode'),
		});
		this.serviceName = 'mineru-local';
	}
	
	async test() {
		await AgentParserLocal.acquire();
		try {
			return await super.test();
		}
		finally {
			AgentParserLocal.release();
		}
	}
	
	async parse(job) {
		await AgentParserLocal.acquire(status => job.onStatus(status));
		try {
			return await super.parse(job);
		}
		finally {
			AgentParserLocal.release();
		}
	}
};
