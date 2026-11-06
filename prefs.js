// General
pref("extensions.agentparser.autoParse", true);
pref("extensions.agentparser.skipSyncedItems", true);
pref("extensions.agentparser.includeLinkedFiles", false);
pref("extensions.agentparser.concurrency", "4");
pref("extensions.agentparser.waitForFileMinutes", "10");
pref("extensions.agentparser.timeoutMinutes", "60");
pref("extensions.agentparser.pollIntervalSeconds", "3");
pref("extensions.agentparser.showNotifications", true);

// Output
pref("extensions.agentparser.outputDirName", "parsed");
pref("extensions.agentparser.markForSync", true);
pref("extensions.agentparser.successTag", "");

// Default service: "cloud" (mineru.net v4 API) or "local" (MinerU on this computer)
pref("extensions.agentparser.mode", "cloud");
// In local mode, send large requests (whole library, multiple items) to the cloud batch API
pref("extensions.agentparser.bulkUseCloud", true);

// Local MinerU. When managed, the plugin installs MinerU into envDir and runs the server itself.
pref("extensions.agentparser.local.managed", true);
pref("extensions.agentparser.local.tier", "standard");
pref("extensions.agentparser.local.ocrMode", "auto");
pref("extensions.agentparser.local.port", "8000");
pref("extensions.agentparser.local.idleStopMinutes", "15");
// Empty means ~/.zotero-agent-parser/mineru-env
pref("extensions.agentparser.local.envDir", "");
// Empty means search PATH and the usual install locations
pref("extensions.agentparser.local.uvPath", "");
// "auto", "huggingface" or "modelscope"
pref("extensions.agentparser.local.modelSource", "auto");
// Server run by the user, when not managed
pref("extensions.agentparser.local.url", "http://127.0.0.1:8000");
pref("extensions.agentparser.local.apiKey", "");

pref("extensions.agentparser.cloudV4.url", "https://mineru.net/api/v4");
pref("extensions.agentparser.cloudV4.token", "");
pref("extensions.agentparser.cloudV4.modelVersion", "vlm");
pref("extensions.agentparser.cloudV4.isOCR", false);
pref("extensions.agentparser.cloudV4.enableFormula", true);
pref("extensions.agentparser.cloudV4.enableTable", true);
pref("extensions.agentparser.cloudV4.language", "ch");
// "auto", "always", or "off": upload through the storage service's accelerated endpoint
pref("extensions.agentparser.cloudV4.uploadAcceleration", "auto");
// Hosts whose PDFs are submitted by URL instead of being uploaded
pref("extensions.agentparser.cloudV4.urlHosts", "arxiv.org, aclanthology.org, isca-archive.org, jmlr.org, openaccess.thecvf.com, proceedings.iclr.cc, proceedings.mlr.press, proceedings.neurips.cc");

// Internal: persisted queue of pending jobs
pref("extensions.agentparser.queue", "[]");
// Internal: files that failed to parse, shown in the status menu and item pane
pref("extensions.agentparser.failures", "{}");
// Internal: whether the settings were opened for initial setup
pref("extensions.agentparser.firstRunDone", false);
