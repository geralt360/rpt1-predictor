sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "sap/m/StandardListItem",
    "sap/ui/export/Spreadsheet",
    "sap/ui/export/library"
], function (Controller, MessageToast, StandardListItem, Spreadsheet, exportLibrary) {
    "use strict";

    var EdmType = exportLibrary.EdmType;

    return Controller.extend("rptpredictor.rptpredictor.controller.RPTView", {

        // Store parsed file data
        _filesData: [],
        _selectedJoinA: null,
        _selectedJoinB: null,

        // Called when files are selected
        onFilesSelected: function (oEvent) {
            var dom = this.byId("fileUploader").getFocusDomRef();
            var files = dom && dom.files;

            if (!files || files.length === 0) return;

            this._filesData = [];
            var that = this;
            var filesRead = 0;

            Array.from(files).forEach(function (file, index) {
                var reader = new FileReader();
                reader.onload = function (e) {
                    var rows = that._parseCSV(e.target.result);
                    that._filesData[index] = {
                        name: file.name,
                        rows: rows,
                        headers: Object.keys(rows[0] || {})
                    };
                    filesRead++;
                    if (filesRead === files.length) {
                        that._onAllFilesRead();
                    }
                };
                reader.readAsText(file);
            });
        },

        // Called once all files are read
        _onAllFilesRead: function () {
            if (this._filesData.length === 1) {
                // Single file — skip relationship step
                this._showTargetStep(this._filesData[0].headers);
                MessageToast.show("1 file loaded — " + this._filesData[0].rows.length + " rows");

            } else if (this._filesData.length >= 2) {
                // Multiple files — show relationship mapper
                this._showRelationshipMapper();
                MessageToast.show(
                    this._filesData.length + " files loaded — connect them below"
                );
            }
        },

        // Show the column matcher for 2 files
        _showRelationshipMapper: function () {
            var fileA = this._filesData[0];
            var fileB = this._filesData[1];

            // Update titles
            this.byId("titleFileA").setText(fileA.name);
            this.byId("titleFileB").setText(fileB.name);

            // Populate File A columns list
            var listA = this.byId("columnsListA");
            listA.destroyItems();
            fileA.headers.forEach(function (col) {
                listA.addItem(new StandardListItem({ title: col }));
            });

            // Populate File B columns list
            var listB = this.byId("columnsListB");
            listB.destroyItems();
            fileB.headers.forEach(function (col) {
                listB.addItem(new StandardListItem({ title: col }));
            });

            // Show relationship box
            this.byId("relationshipBox").setVisible(true);
            this.byId("targetBox").setVisible(false);
            this.byId("runButton").setVisible(false);
            this._selectedJoinA = null;
            this._selectedJoinB = null;
            this.byId("joinColumnsText").setText("— select columns —");
        },

        // User selects join column from File A
        onColumnASelected: function (oEvent) {
            var item = oEvent.getParameter("listItem");
            this._selectedJoinA = item.getTitle();
            this._updateJoinIndicator();
        },

        // User selects join column from File B
        onColumnBSelected: function (oEvent) {
            var item = oEvent.getParameter("listItem");
            this._selectedJoinB = item.getTitle();
            this._updateJoinIndicator();
        },

        // Update the arrow text and show target step if both selected
        _updateJoinIndicator: function () {
            var a = this._selectedJoinA;
            var b = this._selectedJoinB;

            if (a && b) {
                this.byId("joinColumnsText").setText(a + " = " + b);

                // Join the tables and show target column picker
                var joined = this._joinTables(
                    this._filesData[0].rows,
                    this._filesData[1].rows,
                    a, b
                );
                this._joinedRows = joined;
                var headers = Object.keys(joined[0] || {});
                this._showTargetStep(headers);
                MessageToast.show("Joined: " + joined.length + " rows matched");
            } else if (a) {
                this.byId("joinColumnsText").setText(a + " = ?");
            } else if (b) {
                this.byId("joinColumnsText").setText("? = " + b);
            }
        },

        // Show the target column picker
        _showTargetStep: function (headers) {
            var select = this.byId("targetColumnSelect");
            select.destroyItems();

            // Add default option
            var core = sap.ui.getCore();
            select.addItem(new sap.ui.core.Item({ key: "", text: "-- Select a column --" }));

            headers.forEach(function (col) {
                select.addItem(new sap.ui.core.Item({ key: col, text: col }));
            });

            this.byId("targetBox").setVisible(true);
            this.byId("runButton").setVisible(true);
        },

        // Run prediction
        onRunPrediction: function () {
            var that = this;
            var targetColumn = this.byId("targetColumnSelect").getSelectedKey();

            if (!targetColumn) {
                MessageToast.show("Please select a column to predict.");
                return;
            }

            // Use joined rows if 2 files, else single file rows
            var rows = this._joinedRows || (this._filesData[0] && this._filesData[0].rows);

            if (!rows || rows.length === 0) {
                MessageToast.show("No data found.");
                return;
            }

            // var payload = this._buildRPT1Payload(rows, targetColumn);
            // console.log("RPT-1 Payload:", JSON.stringify(payload, null, 2));
            // MessageToast.show("Payload ready — " + payload.rows.length + " rows");

            var payload = this._buildRPT1Payload(rows, targetColumn);
            console.log("RPT-1 Payload:", JSON.stringify(payload, null, 2));
            MessageToast.show("Calling RPT-1 API...");

            // Call RPT-1 API
            var payloadStr = JSON.stringify(payload);

            $.ajax({
                url: "/odata/v4/predictor/uploadAndPredict",
                method: "POST",
                contentType: "application/json",
                data: JSON.stringify({ payload: payloadStr }),
                success: function (result) {
                    var parsed = JSON.parse(result.value);
                    var predictions = parsed.prediction.predictions;

                    var predMap = {};
                    predictions.forEach(function (pred) {
                        var predData = pred[targetColumn][0];
                        predMap[String(pred._index)] = {
                            value: predData.prediction,
                            confidence: Math.round(predData.confidence * 100)
                        };
                    });

                    var allRows = rows.map(function (row, index) {
                        var merged = Object.assign({}, row);
                        if (predMap[String(index)]) {
                            merged[targetColumn] = predMap[String(index)].value;
                            merged["_confidence"] = predMap[String(index)].confidence + "%";
                            merged["_predicted"] = true;
                        } else {
                            merged["_confidence"] = "—";
                            merged["_predicted"] = false;
                        }
                        return merged;
                    });

                    var oTable = that.byId("resultsTable");
                    oTable.destroyItems();

                    var oColumns = oTable.getAggregation("columns");
                    oTable.destroyAggregation("columns");

                    var colNames = Object.keys(allRows[0]).filter(function (k) {
                        return k !== "_predicted";
                    });

                    colNames.forEach(function (col) {
                        var label = col === "_confidence" ? "Confidence" : col;
                        oTable.addColumn(new sap.m.Column({
                            header: new sap.m.Text({ text: label })
                        }));
                    });

                    // Add rows
                    allRows.forEach(function (row) {
                        var cells = colNames.map(function (col) {
                            var text = row[col] !== undefined ? String(row[col]) : "—";
                            if (col === targetColumn && row._predicted) {
                                return new sap.m.ObjectStatus({
                                    text: text,
                                    state: "Information"
                                });
                            }
                            return new sap.m.Text({ text: text });
                        });

                        oTable.addItem(new sap.m.ColumnListItem({
                            highlight: row._predicted ? "Information" : "None",
                            cells: cells
                        }));
                    });

                    that.byId("resultsBox").setVisible(true);
                    MessageToast.show("✅ " + predictions.length + " prediction(s) complete!");
                },
                error: function (err) {
                    console.error("Error:", err);
                    MessageToast.show("API call failed — check console.");
                }
            });
        },

        _parseCSV: function (csvText) {
            var lines = csvText.trim().split("\n");
            var headers = lines[0].split(",").map(function (h) {
                return h.trim().replace(/"/g, "");
            });
            var rows = [];
            for (var i = 1; i < lines.length; i++) {
                var values = lines[i].split(",").map(function (v) {
                    return v.trim().replace(/"/g, "");
                });
                var row = {};
                headers.forEach(function (h, idx) {
                    row[h] = values[idx];
                });
                rows.push(row);
            }
            return rows;
        },

        _joinTables: function (rowsA, rowsB, joinColumnA, joinColumnB) {
            var mapB = {};
            rowsB.forEach(function (row) {
                var key = row[joinColumnB];
                if (key) mapB[key] = row;
            });
            var joined = [];
            rowsA.forEach(function (rowA) {
                var key = rowA[joinColumnA];
                var rowB = mapB[key];
                if (rowB) {
                    joined.push(Object.assign({}, rowA, rowB));
                }
            });
            return joined;
        },

        _buildRPT1Payload: function (joinedRows, targetColumn) {
            var contextRows = [];
            var predictRows = [];

            joinedRows.forEach(function (row, index) {
                var newRow = Object.assign({}, row);
                newRow["_index"] = String(index);
                if (!newRow[targetColumn] || newRow[targetColumn] === "") {
                    newRow[targetColumn] = "[PREDICT]";
                    predictRows.push(newRow);
                } else {
                    contextRows.push(newRow);
                }
            });

            var schema = {};
            Object.keys(joinedRows[0]).forEach(function (col) {
                var val = joinedRows[0][col];
                var isNumeric = !isNaN(parseFloat(val)) && isFinite(val);
                schema[col] = { dtype: isNumeric ? "numeric" : "string" };
            });

            return {
                prediction_config: {
                    target_columns: [{
                        name: targetColumn,
                        prediction_placeholder: "[PREDICT]",
                        task_type: "classification"
                    }]
                },
                index_column: "_index",
                rows: contextRows.concat(predictRows),
                data_schema: schema
            };
        }

    });
});