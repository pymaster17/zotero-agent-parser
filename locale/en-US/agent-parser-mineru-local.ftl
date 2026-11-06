# Local MinerU provider

agentparser-provider-mineru-local = Local MinerU

agentparser-mineru-local-confirm-library = { $count } PDF(s) will be parsed by local MinerU, one at a time. This takes about a minute per paper at the Standard tier on Apple Silicon (longer at Advanced). Continue?

agentparser-pref-tier = Tier:
agentparser-tier-basic =
    .label = Basic
agentparser-tier-standard =
    .label = Standard (recommended)
agentparser-tier-advanced =
    .label = Advanced
agentparser-tier-desc-basic = Small models only, no VLM. Fastest and lightest on memory, but the lowest quality for formulas and complex layouts.
agentparser-tier-desc-standard = Small layout models plus the MinerU2.5 VLM for text, formulas and tables. About 3.5 s/page (under a minute for a typical paper) on an M4 with MLX.
agentparser-tier-desc-advanced = The VLM also handles page layout. Better on table-heavy and difficult documents, but about 4× slower than Standard (about 13 s/page on an M4).
agentparser-pref-ocr-mode = OCR mode:
agentparser-pref-managed =
    .label = Let Agent Parser install and run MinerU (uncheck to use a server you run yourself)
agentparser-local-env = Environment:
agentparser-local-models = Models:
agentparser-local-server = Server:
agentparser-local-env-ok = MinerU { $version } ({ $engine }) in { $dir }
agentparser-local-env-missing = Not installed
agentparser-local-step-starting = Preparing…
agentparser-local-step-venv = Creating Python environment… ({ $minutes } min)
agentparser-local-step-packages = Installing MinerU and dependencies… ({ $minutes } min)
agentparser-local-step-models = Downloading models… ({ $minutes } min)
agentparser-local-unknown = —
agentparser-local-models-ok = Ready for the { $tier } tier
agentparser-local-models-missing = Missing for the { $tier } tier -- click Install
agentparser-local-server-running = Running (PID { $pid }, { $url })
agentparser-local-server-starting = Starting…
agentparser-local-server-stopped = Not running (starts automatically when needed)
agentparser-local-install =
    .label = Install
agentparser-local-update =
    .label = Update / Repair
agentparser-local-cancel =
    .label = Cancel
agentparser-local-start =
    .label = Start Server
agentparser-local-stop =
    .label = Stop Server
agentparser-local-starting-hint = Starting the local MinerU server (loading models takes a moment)…
agentparser-local-install-confirm = Agent Parser will install MinerU into { $dir } and download its models (about { $size } GB in total). This can take a while. Continue?
agentparser-pref-env-dir = Environment folder:
agentparser-pref-uv-path = uv path:
agentparser-pref-model-source = Model source:
agentparser-pref-port = Port:
agentparser-pref-idle-stop = Stop server after idle (minutes, 0 = never):
agentparser-pref-external-desc = Run `mineru-kit api-server` yourself (on this computer or another one) and enter its address. Enter the API key if you started it with --api-key.
agentparser-pref-api-key = API key:

agentparser-mineru-local-setup-install = Setup needed: local MinerU is not installed
agentparser-mineru-local-setup-installing = Installing local MinerU; parsing starts when done
