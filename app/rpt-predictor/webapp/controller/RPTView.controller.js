sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/export/Spreadsheet",
    "sap/ui/export/library",
    "sap/ui/model/json/JSONModel"
], function (Controller, MessageToast, MessageBox, Spreadsheet, exportLibrary, JSONModel) {
    "use strict";

    const MAX_COLUMNS  = 64;
    const WARN_COLUMNS = 50;
    const MAX_CONTEXT  = 1500;
    const BATCH_SIZE   = 500;

    return Controller.extend("rptpredictor.rptpredictor.controller.RPTView", {

        // ─── Lifecycle ───────────────────────────────────────────────────────────

        onInit: function () {
            this._initState();
        },

        _initState: function () {
            this._filesData          = [];
            this._detectedLinks      = [];
            this._acceptedLinks      = [];
            this._primaryFileIndex   = 0;
            this._editingLinkIndex   = null;
            this._previewRows        = null;
            this._previewHeaders     = [];
            this._resultsSearchQuery = "";
            this._joinedRows         = null;
            this._allRows            = null;
            this._targetColumn       = null;
        },

        // ─── File Upload ─────────────────────────────────────────────────────────

        onFilesSelected: function () {
            const dom = this.byId("fileUploader").getFocusDomRef();
            if (!dom || !dom.files || dom.files.length === 0) return;

            // If results are already visible, confirm before discarding them
            if (this.byId("resultsBox").getVisible()) {
                MessageBox.confirm(
                    "Starting a new prediction will discard your current results. Continue?",
                    {
                        title: "New Prediction",
                        onClose: (action) => {
                            if (action === MessageBox.Action.OK) {
                                this._resetAll();
                                this._processNewFiles(dom.files);
                            } else {
                                const uploader = this.byId("fileUploader");
                                if (uploader.clear) uploader.clear();
                            }
                        }
                    }
                );
                return;
            }

            this._processNewFiles(dom.files);
        },

        onNewPredictionPressed: function () {
            if (this._filesData.length === 0 && !this.byId("resultsBox").getVisible()) return;
            MessageBox.confirm(
                "Start a new prediction? All current data will be cleared.",
                {
                    title: "New Prediction",
                    onClose: (action) => {
                        if (action === MessageBox.Action.OK) this._resetAll();
                    }
                }
            );
        },

        onClearAllFiles: function () {
            this._resetAll();
        },

        _processNewFiles: function (fileList) {
            const existingNames = new Set(this._filesData.map(f => f.name));
            const newFiles = Array.from(fileList).filter(f => !existingNames.has(f.name));

            if (newFiles.length === 0) {
                MessageToast.show("All selected files are already loaded.");
                return;
            }

            let remaining = newFiles.length;
            newFiles.forEach(file => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const rows = this._parseCSV(e.target.result);
                    if (rows.length === 0) {
                        MessageToast.show(`${file.name} appears to be empty — skipped.`);
                    } else {
                        this._filesData.push({
                            name:    file.name,
                            headers: Object.keys(rows[0]),
                            rows
                        });
                    }
                    if (--remaining === 0) this._onAllFilesRead();
                };
                reader.onerror = () => {
                    MessageToast.show(`Failed to read ${file.name}.`);
                    if (--remaining === 0) this._onAllFilesRead();
                };
                reader.readAsText(file);
            });
        },

        _onAllFilesRead: function () {
            this._updateLoadedFilesChips();
            if (this._filesData.length === 1) {
                // Single file — skip mapper, go straight to prediction setup
                this._joinedRows = this._filesData[0].rows;
                this._showTargetStep(this._filesData[0].headers);
            } else if (this._filesData.length > 1) {
                this._showRelationshipMapper();
            }
        },

        _updateLoadedFilesChips: function () {
            const chipsBox = this.byId("loadedFilesChips");
            chipsBox.destroyItems();

            this._filesData.forEach((file, idx) => {
                const token = new sap.m.Token({ text: file.name, editable: true });
                // Attach with current idx — always fresh since we rebuild entirely
                token.attachDelete(() => this._removeFile(idx));
                chipsBox.addItem(token);
            });

            const hasFiles = this._filesData.length > 0;
            this.byId("loadedFilesBox").setVisible(hasFiles);
            this.byId("clearFilesBtn").setVisible(hasFiles);
        },

        _removeFile: function (idx) {
            this._filesData.splice(idx, 1);
            this._updateLoadedFilesChips();

            if (this._filesData.length === 0) {
                this._resetAll();
            } else if (this._filesData.length === 1) {
                this.byId("relationshipBox").setVisible(false);
                this._joinedRows = this._filesData[0].rows;
                this._showTargetStep(this._filesData[0].headers);
            } else {
                this._showRelationshipMapper();
            }
        },

        _resetAll: function () {
            this._initState();

            [
                "relationshipBox", "targetBox", "runButton", "resultsBox",
                "loadedFilesBox", "clearFilesBtn", "previewSection"
            ].forEach(id => this.byId(id).setVisible(false));

            this.byId("proceedButton").setVisible(false);
            this.byId("continueToTargetButton").setVisible(false);

            const uploader = this.byId("fileUploader");
            if (uploader.clear) uploader.clear();
        },

        // ─── Relationship Mapper ──────────────────────────────────────────────────

        _showRelationshipMapper: function () {
            this._primaryFileIndex = 0;

            // Populate primary file picker
            const primarySelect = this.byId("primaryFileSelect");
            primarySelect.destroyItems();
            this._filesData.forEach((file, i) => {
                primarySelect.addItem(new sap.ui.core.Item({ key: String(i), text: file.name }));
            });
            primarySelect.setSelectedKey("0");

            // Auto-detect and auto-accept high-confidence links
            this._enrichFilesWithSamples();
            this._detectedLinks = this._detectRelationships();
            this._acceptedLinks = this._detectedLinks
                .filter(l => l.level === "High")
                .map(l => Object.assign({}, l));

            this._renderLinksContainer();
            this.byId("linkEditPanel").setVisible(false);
            this.byId("relationshipBox").setVisible(true);

            if (this._acceptedLinks.length > 0) {
                this._runJoinAndUpdateButtons();
            }
        },

        onPrimaryFileChanged: function (oEvent) {
            this._primaryFileIndex = parseInt(oEvent.getSource().getSelectedKey(), 10);
            this._detectedLinks    = this._detectRelationships();
            this._acceptedLinks    = this._detectedLinks
                .filter(l => l.level === "High")
                .map(l => Object.assign({}, l));

            this._renderLinksContainer();
            this.byId("linkEditPanel").setVisible(false);
            this.byId("previewSection").setVisible(false);
            this.byId("targetBox").setVisible(false);
            this.byId("runButton").setVisible(false);

            if (this._acceptedLinks.length > 0) {
                this._runJoinAndUpdateButtons();
            } else {
                this.byId("proceedButton").setVisible(false);
                this.byId("continueToTargetButton").setVisible(false);
            }
        },

        _renderLinksContainer: function () {
            const container = this.byId("linksContainer");
            container.destroyItems();

            if (this._detectedLinks.length === 0) {
                container.addItem(new sap.m.Text({
                    text: "No relationships detected automatically. Add one manually below."
                }));
                return;
            }

            const files = this._filesData;
            this._detectedLinks.forEach((link, idx) => {
                const isAccepted = this._acceptedLinks.some(
                    a => a.fileA === link.fileA && a.fileB === link.fileB
                );
                const fileAName = (files[link.fileA] || {}).name || "?";
                const fileBName = (files[link.fileB] || {}).name || "?";

                const row = new sap.m.HBox({
                    alignItems: "Center",
                    items: [
                        new sap.m.Text({ text: isAccepted ? "✅" : "🟡", width: "2rem" }),
                        new sap.m.VBox({
                            width: "60%",
                            items: [
                                new sap.m.Text({
                                    text: `${fileAName}.${link.colA}  →  ${fileBName}.${link.colB}`
                                }),
                                new sap.m.Text({
                                    text: `Confidence: ${link.level} (${link.confidence})`
                                }).addStyleClass("sapUiSmallText")
                            ]
                        }),
                        new sap.m.HBox({
                            items: [
                                isAccepted
                                    ? new sap.m.Text({ text: "" })
                                    : new sap.m.Button({
                                        text: "Accept",
                                        type: "Accept",
                                        press: () => this._onAcceptLink(idx)
                                    }).addStyleClass("sapUiSmallMarginEnd"),
                                new sap.m.Button({
                                    text: "Edit",
                                    press: () => this._onEditLink(idx)
                                }).addStyleClass("sapUiSmallMarginEnd"),
                                new sap.m.Button({
                                    text: "✕",
                                    type: "Reject",
                                    press: () => this._onDeleteLink(idx)
                                })
                            ]
                        })
                    ]
                }).addStyleClass("sapUiSmallMarginBottom");
                container.addItem(row);
            });
        },

        _onAcceptLink: function (idx) {
            const link = this._detectedLinks[idx];
            const already = this._acceptedLinks.some(
                a => a.fileA === link.fileA && a.fileB === link.fileB
            );
            if (!already) this._acceptedLinks.push(Object.assign({}, link));
            this._renderLinksContainer();
            this._runJoinAndUpdateButtons();
        },

        _onDeleteLink: function (idx) {
            const [link] = this._detectedLinks.splice(idx, 1);
            this._acceptedLinks = this._acceptedLinks.filter(
                a => !(a.fileA === link.fileA && a.fileB === link.fileB)
            );
            this._renderLinksContainer();
            this._runJoinAndUpdateButtons();
        },

        _onEditLink: function (idx) {
            this._editingLinkIndex = idx;
            this._populateEditPanel();
            this.byId("linkEditPanel").setVisible(true);
        },

        onAddManualLink: function () {
            this._editingLinkIndex = null;
            this._populateEditPanel();
            this.byId("linkEditPanel").setVisible(true);
        },

        _populateEditPanel: function () {
            const files   = this._filesData;
            const primary = this._primaryFileIndex;

            const primaryColSelect = this.byId("editPrimaryColSelect");
            primaryColSelect.destroyItems();
            files[primary].headers.forEach(col => {
                primaryColSelect.addItem(new sap.ui.core.Item({ key: col, text: col }));
            });

            const secFileSelect = this.byId("editSecondaryFileSelect");
            secFileSelect.destroyItems();
            files.forEach((file, i) => {
                if (i !== primary) {
                    secFileSelect.addItem(new sap.ui.core.Item({ key: String(i), text: file.name }));
                }
            });

            const link = this._editingLinkIndex !== null
                ? this._detectedLinks[this._editingLinkIndex]
                : null;

            if (link) {
                primaryColSelect.setSelectedKey(link.colA);
                secFileSelect.setSelectedKey(String(link.fileB));
            }

            this._populateSecondaryColSelect();
            if (link) this.byId("editSecondaryColSelect").setSelectedKey(link.colB);
        },

        _populateSecondaryColSelect: function () {
            const secFileIdx   = parseInt(this.byId("editSecondaryFileSelect").getSelectedKey(), 10);
            const secColSelect = this.byId("editSecondaryColSelect");
            secColSelect.destroyItems();
            if (isNaN(secFileIdx) || !this._filesData[secFileIdx]) return;
            this._filesData[secFileIdx].headers.forEach(col => {
                secColSelect.addItem(new sap.ui.core.Item({ key: col, text: col }));
            });
        },

        onEditSecondaryFileChanged: function () {
            this._populateSecondaryColSelect();
        },

        onSaveLink: function () {
            const primaryCol = this.byId("editPrimaryColSelect").getSelectedKey();
            const secFileIdx = parseInt(this.byId("editSecondaryFileSelect").getSelectedKey(), 10);
            const secCol     = this.byId("editSecondaryColSelect").getSelectedKey();

            if (!primaryCol || isNaN(secFileIdx) || !secCol) {
                MessageToast.show("Please fill in all fields.");
                return;
            }

            const newLink = {
                fileA:      this._primaryFileIndex,
                fileB:      secFileIdx,
                colA:       primaryCol,
                colB:       secCol,
                confidence: 100,
                level:      "High"
            };

            if (this._editingLinkIndex !== null) {
                this._detectedLinks[this._editingLinkIndex] = newLink;
            } else {
                this._detectedLinks.push(newLink);
            }

            // Upsert into acceptedLinks
            this._acceptedLinks = this._acceptedLinks.filter(
                a => !(a.fileA === newLink.fileA && a.fileB === newLink.fileB)
            );
            this._acceptedLinks.push(newLink);

            this.byId("linkEditPanel").setVisible(false);
            this._editingLinkIndex = null;
            this._renderLinksContainer();
            this._runJoinAndUpdateButtons();
            MessageToast.show("Link saved.");
        },

        onCancelLink: function () {
            this.byId("linkEditPanel").setVisible(false);
            this._editingLinkIndex = null;
        },

        // Toggle inline preview open/closed (join already computed on Accept/Save)
        onProceedFromMapper: function () {
            const section = this.byId("previewSection");
            section.setVisible(!section.getVisible());
        },

        onContinueToTarget: function () {
            const headers = Object.keys((this._joinedRows[0] || {}));
            this._showTargetStep(headers);
            this.byId("previewSection").setVisible(false);
            this.byId("proceedButton").setVisible(false);
            this.byId("continueToTargetButton").setVisible(false);
        },

        // ─── Join Engine ─────────────────────────────────────────────────────────

        _runJoinAndUpdateButtons: function () {
            const primaryIdx = this._primaryFileIndex;
            let result       = this._filesData[primaryIdx].rows;
            let filesJoined  = 1;

            this._acceptedLinks.forEach(link => {
                // Resolve which side is primary vs secondary and orient join columns accordingly
                let secIdx, primaryCol, secCol;
                if (link.fileA === primaryIdx) {
                    secIdx = link.fileB; primaryCol = link.colA; secCol = link.colB;
                } else {
                    secIdx = link.fileA; primaryCol = link.colB; secCol = link.colA;
                }
                const secFile = this._filesData[secIdx];
                if (!secFile) return;
                result = this._joinTablesLeft(result, secFile.rows, primaryCol, secCol);
                filesJoined++;
            });

            this._joinedRows = result;
            this._onJoinReady(filesJoined);
        },

        // LEFT JOIN: keep all rows from A, supplement with matching row from B
        _joinTablesLeft: function (rowsA, rowsB, joinColA, joinColB) {
            const mapB = {};
            rowsB.forEach(row => {
                const key = row[joinColB];
                // Exclude undefined/null/empty — but preserve 0 and other falsy non-empty values
                if (key !== undefined && key !== null && key !== "") {
                    mapB[key] = row;
                }
            });
            return rowsA.map(rowA => {
                const rowB = mapB[rowA[joinColA]] || {};
                return Object.assign({}, rowA, rowB);
            });
        },

        _onJoinReady: function (filesJoined) {
            const rows    = this._joinedRows;
            const headers = Object.keys(rows[0] || {});

            this.byId("previewRowCount").setText(String(rows.length));
            this.byId("previewColCount").setText(String(headers.length));
            this.byId("previewFilesCount").setText(String(filesJoined));

            // Column limit enforcement
            const continueBtn = this.byId("continueToTargetButton");
            this.byId("colWarnStrip").setVisible(false);
            this.byId("colErrorStrip").setVisible(false);
            continueBtn.setEnabled(true);

            if (headers.length > MAX_COLUMNS) {
                this.byId("colErrorStrip").setText(
                    `⛔ ${headers.length} columns detected. RPT-1 supports a maximum of ${MAX_COLUMNS}. ` +
                    `Remove ${headers.length - MAX_COLUMNS} column(s) before proceeding.`
                );
                this.byId("colErrorStrip").setVisible(true);
                continueBtn.setEnabled(false);
            } else if (headers.length > WARN_COLUMNS) {
                this.byId("colWarnStrip").setText(
                    `⚠️ ${headers.length} columns detected. RPT-1 works best under ${WARN_COLUMNS}. ` +
                    `Consider removing less useful columns.`
                );
                this.byId("colWarnStrip").setVisible(true);
            }

            // Blank rows warning
            const blankCount = rows.filter(row =>
                headers.some(h => row[h] === "" || row[h] === undefined || row[h] === null)
            ).length;

            const blankStrip = this.byId("blankRowsStrip");
            if (blankCount > 0) {
                blankStrip.setText(
                    `⚠️ ${blankCount} row(s) have blank values after join. ` +
                    `RPT-1 handles missing values.`
                );
                blankStrip.setVisible(true);
            } else {
                blankStrip.setVisible(false);
            }

            this._previewRows    = rows;
            this._previewHeaders = headers;
            this._renderPreviewTable(rows, headers);

            // Show action buttons; preview stays collapsed until user clicks "Preview"
            this.byId("proceedButton").setVisible(true);
            this.byId("continueToTargetButton").setVisible(true);
            this.byId("targetBox").setVisible(false);
            this.byId("runButton").setVisible(false);
        },

        // ─── Preview Table ───────────────────────────────────────────────────────

        _renderPreviewTable: function (rows, headers) {
            const modelData = rows.map(row => {
                const r = {};
                headers.forEach(col => {
                    r[col] = (row[col] !== undefined && row[col] !== null) ? String(row[col]) : "—";
                });
                return r;
            });
            this.getView().setModel(new JSONModel({ rows: modelData }), "preview");

            const oTable = this.byId("previewTable");
            oTable.destroyColumns();
            oTable.bindRows("preview>/rows");
            headers.forEach(col => {
                oTable.addColumn(new sap.ui.table.Column({
                    label:          new sap.m.Label({ text: col }),
                    template:       new sap.m.Text({ text: `{preview>${col}}`, wrapping: false }),
                    sortProperty:   col,
                    filterProperty: col,
                    width:          "150px"
                }));
            });
        },

        onSearchPreview: function (oEvent) {
            const query = (oEvent.getParameter("newValue") || "").toLowerCase().trim();
            if (!this._previewRows) return;
            const filtered = !query
                ? this._previewRows
                : this._previewRows.filter(row =>
                    Object.values(row).some(v =>
                        v !== undefined && v !== null && String(v).toLowerCase().indexOf(query) > -1
                    )
                );
            this._renderPreviewTable(filtered, this._previewHeaders);
        },

        onExportPreviewCSV: function () {
            if (!this._previewRows || this._previewRows.length === 0) {
                MessageToast.show("No preview data.");
                return;
            }
            this._downloadCSVBlob(this._previewRows, this._previewHeaders, "preview.csv");
        },

        // ─── Target Step ─────────────────────────────────────────────────────────

        _showTargetStep: function (headers) {
            const select = this.byId("targetColumnSelect");
            select.destroyItems();
            select.addItem(new sap.ui.core.Item({ key: "", text: "-- Select a column --" }));
            headers.forEach(col => {
                select.addItem(new sap.ui.core.Item({ key: col, text: col }));
            });

            this.byId("taskTypeOverride").setSelectedKey("auto");
            this.byId("detectedTypeText").setText("—");
            this.byId("predictionPlanPanel").setVisible(false);
            this.byId("lowContextStrip").setVisible(false);
            this.byId("runButton").setVisible(false);
            this.byId("targetBox").setVisible(true);

            // Auto-select first column and show prediction plan immediately
            if (headers.length > 0) {
                select.setSelectedKey(headers[0]);
                this._updatePredictionPlan(headers[0]);
            }
        },

        onTargetColumnChange: function () {
            const targetCol = this.byId("targetColumnSelect").getSelectedKey();
            if (!targetCol) {
                this.byId("predictionPlanPanel").setVisible(false);
                this.byId("runButton").setVisible(false);
                return;
            }
            this._updatePredictionPlan(targetCol);
        },

        onTypeOverrideChange: function () {
            const targetCol = this.byId("targetColumnSelect").getSelectedKey();
            if (targetCol) this._updatePredictionPlan(targetCol);
        },

        _detectTargetType: function (rows, targetCol) {
            const values = rows
                .map(r => r[targetCol])
                .filter(v => v !== "" && v !== undefined && v !== null);

            if (values.length === 0) return "classification";

            const allNumeric  = values.every(v => !isNaN(parseFloat(v)) && isFinite(v));
            const uniqueCount = new Set(values).size;

            if (!allNumeric || uniqueCount <= 20) return "classification";
            return "regression";
        },

        _getEffectiveType: function (detectedType) {
            const override = this.byId("taskTypeOverride").getSelectedKey();
            return override === "auto" ? detectedType : override;
        },

        _updatePredictionPlan: function (targetCol) {
            const rows          = this._joinedRows;
            const detectedType  = this._detectTargetType(rows, targetCol);
            const effectiveType = this._getEffectiveType(detectedType);

            this.byId("detectedTypeText").setText(
                `Auto-detected: ${detectedType.charAt(0).toUpperCase() + detectedType.slice(1)}`
            );

            const contextRows  = rows.filter(r => r[targetCol] !== "" && r[targetCol] !== undefined && r[targetCol] !== null);
            const predictRows  = rows.filter(r => r[targetCol] === "" || r[targetCol] === undefined || r[targetCol] === null);
            const contextCount = contextRows.length;
            const predictCount = predictRows.length;
            const contextSent  = Math.min(contextCount, MAX_CONTEXT);
            const batches      = Math.ceil(predictCount / BATCH_SIZE) || 1;
            const strategy     = effectiveType === "regression"
                ? "Quartile binning (4 bins, equal rows per bin)"
                : "Stratified by class (equal rows per class)";

            this.byId("planTotalRows").setText(String(rows.length));
            this.byId("planContextRows").setText(String(contextCount));
            this.byId("planPredictRows").setText(String(predictCount));
            this.byId("planContextSent").setText(
                contextCount > MAX_CONTEXT
                    ? `${contextSent} (capped from ${contextCount} — stratified)`
                    : `${contextSent} (all labeled rows)`
            );
            this.byId("planBatches").setText(`${batches} × ${BATCH_SIZE} rows`);
            this.byId("planStrategy").setText(strategy);

            this.byId("lowContextStrip").setVisible(contextCount < 50);
            this.byId("predictionPlanPanel").setVisible(true);
            this.byId("runButton").setVisible(predictCount > 0);

            if (predictCount === 0) {
                MessageToast.show(`No blank rows in '${targetCol}' — nothing to predict.`);
            }
        },

        // ─── Prediction Engine ───────────────────────────────────────────────────

        onRunPrediction: async function () {
            const targetColumn = this.byId("targetColumnSelect").getSelectedKey();
            if (!targetColumn) {
                MessageToast.show("Please select a column to predict.");
                return;
            }

            const sourceRows = this._joinedRows || (this._filesData[0] && this._filesData[0].rows);
            if (!sourceRows || sourceRows.length === 0) {
                MessageToast.show("No data found.");
                return;
            }

            // Stamp a stable _rowIdx on each row so predictions can be matched back reliably
            const rows = sourceRows.map((r, i) => Object.assign({}, r, { _rowIdx: i }));

            const detectedType = this._detectTargetType(rows, targetColumn);
            const taskType     = this._getEffectiveType(detectedType);

            const contextRows = rows.filter(r => r[targetColumn] !== "" && r[targetColumn] !== undefined && r[targetColumn] !== null);
            const predictRows = rows.filter(r => r[targetColumn] === "" || r[targetColumn] === undefined || r[targetColumn] === null);

            if (predictRows.length === 0) {
                MessageToast.show("No blank rows to predict.");
                return;
            }

            const sampledContext = this._getStratifiedContext(contextRows, targetColumn, taskType);
            const batches        = this._buildBatches(sampledContext, predictRows, BATCH_SIZE);

            this.getView().setBusy(true);
            try {
                const predMap = await this._runBatches(batches, targetColumn, taskType);
                this._displayResults(predMap, rows, targetColumn);
            } catch (err) {
                MessageBox.error(`Prediction failed: ${err.message}`);
            } finally {
                this.getView().setBusy(false);
            }
        },

        // Iterative async batch runner — avoids recursive call stack growth
        _runBatches: async function (batches, targetColumn, taskType) {
            const predMap = {};

            for (let i = 0; i < batches.length; i++) {
                MessageToast.show(`Batch ${i + 1} of ${batches.length}...`);

                const batch   = batches[i];
                const payload = this._buildRPT1Payload(batch.context, batch.predict, targetColumn, taskType);

                const response = await fetch("/odata/v4/predictor/uploadAndPredict", {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body:    JSON.stringify({ payload: JSON.stringify(payload) })
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} on batch ${i + 1}`);
                }

                const result = await response.json();
                let parsed;
                try {
                    parsed = JSON.parse(result.value);
                } catch {
                    throw new Error(`Batch ${i + 1}: unexpected response format`);
                }

                // Handle both RPT-1 response shapes defensively
                const predictions =
                    (parsed.prediction && parsed.prediction.predictions) ||
                    parsed.predictions ||
                    null;

                if (!predictions) {
                    throw new Error(`Batch ${i + 1}: RPT-1 returned no predictions`);
                }

                predictions.forEach(pred => {
                    const predData = pred[targetColumn][0];
                    predMap[String(pred._index)] = {
                        value:      predData.prediction,
                        confidence: Math.round(predData.confidence * 100)
                    };
                });
            }

            return predMap;
        },

        // ─── Stratified Sampling ─────────────────────────────────────────────────

        _getStratifiedContext: function (contextRows, targetCol, taskType) {
            if (contextRows.length <= MAX_CONTEXT) return contextRows;
            return taskType === "regression"
                ? this._stratifyByQuartile(contextRows, targetCol, MAX_CONTEXT)
                : this._stratifyByClass(contextRows, targetCol, MAX_CONTEXT);
        },

        _stratifyByClass: function (rows, targetCol, maxRows) {
            const classes = {};
            rows.forEach(r => {
                const cls = r[targetCol];
                if (!classes[cls]) classes[cls] = [];
                classes[cls].push(r);
            });
            const keys     = Object.keys(classes);
            const perClass = Math.floor(maxRows / keys.length);
            const result   = [];
            keys.forEach(cls => {
                const shuffled = classes[cls].slice().sort(() => Math.random() - 0.5);
                result.push(...shuffled.slice(0, perClass));
            });
            return result;
        },

        _stratifyByQuartile: function (rows, targetCol, maxRows) {
            const sorted  = rows.slice().sort((a, b) => parseFloat(a[targetCol]) - parseFloat(b[targetCol]));
            const perBin  = Math.floor(maxRows / 4);
            const binSize = Math.floor(sorted.length / 4);
            const result  = [];
            for (let q = 0; q < 4; q++) {
                const bin = sorted.slice(q * binSize, (q + 1) * binSize);
                result.push(...bin.sort(() => Math.random() - 0.5).slice(0, perBin));
            }
            return result;
        },

        _buildBatches: function (contextRows, predictRows, batchSize) {
            const batches = [];
            for (let i = 0; i < predictRows.length; i += batchSize) {
                batches.push({
                    context: contextRows,
                    predict: predictRows.slice(i, i + batchSize)
                });
            }
            return batches;
        },

        // ─── Results ─────────────────────────────────────────────────────────────

        _displayResults: function (predMap, allRows, targetColumn) {
            const mergedRows = allRows.map(row => {
                const merged = Object.assign({}, row);
                const entry  = predMap[String(row._rowIdx)];
                if (entry) {
                    merged[targetColumn]  = entry.value;
                    merged["_confidence"] = entry.confidence; // numeric 0–100
                    merged["_predicted"]  = true;
                } else {
                    merged["_confidence"] = null;
                    merged["_predicted"]  = false;
                }
                return merged;
            });

            this._allRows      = mergedRows;
            this._targetColumn = targetColumn;

            this.byId("resultsBox").setVisible(true);
            sap.ui.getCore().applyChanges(); // flush DOM so table container renders before bindRows
            this._updateSummaryCard(mergedRows);
            this._renderResultsTable(mergedRows, targetColumn);

            MessageToast.show(`✅ ${Object.keys(predMap).length} prediction(s) complete!`);
        },

        _renderResultsTable: function (rows, targetColumn) {
            if (!rows || rows.length === 0) return;

            const filterKey   = this.byId("confidenceFilter").getSelectedKey();
            const threshold   = filterKey === "all" ? 0 : parseInt(filterKey, 10);
            const searchQuery = this._resultsSearchQuery || "";

            let displayRows = rows.filter(row =>
                !row._predicted || filterKey === "all" || row._confidence >= threshold
            );

            if (searchQuery) {
                displayRows = displayRows.filter(row =>
                    Object.keys(row).some(k => {
                        if (k.charAt(0) === "_") return false;
                        const v = row[k];
                        return v !== undefined && v !== null && String(v).toLowerCase().indexOf(searchQuery) > -1;
                    })
                );
            }

            const totalPredicted = rows.filter(r => r._predicted).length;
            const shownPredicted = displayRows.filter(r => r._predicted).length;
            this.byId("filteredCountText").setText(
                `Showing ${shownPredicted} of ${totalPredicted} predicted rows`
            );

            const colNames = Object.keys(rows[0]).filter(
                k => k !== "_predicted" && k !== "_confidence" && k !== "_origIndex" && k !== "_rowIdx"
            );

            const modelData = displayRows.map(row => {
                const r = {};
                colNames.forEach(col => {
                    r[col] = (row[col] !== undefined && row[col] !== null) ? String(row[col]) : "—";
                });
                r["_confidenceDisplay"] = (row._predicted && row._confidence !== null)
                    ? `${row._confidence}%` : "—";
                r["_targetState"] = row._predicted ? "Information" : "None";
                r["_highlight"]   = row._predicted && row._confidence !== null
                    ? (row._confidence >= 80 ? "Success" : row._confidence >= 55 ? "Warning" : "Error")
                    : "None";
                return r;
            });

            this.getView().setModel(new JSONModel({ rows: modelData }), "results");

            const oTable = this.byId("resultsTable");
            oTable.destroyColumns();
            oTable.bindRows("results>/rows");

            colNames.forEach(col => {
                const isTarget = col === targetColumn;
                oTable.addColumn(new sap.ui.table.Column({
                    label:        new sap.m.Label({ text: col }),
                    template:     isTarget
                        ? new sap.m.ObjectStatus({ text: `{results>${col}}`, state: "{results>_targetState}" })
                        : new sap.m.Text({ text: `{results>${col}}`, wrapping: false }),
                    sortProperty: col,
                    width:        "150px"
                }));
            });

            oTable.addColumn(new sap.ui.table.Column({
                label:        new sap.m.Label({ text: "Confidence" }),
                template:     new sap.m.Text({ text: "{results>_confidenceDisplay}", wrapping: false }),
                sortProperty: "_confidence",
                width:        "120px"
            }));
        },

        _updateSummaryCard: function (rows) {
            const predicted = rows.filter(r => r._predicted);
            this.byId("summaryTotal").setText(String(predicted.length));
            this.byId("summaryHigh").setText(String(predicted.filter(r => r._confidence >= 80).length));
            this.byId("summaryMedium").setText(String(predicted.filter(r => r._confidence >= 55 && r._confidence < 80).length));
            this.byId("summaryLow").setText(String(predicted.filter(r => r._confidence < 55).length));
        },

        onConfidenceFilterChange: function () {
            if (this._allRows && this._targetColumn) {
                this._renderResultsTable(this._allRows, this._targetColumn);
            }
        },

        onSearchResults: function (oEvent) {
            this._resultsSearchQuery = (oEvent.getParameter("newValue") || "").toLowerCase().trim();
            if (this._allRows && this._targetColumn) {
                this._renderResultsTable(this._allRows, this._targetColumn);
            }
        },

        // ─── Export ──────────────────────────────────────────────────────────────

        onExportExcel: function () {
            const rows = this._allRows;
            if (!rows || rows.length === 0) { MessageToast.show("No results to export."); return; }

            const colNames = Object.keys(rows[0]).filter(
                k => k !== "_predicted" && k !== "_confidence" && k !== "_origIndex" && k !== "_rowIdx"
            );
            const columns = [
                ...colNames.map(col => ({ label: col, property: col, type: exportLibrary.EdmType.String })),
                { label: "Confidence", property: "_confDisplay", type: exportLibrary.EdmType.String }
            ];
            const data = rows.map(row => {
                const r = {};
                colNames.forEach(col => { r[col] = (row[col] !== undefined && row[col] !== null) ? String(row[col]) : ""; });
                r["_confDisplay"] = (row._predicted && row._confidence !== null) ? `${row._confidence}%` : "";
                return r;
            });

            new Spreadsheet({
                workbook:   { columns },
                dataSource: data,
                fileName:   "rpt1-predictions.xlsx"
            }).build().then(() => MessageToast.show("Excel export started."));
        },

        onDownloadCSV: function () {
            const rows = this._allRows;
            if (!rows || rows.length === 0) { MessageToast.show("No results to download."); return; }

            const colNames = Object.keys(rows[0]).filter(
                k => k !== "_predicted" && k !== "_confidence" && k !== "_origIndex" && k !== "_rowIdx"
            );
            const exportRows = rows.map(row => {
                const r = Object.assign({}, row);
                r["Confidence"] = (row._predicted && row._confidence !== null) ? `${row._confidence}%` : "";
                return r;
            });
            this._downloadCSVBlob(exportRows, [...colNames, "Confidence"], "rpt1-predictions.csv");
        },

        // Shared CSV download helper — used by both preview and results export
        _downloadCSVBlob: function (rows, headers, filename) {
            const escape = v => {
                const s = (v !== undefined && v !== null) ? String(v) : "";
                return (s.indexOf(",") > -1 || s.indexOf('"') > -1 || s.indexOf("\n") > -1)
                    ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const lines = [
                headers.map(escape).join(","),
                ...rows.map(row => headers.map(h => escape(row[h])).join(","))
            ];
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement("a");
            a.href     = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Defer revoke to give browser time to initiate the download
            setTimeout(() => URL.revokeObjectURL(url), 100);
        },

        // ─── Auto-Detection Engine ───────────────────────────────────────────────

        _enrichFilesWithSamples: function () {
            this._filesData.forEach(file => {
                file.sampleValues = {};
                file.headers.forEach(col => {
                    file.sampleValues[col] = file.rows
                        .slice(0, 5)
                        .map(r => r[col])
                        .filter(v => v !== "" && v !== undefined && v !== null);
                });
            });
        },

        _detectRelationships: function () {
            const links = [];
            const files = this._filesData;
            for (let i = 0; i < files.length; i++) {
                for (let j = i + 1; j < files.length; j++) {
                    const best = this._bestLinkBetween(files[i], files[j]);
                    if (best) {
                        best.fileA = i;
                        best.fileB = j;
                        links.push(best);
                    }
                }
            }
            return links;
        },

        _bestLinkBetween: function (fileA, fileB) {
            let best = null;
            fileA.headers.forEach(colA => {
                fileB.headers.forEach(colB => {
                    let score = 0;
                    const a = colA.toLowerCase();
                    const b = colB.toLowerCase();

                    if (a === b) {
                        score += 60;
                    } else if (a.indexOf(b) > -1 || b.indexOf(a) > -1) {
                        score += 25;
                    }

                    // Value overlap: compare first 50 rows of each file
                    const sampleA = fileA.rows
                        .slice(0, 50)
                        .map(r => String(r[colA] !== undefined && r[colA] !== null ? r[colA] : "").trim())
                        .filter(v => v !== "");
                    const setB = {};
                    fileB.rows.slice(0, 50).forEach(r => {
                        const v = String(r[colB] !== undefined && r[colB] !== null ? r[colB] : "").trim();
                        if (v !== "") setB[v] = true;
                    });

                    const overlap = sampleA.length > 0
                        ? sampleA.filter(v => setB[v]).length / sampleA.length
                        : 0;
                    score += Math.round(overlap * 15);

                    if (score < 20) return;

                    if (!best || score > best.confidence) {
                        best = {
                            colA, colB,
                            confidence: score,
                            level: score >= 80 ? "High" : score >= 50 ? "Medium" : "Low"
                        };
                    }
                });
            });
            return best;
        },

        // ─── RPT-1 Payload Builder ────────────────────────────────────────────────

        _buildRPT1Payload: function (contextRows, predictRows, targetColumn, taskType) {
            const allRows = [];

            contextRows.forEach((row, i) => {
                const r = Object.assign({}, row);
                delete r._rowIdx;
                r["_index"] = `ctx_${i}`;
                allRows.push(r);
            });

            predictRows.forEach(row => {
                const r      = Object.assign({}, row);
                const rowIdx = r._rowIdx !== undefined ? String(r._rowIdx) : String(allRows.length);
                delete r._rowIdx;
                r["_index"]       = rowIdx;
                r[targetColumn]   = "[PREDICT]";
                allRows.push(r);
            });

            const sample = allRows[0] || {};
            const schema = {};
            Object.keys(sample).forEach(col => {
                if (col === "_index") return;
                const val = sample[col];
                schema[col] = { dtype: (!isNaN(parseFloat(val)) && isFinite(val)) ? "numeric" : "string" };
            });

            return {
                prediction_config: {
                    target_columns: [{
                        name:                   targetColumn,
                        prediction_placeholder: "[PREDICT]",
                        task_type:              taskType
                    }]
                },
                index_column: "_index",
                rows:         allRows,
                data_schema:  schema
            };
        },

        // ─── CSV Parser (RFC 4180 compliant) ─────────────────────────────────────

        _parseCSV: function (text) {
            // Normalize all line endings to \n
            const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
            let pos = 0;

            function parseField() {
                if (normalized[pos] !== '"') {
                    // Unquoted: read until comma or newline
                    let field = "";
                    while (pos < normalized.length && normalized[pos] !== "," && normalized[pos] !== "\n") {
                        field += normalized[pos++];
                    }
                    return field.trim();
                }
                // Quoted: handle escaped double-quotes ("")
                pos++; // consume opening quote
                let field = "";
                while (pos < normalized.length) {
                    if (normalized[pos] === '"') {
                        if (normalized[pos + 1] === '"') {
                            field += '"';
                            pos += 2; // consume escaped quote pair
                        } else {
                            pos++; // consume closing quote
                            break;
                        }
                    } else {
                        field += normalized[pos++];
                    }
                }
                return field;
            }

            function parseLine() {
                const fields = [];
                while (pos < normalized.length && normalized[pos] !== "\n") {
                    fields.push(parseField());
                    if (pos < normalized.length && normalized[pos] === ",") pos++;
                }
                if (pos < normalized.length && normalized[pos] === "\n") pos++;
                return fields;
            }

            const headers = parseLine();
            const rows    = [];
            while (pos < normalized.length) {
                const values = parseLine();
                if (values.length === 0 || (values.length === 1 && values[0] === "")) continue; // skip blank lines
                const row = {};
                headers.forEach((h, i) => { row[h] = values[i] !== undefined ? values[i] : ""; });
                rows.push(row);
            }
            return rows;
        }

    });
});
