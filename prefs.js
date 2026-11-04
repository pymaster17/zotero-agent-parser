// General
pref("extensions.agentparser.autoParse", true);
pref("extensions.agentparser.skipSyncedItems", true);
pref("extensions.agentparser.includeLinkedFiles", false);
pref("extensions.agentparser.concurrency", "1");
pref("extensions.agentparser.waitForFileMinutes", "10");
pref("extensions.agentparser.timeoutMinutes", "60");
pref("extensions.agentparser.pollIntervalSeconds", "3");
pref("extensions.agentparser.showNotifications", true);

// Output
pref("extensions.agentparser.outputDirName", "parsed");
pref("extensions.agentparser.markForSync", true);
pref("extensions.agentparser.successTag", "");

// Backend: "tasks" (MinerU >= 4 Tasks API, local or cloud) or "cloudV4" (mineru.net v4 batch API)
pref("extensions.agentparser.backend", "cloudV4");

pref("extensions.agentparser.tasks.url", "http://127.0.0.1:8000");
pref("extensions.agentparser.tasks.apiKey", "");
pref("extensions.agentparser.tasks.tier", "");
pref("extensions.agentparser.tasks.ocrMode", "auto");

pref("extensions.agentparser.cloudV4.url", "https://mineru.net/api/v4");
pref("extensions.agentparser.cloudV4.token", "");
pref("extensions.agentparser.cloudV4.modelVersion", "vlm");
pref("extensions.agentparser.cloudV4.isOCR", false);
pref("extensions.agentparser.cloudV4.enableFormula", true);
pref("extensions.agentparser.cloudV4.enableTable", true);
pref("extensions.agentparser.cloudV4.language", "ch");
// Hosts whose PDFs are submitted by URL instead of being uploaded
pref("extensions.agentparser.cloudV4.urlHosts", "arxiv.org");

// Internal: persisted queue of pending jobs
pref("extensions.agentparser.queue", "[]");
