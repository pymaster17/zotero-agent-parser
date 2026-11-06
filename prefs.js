// General
pref("extensions.agentparser.autoParse", true);
pref("extensions.agentparser.skipSyncedItems", true);
pref("extensions.agentparser.includeLinkedFiles", false);
pref("extensions.agentparser.waitForFileMinutes", "10");
pref("extensions.agentparser.timeoutMinutes", "60");
pref("extensions.agentparser.pollIntervalSeconds", "3");
pref("extensions.agentparser.showNotifications", true);

// Output
pref("extensions.agentparser.outputDirName", "parsed");
pref("extensions.agentparser.markForSync", true);
pref("extensions.agentparser.successTag", "");

// Parsing services. Each one's own settings are under extensions.agentparser.providers.<id>., with
// defaults set by the provider (see content/providers.js).
// Service for new files
pref("extensions.agentparser.defaultProvider", "mineru-cloud");
// Service for large requests (whole library, multiple items), if it's set up. Empty means the default.
pref("extensions.agentparser.bulkProvider", "mineru-cloud");

// Internal: persisted queue of pending jobs
pref("extensions.agentparser.queue", "[]");
// Internal: files that failed to parse, shown in the status menu and item pane
pref("extensions.agentparser.failures", "{}");
// Internal: whether the settings were opened for initial setup
pref("extensions.agentparser.firstRunDone", false);
// Internal: whether the status column was shown in the item list (Zotero hides plugin columns at first)
pref("extensions.agentparser.columnShown", false);
