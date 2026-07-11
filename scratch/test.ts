import "dotenv/config";
import { fetchCandles } from "./artifacts/api-server/dist/index.mjs"; // Adjust based on exports

// Wait, the dist/index.mjs might not export fetchCandles directly. Let's just run curl against the API server.
