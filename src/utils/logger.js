// steam-id-processor\src\utils\logger.js
const winston = require('winston');
const path = require('path');
const fs = require('fs-extra');
const CONFIG = require('../../config/config');

// Debug log to see what path is being used
console.log(`Log directory path: ${CONFIG.LOG_DIR}`);

// Ensure logs directory exists
fs.ensureDirSync(CONFIG.LOG_DIR);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ 
      filename: path.resolve(CONFIG.LOG_DIR, 'error.log'), 
      level: 'error' 
    }),
    new winston.transports.File({ 
      filename: path.resolve(CONFIG.LOG_DIR, 'steam_id_processor.log')
    })
  ]
});

module.exports = logger;