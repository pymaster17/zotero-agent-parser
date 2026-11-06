agentparser-name = Agent Parser

agentparser-menu-parse =
    .label = Parse PDF for Agents
agentparser-menu-reparse =
    .label = Force Re-parse PDF
agentparser-menu-parse-cloud =
    .label = Re-parse PDF with Cloud Service
agentparser-menu-parse-local =
    .label = Re-parse PDF with Local MinerU
agentparser-menu-reveal =
    .label = Show Parse Results
agentparser-menu-parse-library =
    .label = Parse All Unparsed PDFs in Library…

agentparser-notify-success = PDF parsed
agentparser-notify-failure = PDF parsing failed
agentparser-notify-batch = Batch parsing finished
agentparser-notify-batch-result = { $done } succeeded, { $failed } failed (see the Error Console for details)
agentparser-notify-queued = Added { $count } PDF(s) to the parse queue
agentparser-alert-not-parsed = The selected items have not been parsed yet.
agentparser-alert-library-done = All PDFs in this library have already been parsed.
agentparser-confirm-library = { $count } PDF(s) will be sent to the cloud service, which uses parsing quota. Continue?
agentparser-confirm-library-local = { $count } PDF(s) will be parsed by local MinerU, one at a time. This takes about a minute per paper at the Standard tier on Apple Silicon (longer at Advanced). Continue?

agentparser-pref-mode = Parsing Service
agentparser-mode-cloud =
    .label = Cloud (mineru.net)
agentparser-mode-local =
    .label = Local (MinerU on this computer)
agentparser-pref-mode-desc = New items are parsed with the service chosen here. You can also re-parse selected items with a specific service from the item context menu.
agentparser-pref-bulk-cloud =
    .label = In local mode, parse large requests (whole library, multiple selected items) with the cloud batch API
agentparser-warn-no-token = Enter a cloud API token below, or switch to local parsing.
agentparser-warn-no-token-lite = Enter a cloud API token below to start parsing.
agentparser-warn-bulk-no-token = No cloud API token is configured, so large requests will also be parsed locally.

agentparser-pref-cloud = Cloud
agentparser-pref-cloud-desc = Create a token on the mineru.net API management page. Files are limited to 200 MB / 200 pages.
agentparser-pref-lite-desc = This is the lite edition, which only uses the cloud service. To parse on this computer with MinerU, install the full edition instead -- your settings carry over.
agentparser-pref-token = API token:
agentparser-pref-model-version = Model version:
agentparser-pref-language = Document language:
agentparser-pref-url-hosts = Submit by URL for:
agentparser-pref-url-hosts-desc = PDFs saved from these hosts (comma-separated, including subdomains) are submitted to MinerU by URL instead of being uploaded. If the URL doesn't work or serves a different file, the local file is uploaded instead.
agentparser-pref-upload-acceleration = Upload acceleration:
agentparser-upload-acceleration-auto =
    .label = Automatic
agentparser-upload-acceleration-always =
    .label = Always
agentparser-upload-acceleration-off =
    .label = Off
agentparser-pref-upload-acceleration-desc = MinerU stores uploaded files in Shanghai. Outside mainland China, uploading through Alibaba Cloud's transfer acceleration endpoint is usually much faster. Automatic checks the direct connection first and skips acceleration if it's already fast. If an accelerated upload fails, the file is uploaded to the original address instead.
agentparser-pref-concurrency = Concurrent jobs:
agentparser-pref-url = URL:
agentparser-pref-force-ocr =
    .label = Force OCR
agentparser-pref-formula =
    .label = Recognize formulas
agentparser-pref-table =
    .label = Recognize tables
agentparser-pref-test =
    .label = Test Connection

agentparser-pref-local = Local
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

agentparser-pref-general = General
agentparser-pref-auto-parse =
    .label = Automatically parse PDFs when new items are added
agentparser-pref-skip-synced =
    .label = Skip items downloaded via sync (the computer that added them parses them)
agentparser-pref-include-linked =
    .label = Also parse linked files (results go next to the PDF and aren't synced by Zotero)
agentparser-pref-notifications =
    .label = Show a notification when parsing finishes or fails
agentparser-pref-timeout = Parse timeout (minutes, from when the service starts on the file):
agentparser-pref-wait-file = Wait for PDF download (minutes):

agentparser-pref-output = Output
agentparser-pref-output-desc = Results are saved in the attachment's storage directory (storage/<attachment key>/<folder name>/) and contain only full.md and images/. The YAML front matter in full.md records the title, authors, DOI, Zotero link and a hash of the source PDF. WebDAV file sync uploads the whole directory; Zotero Storage only uploads the PDF itself.
agentparser-pref-dir-name = Output folder name:
agentparser-pref-success-tag = Tag to add after parsing:
agentparser-pref-mark-sync =
    .label = Mark the attachment for upload after parsing so WebDAV syncs the results to other computers

agentparser-pref-queue = Queue
agentparser-pref-queue-status = { $queued } queued, { $running } running{ $details }
agentparser-pref-clear-queue =
    .label = Clear Queue

## Status UI

agentparser-section-header =
    .label = Agent Parsing
agentparser-section-sidenav =
    .tooltiptext = Agent Parsing

agentparser-state-done = Parsed
agentparser-state-failed = Parsing failed
agentparser-state-running = Parsing
agentparser-state-queued = Queued
agentparser-state-setup = Waiting for setup
agentparser-state-none = Not parsed
agentparser-state-none-desc = New PDFs are parsed automatically. Click “Parse” for existing ones.
agentparser-state-none-desc-paused = Automatic parsing is turned off.

agentparser-status-setup = Starts once setup is complete
agentparser-status-queued = Waiting for a free slot
agentparser-status-deferred = Service busy, retrying later
agentparser-status-waiting-file = Waiting for the PDF to download
agentparser-status-preparing = Preparing
agentparser-status-pending = Queued on the server
agentparser-status-uploading = Uploading
agentparser-status-parsing = Parsing
agentparser-status-saving = Saving results
agentparser-service-cloud = Cloud
agentparser-service-local = Local

agentparser-action-open-settings = Open Settings
agentparser-action-retry = Retry
agentparser-action-retry-cloud = Retry with Cloud
agentparser-action-retry-local = Retry Locally
agentparser-action-parse = Parse
agentparser-action-open = Open Markdown
agentparser-action-reveal = Show in Folder
agentparser-action-reparse = Reparse

agentparser-setup-token = Setup needed: no cloud API token
agentparser-setup-local = Setup needed: local MinerU is not installed
agentparser-setup-local-installing = Installing local MinerU; parsing starts when done
agentparser-summary-running = Parsing { $running }, { $queued } queued
agentparser-summary-deferred = Service busy; { $queued } PDF(s) will be retried later
agentparser-summary-failed = { $failed ->
        [one] 1 PDF failed to parse
       *[other] { $failed } PDFs failed to parse
    }
agentparser-summary-paused = Automatic parsing is off
agentparser-summary-idle = Automatic parsing is on, nothing pending

agentparser-setup-token-button =
    .tooltiptext = Agent Parser — Setup needed: no cloud API token
agentparser-setup-local-button =
    .tooltiptext = Agent Parser — Setup needed: local MinerU is not installed
agentparser-setup-local-installing-button =
    .tooltiptext = Agent Parser — Installing local MinerU
agentparser-summary-running-button =
    .tooltiptext = Agent Parser — Parsing { $running }, { $queued } queued
agentparser-summary-deferred-button =
    .tooltiptext = Agent Parser — Service busy, retrying later
agentparser-summary-failed-button =
    .tooltiptext = Agent Parser — { $failed } failed, click for details
agentparser-summary-paused-button =
    .tooltiptext = Agent Parser — Automatic parsing is off
agentparser-summary-idle-button =
    .tooltiptext = Agent Parser — All good

agentparser-menu-finish-setup = Finish Setup…
agentparser-menu-more = { $count } more…
agentparser-menu-queued = { $count } queued{ $blocked ->
        [0] {""}
       *[other] { "" } ({ $blocked } waiting for setup)
    }{ $deferred ->
        [0] {""}
       *[other] { "" } ({ $deferred } retrying later)
    }
agentparser-menu-failures = Failed ({ $count })
agentparser-menu-retry-failed = Retry All Failed
agentparser-menu-clear-failures = Clear Failures
agentparser-menu-auto-parse = Parse New Items Automatically
agentparser-menu-parse-library-short = Parse All Unparsed PDFs in Library…
agentparser-menu-clear-queue = Clear Queue
agentparser-menu-settings = Agent Parser Settings…

agentparser-notify-setup = Agent Parser needs setup
agentparser-notify-setup-hint = New PDFs are queued and will be parsed once setup is complete. Click the Agent Parser icon in the toolbar or open the settings.
agentparser-notify-failure-hint = Retry from the Agent Parser toolbar icon or the item’s “Agent Parsing” section.
agentparser-error-no-file = The PDF file is missing or didn’t finish downloading
agentparser-error-too-many-pages = The PDF has { $pages } pages, more than the service accepts ({ $max })

agentparser-pref-status = Status
agentparser-pref-status-ok = Setup complete. New PDFs are parsed automatically.
agentparser-pref-status-paused = Setup complete, but automatic parsing is off
agentparser-pref-failures = { $count } failed
agentparser-pref-retry-failed =
    .label = Retry Failed
agentparser-pref-clear-failures =
    .label = Clear Failures
agentparser-pref-columns-hint = Tip: right-click the item list’s column header and check “Agent Parser” to see each item’s parse status.
agentparser-pref-finish-setup =
    .label = Finish Setup

agentparser-state-limit = Over service limits
agentparser-limit-desc = The cloud service doesn’t accept this file, so retrying would fail too. Parse it with local MinerU instead, or split the PDF.
agentparser-limit-desc-lite = The service doesn’t accept this file, so retrying would fail too. Split the PDF, or install the full edition to parse it with local MinerU.
agentparser-action-parse-local = Parse with Local MinerU
agentparser-error-too-large = The PDF is { $size } MB, more than the service accepts ({ $max } MB)
agentparser-menu-limit-hint = { $count } over cloud limits, not retried (parse them locally from the item’s “Agent Parsing” section)
agentparser-menu-limit-hint-lite = { $count } over service limits, not retried (split the PDF)
agentparser-notify-limit-hint = Retrying would fail too. Parse it with local MinerU from the item’s “Agent Parsing” section, or split the PDF.
agentparser-notify-limit-hint-lite = Retrying would fail too. Split the PDF, or install the full edition to parse it with local MinerU.
