/* global Zotero, Components */

var AgentParserOutput = {
	MARKDOWN_FILE: 'full.md',
	IMAGES_DIR: 'images',
	// Characters of repeated text that count as degenerate output
	MIN_REPETITION: 400,


	/**
	 * Directory for parse results
	 *
	 * For stored files, this is a subdirectory of the attachment's storage directory, so that
	 * WebDAV file sync (which uploads the whole directory as a ZIP) includes it. For linked
	 * files, it's a sibling directory named after the PDF.
	 */
	getOutputDir(item, filePath, dirName) {
		dirName = Zotero.File.getValidFileName(dirName || 'parsed');
		if (this.isStoredFile(item)) {
			return PathUtils.join(Zotero.Attachments.getStorageDirectory(item).path, dirName);
		}
		let stem = PathUtils.filename(filePath).replace(/\.pdf$/i, '');
		return PathUtils.join(PathUtils.parent(filePath), `${stem}.${dirName}`);
	},


	isStoredFile(item) {
		return item.isImportedAttachment();
	},


	/**
	 * Get the SHA-256 of the PDF that existing results were generated from, as recorded in the
	 * front matter of full.md
	 */
	async readSourceHash(outputDir) {
		let path = PathUtils.join(outputDir, this.MARKDOWN_FILE);
		try {
			let md = await IOUtils.readUTF8(path);
			let frontMatter = md.match(/^---\n([\s\S]*?)\n---\n/);
			let match = frontMatter && frontMatter[1].match(/^source_sha256: "([0-9a-f]{64})"$/m);
			return match ? match[1] : null;
		}
		catch (e) {
			return null;
		}
	},
	
	
	async sha256(path) {
		let { classes: Cc, interfaces: Ci } = Components;
		let hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
		hash.init(Ci.nsICryptoHash.SHA256);
		let stream = Cc["@mozilla.org/network/file-input-stream;1"]
			.createInstance(Ci.nsIFileInputStream);
		stream.init(Zotero.File.pathToFile(path), -1, -1, 0);
		try {
			// PR_UINT32_MAX reads the whole stream
			hash.updateFromStream(stream, 0xffffffff);
		}
		finally {
			stream.close();
		}
		let bin = hash.finish(false);
		return Array.from(bin, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
	},


	/**
	 * Extract a ZIP file into a directory, rejecting entries that would escape it
	 */
	async extractZip(zipPath, destDir) {
		let { classes: Cc, interfaces: Ci, utils: Cu } = Components;
		let zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
		zipReader.open(Zotero.File.pathToFile(zipPath));
		try {
			zipReader.test(null);
			let entries = zipReader.findEntries(null);
			while (entries.hasMore()) {
				let entryName = entries.getNext();
				let entry = zipReader.getEntry(entryName);
				if (entry.isDirectory) {
					continue;
				}
				let parts = entryName.split(/[/\\]/).filter(x => x && x != '.');
				if (!parts.length
						|| parts.some(x => x == '..')
						|| /^([a-zA-Z]:|[/\\])/.test(entryName)
						|| parts[0] == '__MACOSX') {
					Zotero.debug(`Agent Parser: Skipping ZIP entry ${entryName}`);
					continue;
				}
				parts = parts.map(x => Zotero.File.getValidFileName(x));
				let destPath = PathUtils.join(destDir, ...parts);
				await IOUtils.makeDirectory(PathUtils.parent(destPath), { ignoreExisting: true });
				zipReader.extract(entryName, Zotero.File.pathToFile(destPath));
			}
		}
		finally {
			zipReader.close();
			// Release file handles on Windows
			Cu.forceGC();
		}
		await IOUtils.remove(zipPath, { ignoreAbsent: true });
	},


	/**
	 * Reduce raw backend output to what agents need:
	 *
	 *   full.md   Markdown with YAML front matter (Zotero metadata, source PDF hash)
	 *   images/   Images referenced from full.md
	 *
	 * Everything else the parser returns (JSON intermediates, a copy of the PDF, crops of equations
	 * and tables that full.md contains as LaTeX/HTML, etc.) is removed.
	 */
	async finalize(stagingDir, { item, attachment, filePath, sha256, parser }) {
		await this._hoistSingleDirectory(stagingDir);
		
		let files = await this._listFiles(stagingDir);
		
		let mdFiles = files.filter(x => /\.md$/i.test(x));
		let mainMD = ['full.md', 'markdown.md'].find(x => mdFiles.includes(x))
			|| mdFiles.find(x => !x.includes('/'))
			|| mdFiles[0];
		if (!mainMD) {
			throw new Error("Parser output does not contain a Markdown file: " + files.join(', '));
		}
		let md = await IOUtils.readUTF8(PathUtils.join(stagingDir, ...mainMD.split('/')));
		
		for (let path of await IOUtils.getChildren(stagingDir)) {
			if (PathUtils.filename(path) != this.IMAGES_DIR) {
				await IOUtils.remove(path, { recursive: true });
			}
		}
		await this._pruneImages(PathUtils.join(stagingDir, this.IMAGES_DIR), md);

		let meta = {
			parsedAt: new Date().toISOString(),
			parser,
			source: {
				attachmentKey: attachment.key,
				fileName: PathUtils.filename(filePath),
				sha256
			},
			item: this.getItemMetadata(item || attachment)
		};
		await IOUtils.writeUTF8(
			PathUtils.join(stagingDir, this.MARKDOWN_FILE),
			this.buildFrontMatter(meta) + md
		);
		return { repetition: this.findRepetition(md) };
	},
	
	
	/**
	 * Find degenerate output, where a model got stuck emitting the same text over and over
	 *
	 * Looks for a unit of 8-400 characters repeated at least 5 times and covering at least
	 * MIN_REPETITION characters. Only units with real content (letters or CJK, outside of HTML
	 * tags) count, so that repeated punctuation, numbers, or empty table cells don't.
	 *
	 * A repeated unit of length p means text[i] == text[i + p] for a stretch of at least
	 * max(4p, MIN_REPETITION - p) characters, which is never shorter than 4/5 of MIN_REPETITION.
	 * So for each p, it's enough to compare at positions that far apart and expand around matches.
	 *
	 * @return {Object|null} - { unit, length } of the longest run, or null if there's none
	 */
	findRepetition(text) {
		const MIN_UNIT = 8;
		const MAX_UNIT = 400;
		const MIN_REPEATS = 5;
		let stride = Math.floor(this.MIN_REPETITION * (MIN_REPEATS - 1) / MIN_REPEATS) - 1;
		let same = (i, p) => text.charCodeAt(i) == text.charCodeAt(i + p);
		let longest = null;
		for (let p = MIN_UNIT; p <= MAX_UNIT; p++) {
			for (let i = 0; i + p < text.length; i += stride) {
				if (!same(i, p)) {
					continue;
				}
				let start = i;
				let end = i;
				while (start > 0 && same(start - 1, p)) {
					start--;
				}
				while (end + 1 + p < text.length && same(end + 1, p)) {
					end++;
				}
				let streak = end - start + 1;
				let length = streak + p;
				if (streak >= (MIN_REPEATS - 1) * p
						&& length >= this.MIN_REPETITION
						&& !(longest && longest.length >= length)) {
					let unit = text.substr(start, p);
					if (/[A-Za-z\u4e00-\u9fff]/.test(unit.replace(/<[^>]*>/g, ''))) {
						longest = { unit, length };
					}
				}
				// Skip the samples inside this stretch
				i = end - end % stride;
			}
		}
		return longest;
	},
	
	
	/**
	 * Replace the output directory with the staging directory
	 */
	async install(stagingDir, outputDir) {
		await IOUtils.remove(outputDir, { recursive: true, ignoreAbsent: true });
		await IOUtils.makeDirectory(PathUtils.parent(outputDir), { ignoreExisting: true });
		await IOUtils.move(stagingDir, outputDir);
	},


	getItemMetadata(item) {
		let get = (field) => {
			try {
				return item.getField(field) || null;
			}
			catch (e) {
				return null;
			}
		};
		let libraryPath = item.library.libraryType == 'group'
			? `groups/${Zotero.Groups.getGroupIDFromLibraryID(item.libraryID)}`
			: 'library';
		let year = null;
		let date = get('date');
		if (date) {
			year = Zotero.Date.strToDate(date).year || null;
		}
		return {
			key: item.key,
			itemType: Zotero.ItemTypes.getName(item.itemTypeID),
			title: get('title'),
			creators: item.isRegularItem()
				? item.getCreators().map(c => ({
					creatorType: Zotero.CreatorTypes.getName(c.creatorTypeID),
					...(c.fieldMode == 1
						? { name: c.lastName }
						: { firstName: c.firstName, lastName: c.lastName })
				}))
				: [],
			date,
			year: year ? parseInt(year) : null,
			publicationTitle: get('publicationTitle') || get('proceedingsTitle') || get('bookTitle'),
			DOI: get('DOI'),
			ISBN: get('ISBN'),
			url: get('url'),
			citationKey: get('citationKey'),
			abstract: get('abstractNote'),
			tags: item.getTags().map(t => t.tag),
			zoteroURI: `zotero://select/${libraryPath}/items/${item.key}`
		};
	},


	buildFrontMatter(meta) {
		let { item, source, parser } = meta;
		let q = v => JSON.stringify(v);
		let lines = ['---'];
		let add = (key, value) => {
			if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) {
				return;
			}
			lines.push(`${key}: ${Array.isArray(value) ? '[' + value.map(q).join(', ') + ']' : q(value)}`);
		};
		add('title', item.title);
		add('authors', item.creators.map(c => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')));
		add('year', item.year);
		add('date', item.date);
		add('publication', item.publicationTitle);
		add('doi', item.DOI);
		add('url', item.url);
		add('citation_key', item.citationKey);
		add('tags', item.tags);
		add('zotero_item_key', item.key);
		add('zotero_attachment_key', source.attachmentKey);
		add('zotero_uri', item.zoteroURI);
		add('source_file', source.fileName);
		add('source_sha256', source.sha256);
		add('parser', parser.service);
		add('parser_model', parser.modelVersion);
		add('parser_fallback_reason', parser.fallbackReason);
		add('parser_input', parser.input);
		add('parser_source_url', parser.input == 'url' ? parser.sourceURL : null);
		add('parsed_at', meta.parsedAt);
		lines.push('---', '', '');
		return lines.join('\n');
	},


	/**
	 * Make sure the new files reach other computers via WebDAV
	 *
	 * File sync only looks at the main file, so we mark the attachment for upload and bump the
	 * PDF's modification time. The new mtime ends up in the .prop file on the server, which makes
	 * other computers download the ZIP (including the parse results) even if they already have
	 * the PDF.
	 *
	 * Zotero Storage uploads PDFs as single files rather than as a ZIP of the directory, so this
	 * only helps for WebDAV.
	 */
	async markForSync(attachment, filePath) {
		if (!this.isStoredFile(attachment)) {
			return false;
		}
		let mode;
		try {
			mode = Zotero.Sync.Storage.Local.getModeForLibrary(attachment.libraryID);
		}
		catch (e) {
			return false;
		}
		if (mode != 'webdav' || !Zotero.Sync.Storage.Local.getEnabledForLibrary(attachment.libraryID)) {
			return false;
		}
		await IOUtils.setModificationTime(filePath, Date.now());
		await Zotero.Sync.Storage.Local.updateSyncStates(
			[attachment],
			Zotero.Sync.Storage.Local.SYNC_STATE_TO_UPLOAD
		);
		return true;
	},


	async _listFiles(dir, prefix = '') {
		let files = [];
		for (let path of await IOUtils.getChildren(dir)) {
			let name = PathUtils.filename(path);
			let rel = prefix ? `${prefix}/${name}` : name;
			let info = await IOUtils.stat(path);
			if (info.type == 'directory') {
				files.push(...await this._listFiles(path, rel));
			}
			else {
				files.push(rel);
			}
		}
		return files;
	},


	/**
	 * Remove images that the Markdown doesn't reference
	 *
	 * MinerU saves a crop of every equation and table block next to the figures, although the
	 * Markdown has those as LaTeX and HTML. Image names are content hashes, so a file counts as
	 * referenced if its name (plain or URL-encoded) appears anywhere in the Markdown, which covers
	 * both ![](images/...) and <img src="..."> inside HTML tables.
	 */
	async _pruneImages(imagesDir, md) {
		if (!(await IOUtils.exists(imagesDir))) {
			return;
		}
		let kept = 0;
		let removed = 0;
		for (let rel of await this._listFiles(imagesDir)) {
			let name = rel.split('/').pop();
			if (md.includes(name) || md.includes(encodeURIComponent(name))) {
				kept++;
				continue;
			}
			await IOUtils.remove(PathUtils.join(imagesDir, ...rel.split('/')));
			removed++;
		}
		if (!kept) {
			await IOUtils.remove(imagesDir, { recursive: true });
		}
		Zotero.debug(`Agent Parser: Kept ${kept} referenced image(s), removed ${removed} unreferenced`);
	},


	/**
	 * If the archive wrapped everything in a single top-level directory, move its contents up
	 */
	async _hoistSingleDirectory(dir) {
		let children = await IOUtils.getChildren(dir);
		if (children.length != 1) {
			return;
		}
		let child = children[0];
		let name = PathUtils.filename(child);
		if (name == 'images' || (await IOUtils.stat(child)).type != 'directory') {
			return;
		}
		for (let path of await IOUtils.getChildren(child)) {
			await IOUtils.move(path, PathUtils.join(dir, PathUtils.filename(path)));
		}
		await IOUtils.remove(child, { recursive: true });
	}
};
