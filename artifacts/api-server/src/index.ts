import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, "0.0.0.0", (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening on 0.0.0.0");
});

const shutdown = async () => {
  logger.info("Received termination signal. Shutting down gracefully...");
  
  const closeServer = new Promise((resolve) => server.close(resolve));
  const timeout = new Promise((resolve) => setTimeout(resolve, 5000));
  
  await Promise.race([closeServer, timeout]);
  
  logger.info("Server closed or timed out. Exiting...");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
