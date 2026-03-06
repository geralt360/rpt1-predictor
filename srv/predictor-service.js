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

        try {
            const response = await fetch("https://rpt.cloud.sap/api/predict", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: payload
            });

            const result = await response.json();
            return JSON.stringify(result);

        } catch (err) {
            req.error(500, "RPT-1 API call failed: " + err.message);
        }
    });
});
