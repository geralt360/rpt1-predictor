const cds = require("@sap/cds");
const express = require("express");

cds.on("bootstrap", (app) => {
    // CAP's default body-parser limit is 1MB — raise it to handle large CSV payloads
    app.use(express.json({ limit: "25mb" }));
    app.use(express.urlencoded({ extended: true, limit: "25mb" }));
});

module.exports = cds.server;
