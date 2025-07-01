// src/lib/logger.ts

import {createLogger, format, transports} from "winston";

const logger = createLogger({
  level: "info", // Set the logging level ('error', 'warn', 'info', 'verbose', 'debug', 'silly')
  format: format.combine(
    format.timestamp({format: "YYYY-MM-DD HH:mm:ss"}),
    format.printf(
      (info) =>
        `[${info.timestamp}] ${info.level.toUpperCase()}: ${info.message}`
    )
  ),
  transports: [
    new transports.Console(),
    // You can add file transports if needed
    // new transports.File({ filename: 'combined.log' }),
  ],
});

export default logger;
