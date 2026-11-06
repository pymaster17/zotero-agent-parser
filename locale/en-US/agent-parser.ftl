agentparser-name = Agent Parser

agentparser-menu-parse =
    .label = Parse PDF for Agents
agentparser-menu-reparse =
    .label = Force Re-parse PDF
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
agentparser-pref-mode = Parsing Service
agentparser-pref-url = URL:
agentparser-pref-concurrency = Concurrent jobs:
agentparser-pref-test =
    .label = Test Connection

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
agentparser-action-open-settings = Open Settings
agentparser-action-retry = Retry
agentparser-action-parse = Parse
agentparser-action-open = Open Markdown
agentparser-action-reveal = Show in Folder
agentparser-action-reparse = Reparse

agentparser-menu-more = { $count } more…
agentparser-menu-failures = Failed ({ $count })
agentparser-notify-setup = Agent Parser needs setup
agentparser-notify-setup-hint = New PDFs are queued and will be parsed once setup is complete. Click the Agent Parser icon in the toolbar or open the settings.
agentparser-notify-failure-hint = Retry from the item’s “Agent Parsing” section.
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
agentparser-error-too-large = The PDF is { $size } MB, more than the service accepts ({ $max } MB)
agentparser-light-busy-button =
    .tooltiptext = Agent Parser — Parsing { $running }, { $queued } queued
agentparser-light-error-button =
    .tooltiptext = Agent Parser — { $failed } failed, click for details
agentparser-light-ok-button =
    .tooltiptext = Agent Parser — Nothing to parse
agentparser-light-ok-paused-button =
    .tooltiptext = Agent Parser — Nothing to parse (automatic parsing is off)
agentparser-light-ok = New PDFs are parsed automatically.
agentparser-light-ok-paused = Automatic parsing is off. You can turn it on in the settings.
agentparser-panel-ok = Nothing to parse
agentparser-panel-busy = Parsing
agentparser-panel-error = Needs attention
agentparser-panel-open-settings = Open Settings
agentparser-panel-counts = { $running } running · { $queued } queued{ $deferred ->
        [0] {""}
       *[other] { "" } ({ $deferred } retrying later)
    }{ $blocked ->
        [0] {""}
       *[other] { "" } ({ $blocked } waiting for setup)
    }
agentparser-panel-failure-hint = Click a file to find it in the item list, then retry from the “Agent Parsing” section. Failures can also be cleared in the settings.

## Parsing services

agentparser-pref-mode-desc = New items are parsed with the service chosen here. You can also reparse items with a specific service from the item context menu.
agentparser-pref-single-provider-desc = Only one parsing service is available. You can add services you run yourself under Custom Parsing Services below.
agentparser-pref-bulk-provider = Large requests (whole library, multiple items) use:
agentparser-pref-bulk-provider-default =
    .label = The default service
agentparser-pref-bulk-not-ready = { $provider } isn’t set up yet, so large requests use the default service for now.
agentparser-confirm-library = { $count } PDFs will be queued for parsing. Continue?
agentparser-menu-parse-with =
    .label = Reparse PDF with { $provider }
agentparser-action-retry-with = Retry with { $provider }
agentparser-action-parse-with = Parse with { $provider }
agentparser-limit-desc = This service doesn’t accept the file, so retrying would fail too. Parse it with another service, or split the PDF.
agentparser-limit-desc-single = The service doesn’t accept this file, so retrying would fail too. Split the PDF and add it again.
agentparser-notify-limit-hint = Retrying would fail too. Parse it with another service from the item’s “Agent Parsing” section, or split the PDF.
agentparser-notify-limit-hint-single = Retrying would fail too. Split the PDF and add it again.
agentparser-setup-unavailable = Setup needed: the parsing service “{ $provider }” isn’t loaded (a custom service’s script may have been removed or failed)
agentparser-light-setup-button =
    .tooltiptext = Agent Parser — { $issue }
agentparser-setup-custom = Setup needed: { $message }
agentparser-pref-provider-missing = { $provider } (not loaded)
agentparser-pref-custom-title = Custom Parsing Services
agentparser-pref-custom-desc = Connect models you run yourself (on this computer or your network): put provider scripts (.js) in the folder below. Each script registers one or more services, and takes effect after restarting Zotero. Scripts run with the same permissions as the plugin, so only add code you trust.
agentparser-pref-custom-none = No scripts in the folder yet.
agentparser-pref-custom-loaded = ✅ { $file }: { $ids }
agentparser-pref-custom-error = ❌ { $file }: { $error }
agentparser-pref-custom-open =
    .label = Open Folder
agentparser-pref-custom-docs = Guide and examples
