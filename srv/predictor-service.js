require("dotenv").config();
const cds = require("@sap/cds");

module.exports = cds.service.impl(async function () {
    this.on("uploadAndPredict", async (req) => {
        const { payload } = req.data;
        const apiKey = process.env.RPT1_API_KEY;

        if (!apiKey) {
            req.error(500, "RPT-1 API key not configured");
            return;
        }

        let response;
        try {
            response = await fetch("https://rpt.cloud.sap/api/predict", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: payload
            });
        } catch (err) {
            req.error(503, "Network error calling RPT-1 API: " + err.message);
            return;
        }

        // Surface HTTP errors (401, 429, 500, etc.) so the client sees a real failure
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            req.error(response.status, `RPT-1 API returned ${response.status}: ${body}`);
            return;
        }

        const result = await response.json();
        return JSON.stringify(result);
    });
});
