// ==UserScript==
// @name         Takara In-Fusion 一键导出脚本 (by 小J)
// @namespace    bio-automation-lab-private-script
// @version      1.0.0
// @description  将 Takara In-Fusion 结果极速导出为带完美注释的 .gb 文件，无缝对接 SnapGene。彻底告别手动拼装。
// @author       想准点下班的小J
// @match        https://takara.teselagen.com/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // CONFIGURATION & STATE
    // =========================================================================
    const LOG_PREFIX = '[TakaraScraper]';
    const STATE = {
        store: null,
        foundSequences: [], // Array of valid sequence objects
        selectedSequenceIndex: 0,
        isExporting: false,
    };

    function log(...args) {
        console.log(`%c${LOG_PREFIX}`, 'color: #00d4ff; font-weight: bold;', ...args);
    }

    function warn(...args) {
        console.warn(`%c${LOG_PREFIX}`, 'color: #ffaa00; font-weight: bold;', ...args);
    }

    // =========================================================================
    // 1. DATA EXTRACTION: CONSOLE INTERCEPTION
    // =========================================================================

    (function hookConsole() {
        const origLog = unsafeWindow.console.log;
        unsafeWindow.console.log = function (...args) {
            args.forEach(arg => {
                if (arg && typeof arg === 'object' && typeof arg.getState === 'function' && typeof arg.dispatch === 'function') {
                    if (!STATE.store) {
                        log('🎯 Captured Redux store from console.log!', arg);
                        STATE.store = arg;
                        scanStore();
                    }
                }
            });
            return origLog.apply(this, args);
        };
    })();

    // =========================================================================
    // 2. DATA EXTRACTION: NETWORK INTERCEPTION
    // =========================================================================

    (function hookFetch() {
        const originalFetch = unsafeWindow.fetch;
        unsafeWindow.fetch = async function (...args) {
            const response = await originalFetch.apply(this, args);
            const clone = response.clone();
            const url = (typeof args[0] === 'string' ? args[0] : args[0].url || '').toLowerCase();

            if (url.includes('sequence') || url.includes('construct') || url.includes('design')) {
                clone.json().then(data => {
                    if (isValidSequenceData(data)) {
                        log('Captured sequence data from fetch:', url);
                        addSequence(data);
                    }
                }).catch(() => { });
            }
            return response;
        };
    })();

    (function hookXHR() {
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            this._url = url;
            return originalOpen.apply(this, arguments);
        };

        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function () {
            this.addEventListener('load', function () {
                if (this._url && (this._url.includes('sequence') || this._url.includes('construct'))) {
                    try {
                        const data = JSON.parse(this.responseText);
                        if (isValidSequenceData(data)) {
                            log('Captured sequence data from XHR:', this._url);
                            addSequence(data);
                        }
                    } catch (e) { }
                }
            });
            return originalSend.apply(this, arguments);
        };
    })();

    function isValidSequenceData(data) {
        if (!data || typeof data !== 'object') return false;
        const seq = data.sequence || data.bases;
        // Must be a string and somewhat reasonable length (e.g. > 10bp)
        return typeof seq === 'string' && seq.length > 10;
    }

    function addSequence(data) {
        // Check if already exists (by name + length to avoid dupes)
        const exists = STATE.foundSequences.some(s =>
            (s.name === data.name) &&
            ((s.sequence || s.bases).length === (data.sequence || data.bases).length)
        );

        if (!exists) {
            STATE.foundSequences.push(data);
            // Sort by length descending (longest is likely the construct)
            STATE.foundSequences.sort((a, b) => {
                const lenA = (a.sequence || a.bases || '').length;
                const lenB = (b.sequence || b.bases || '').length;
                return lenB - lenA;
            });
            updateUI();
        }
    }

    // =========================================================================
    // 3. DATA EXTRACTION: REDUX STORE SCANNING
    // =========================================================================

    function findStore() {
        if (STATE.store) return STATE.store;

        // Traverse from root to find internal React instance
        const root = document.querySelector('#app') || document.querySelector('#root');
        if (!root) return null;

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
        let node;
        while (node = walker.nextNode()) {
            const key = Object.keys(node).find(k => k.startsWith('__reactInternalInstance') || k.startsWith('__reactFiber'));
            if (key) {
                const fiber = node[key];
                let current = fiber;
                while (current) {
                    if (current.memoizedProps && current.memoizedProps.store) {
                        STATE.store = current.memoizedProps.store;
                        return STATE.store;
                    }
                    if (current.stateNode && current.stateNode.store) {
                        STATE.store = current.stateNode.store;
                        return STATE.store;
                    }
                    current = current.return;
                }
            }
        }
        return null;
    }

    function scanStore() {
        const store = findStore();
        if (!store) return;

        const state = store.getState();
        // Deep scan the entire state for ANY sequence-like object
        deepSearchStore(state);
    }

    function deepSearchStore(obj, depth = 0, path = '') {
        if (depth > 6 || !obj || typeof obj !== 'object') return;

        // Check if this object IS the sequence data
        if (isValidSequenceData(obj) && obj.name) {
            // Found a candidate!
            addSequence(obj);
            return;
        }

        // Optimization: Don't recurse into huge irrelevant trees
        for (const key of Object.keys(obj)) {
            if (key === 'store' || key === 'history' || key === 'window' || key === 'routing') continue;

            // Recurse
            deepSearchStore(obj[key], depth + 1, path ? `${path}.${key}` : key);
        }
    }

    // =========================================================================
    // 4. GENBANK GENERATION with AUTO-ANNOTATION & FILTERING
    // =========================================================================

    function ensureArray(collection) {
        if (!collection) return [];
        if (Array.isArray(collection)) return collection;
        if (typeof collection === 'object') return Object.values(collection);
        return [];
    }

    // Find position of 'subSeq' inside 'mainSeq'
    function findSequencePosition(mainSeq, subSeq) {
        if (!mainSeq || !subSeq || subSeq.length > mainSeq.length) return null;

        mainSeq = mainSeq.toLowerCase();
        subSeq = subSeq.toLowerCase();

        // Check finding forward
        let idx = mainSeq.indexOf(subSeq);
        if (idx !== -1) {
            return { start: idx, end: idx + subSeq.length - 1, strand: 1 };
        }

        // Check reverse complement
        const rcSubSeq = subSeq.split('').reverse().map(c => {
            return { 'a': 't', 't': 'a', 'g': 'c', 'c': 'g', 'n': 'n' }[c] || c;
        }).join('');

        idx = mainSeq.indexOf(rcSubSeq);
        if (idx !== -1) {
            return { start: idx, end: idx + rcSubSeq.length - 1, strand: -1 };
        }

        return null;
    }

    function generateGenBank(mainData) {
        log('Generating GenBank for:', mainData.name);

        const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-').toUpperCase();
        const sequence = (mainData.sequence || mainData.bases || '').toLowerCase();
        const length = sequence.length;
        const name = (mainData.name || 'Exported_Construct').replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 20);
        const circular = mainData.circular ? 'circular' : 'linear';

        let gb = '';

        // HEADER
        gb += `LOCUS       ${name.padEnd(24)} ${length.toString().padStart(6)} bp ds-DNA   ${circular.padEnd(8)} ${dateStr}\n`;
        gb += `DEFINITION  ${mainData.name || 'Exported by Takara Auto-Scraper'}.\n`;
        gb += `ACCESSION   ${name}\n`;
        gb += `VERSION     ${name}.1\n`;
        gb += `KEYWORDS    .\n`;
        gb += `SOURCE      Synthetic DNA construct\n`;
        gb += `  ORGANISM  Synthetic DNA construct\n`;
        gb += `FEATURES             Location/Qualifiers\n`;

        // FEATURES
        const features = ensureArray(mainData.features);
        const primers = ensureArray(mainData.primers);

        let combinedFeatures = [...features, ...primers];

        // AUTO-ANNOTATION LOGIC WITH DEDUPLICATION
        STATE.foundSequences.forEach(otherSeq => {
            if (otherSeq === mainData) return; // Skip self

            const otherSeqStr = (otherSeq.sequence || otherSeq.bases || '');
            if (otherSeqStr.length < 20) return; // Skip tiny fragments

            // Try to find this sequence in the main sequence
            const match = findSequencePosition(sequence, otherSeqStr);
            if (match) {
                // Check if a feature already exists at these exact coordinates
                const isDuplicate = combinedFeatures.some(f =>
                    (f.start || 0) === match.start && (f.end || 0) === match.end
                );

                if (!isDuplicate) {
                    log(`Auto-annotating: Found ${otherSeq.name} at ${match.start}..${match.end}`);
                    combinedFeatures.push({
                        name: otherSeq.name || 'Insert',
                        start: match.start,
                        end: match.end,
                        strand: match.strand,
                        type: 'misc_feature',
                        _note: 'Auto-annotated Insert'
                    });
                } else {
                    log(`Skipping auto-annotation for ${otherSeq.name} (duplicate coordinates)`);
                }
            }
        });

        // STRICT FILTERING
        combinedFeatures = combinedFeatures.filter(f => {
            // 1. Keep Auto-Annotated items
            if (f._note === 'Auto-annotated Insert') return true;

            // 2. Keep Primers
            if (f.type === 'primer_bind') return true;
            if (f.annotationType === 'primer') return true;

            // 3. Discard everything else (promoters, CDS, etc.)
            if (f.annotationType === 'feature') return false;

            // Safe default: Discard if not explicitly identified as kept.
            return false;
        });

        // GENERATE OUTPUT
        combinedFeatures.forEach(feat => {
            if (!feat) return;

            // Determine feature type (defaults to misc_feature if not set)
            let type = feat.type || feat._type || 'misc_feature';
            if (!feat.type && !feat._type && (feat.annotationType === 'primer')) type = 'primer_bind';
            if (type === 'misc_feature' && feat.annotationType === 'primer') type = 'primer_bind';

            // Start/End logic
            const start = (feat.start || 0) + 1; // 1-based
            const end = (feat.end || 0) + 1;
            const strand = feat.strand;

            let loc = `${start}..${end}`;
            if (strand === -1 || feat.forward === false) {
                loc = `complement(${start}..${end})`;
            }

            gb += `     ${type.padEnd(16)}${loc}\n`;

            const notes = [];
            if (feat.name) notes.push(['label', feat.name]);
            if (feat.name) notes.push(['note', feat.name]);
            if (feat.sequence) notes.push(['note', `sequence: ${feat.sequence}`]);
            if (feat._note) notes.push(['note', feat._note]);
            if (feat.annotationType) notes.push(['note', `annotationType: ${feat.annotationType}`]);

            Object.keys(feat).forEach(k => {
                if (!['name', 'type', 'start', 'end', 'strand', 'forward', 'sequence', 'bases', '_type', '_note', 'id', 'color', 'annotationType'].includes(k)) {
                    const val = feat[k];
                    // Only add string/number properties
                    if (typeof val === 'string' || typeof val === 'number') {
                        notes.push(['note', `${k}: ${val}`]);
                    }
                }
            });

            notes.forEach(([key, val]) => {
                gb += `                     /${key}="${val}"\n`;
            });
        });

        // ORIGIN
        gb += `ORIGIN\n`;
        for (let i = 0; i < length; i += 60) {
            const chunk = sequence.substring(i, i + 60);
            const lineNum = (i + 1).toString().padStart(9);
            const blocks = (chunk.match(/.{1,10}/g) || []).join(' ');
            gb += `${lineNum} ${blocks}\n`;
        }

        gb += `//\n`;
        return gb;
    }

    // =========================================================================
    // 5. UI IMPLEMENTATION
    // =========================================================================

    function createUI() {
        if (document.getElementById('takara-scraper-ui')) return;

        const div = document.createElement('div');
        div.id = 'takara-scraper-ui';
        div.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 99999;
            background: white;
            padding: 12px;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.2);
            font-family: sans-serif;
            display: flex;
            flex-direction: column;
            gap: 10px;
            border: 1px solid #ccc;
            min-width: 250px;
        `;

        // 1. Status Label
        const title = document.createElement('div');
        title.style.fontWeight = 'bold';
        title.style.fontSize = '14px';
        title.style.marginBottom = '5px';
        title.textContent = 'Takara GenBank Exporter';
        div.appendChild(title);

        // 2. Sequence Selector (Dropdown)
        const selectContainer = document.createElement('div');
        selectContainer.style.display = 'flex';
        selectContainer.style.flexDirection = 'column';

        const label = document.createElement('label');
        label.textContent = 'Found Sequences:';
        label.style.fontSize = '11px';
        label.style.color = '#666';

        const select = document.createElement('select');
        select.id = 'scraper-select';
        select.style.width = '100%';
        select.style.padding = '4px';
        select.style.fontSize = '12px';

        // Handle selection change
        select.onchange = (e) => {
            STATE.selectedSequenceIndex = parseInt(e.target.value);
            updateUI(false); // Don't rebuild dropdown, just update button state
        };

        selectContainer.appendChild(label);
        selectContainer.appendChild(select);
        div.appendChild(selectContainer);

        // 3. Export Button
        const btn = document.createElement('button');
        btn.id = 'scraper-btn';
        btn.textContent = '⬇ Export .gb';
        btn.disabled = true;
        btn.style.cssText = `
            background: #e0e0e0;
            color: #888;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: not-allowed;
            font-weight: bold;
            transition: all 0.2s;
            margin-top: 5px;
        `;

        btn.onclick = () => {
            const data = STATE.foundSequences[STATE.selectedSequenceIndex];
            if (data && isValidSequenceData(data)) {
                try {
                    const blob = new Blob([generateGenBank(data)], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${data.name || 'construct'}.gb`;
                    a.click();
                    URL.revokeObjectURL(url);
                } catch (e) {
                    alert('Error generating GenBank file: ' + e.message);
                    console.error(e);
                }
            } else {
                alert('Please select a valid sequence first.');
            }
        };

        div.appendChild(btn);

        // 4. Scan Button (Manual Refresh)
        const scanBtn = document.createElement('a');
        scanBtn.textContent = '↻ Re-scan State';
        scanBtn.href = '#';
        scanBtn.style.fontSize = '11px';
        scanBtn.style.textAlign = 'center';
        scanBtn.style.color = '#007bff';
        scanBtn.style.textDecoration = 'none';
        scanBtn.onclick = (e) => {
            e.preventDefault();
            scanStore();
            updateUI();
        };
        div.appendChild(scanBtn);

        document.body.appendChild(div);

        STATE.ui = { div, select, btn };
    }

    function updateUI(rebuildDropdown = true) {
        if (!STATE.ui) return;

        const sequences = STATE.foundSequences;
        const count = sequences.length;

        if (count > 0) {
            // Enable Button
            STATE.ui.btn.disabled = false;
            STATE.ui.btn.style.background = '#007bff';
            STATE.ui.btn.style.color = 'white';
            STATE.ui.btn.style.cursor = 'pointer';

            // Rebuild Dropdown if needed
            if (rebuildDropdown) {
                STATE.ui.select.innerHTML = '';
                sequences.forEach((seq, idx) => {
                    const opt = document.createElement('option');
                    opt.value = idx;
                    const len = (seq.sequence || seq.bases || '').length;
                    const name = seq.name || `Seq_${idx + 1}`;
                    // Mark the selected one
                    opt.textContent = `${name} (${len} bp)`;
                    if (idx === STATE.selectedSequenceIndex) opt.selected = true;
                    STATE.ui.select.appendChild(opt);
                });
            }
        } else {
            STATE.ui.btn.disabled = true;
            STATE.ui.btn.style.background = '#e0e0e0';
            STATE.ui.btn.style.color = '#888';
            STATE.ui.select.innerHTML = '<option>Scanning...</option>';
        }
    }

    // =========================================================================
    // 6. MAIN LOOP
    // =========================================================================

    function init() {
        log('Initializing...');
        const interval = setInterval(() => {
            if (document.body) {
                clearInterval(interval);
                createUI();
                log('UI Created');
                setInterval(() => {
                    scanStore(); // Periodically confirm we have the latest data
                    updateUI(true);
                }, 2000);
            }
        }, 500);
    }

    init();

})();
