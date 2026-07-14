import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

import rateLimit from "express-rate-limit";

// Global Rate Limiter: 100 requests per 1-minute window
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 500, 
  standardHeaders: true, 
  legacyHeaders: false, 
  handler: (req, res, next, options) => {
    // Return the exact JSON payload format requested by the mobile dev team
    const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
    res.status(options.statusCode).json({
      error: "Too many requests",
      retryAfter: retryAfterSeconds,
    });
  },
});

// Apply rate limiting to all requests
app.use(limiter);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
