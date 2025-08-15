// steam-id-processor/src/api-main.js
const ApiServer = require('./api-server');
const logger = require('./utils/logger');

class ApiMain {
  constructor() {
    this.apiServer = null;
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down API server gracefully...');
      this.shutdown();
    });
    
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down API server gracefully...');
      this.shutdown();
    });
    
    process.on('uncaughtException', (error) => {
      logger.error(`Uncaught exception in API server: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
      this.shutdown();
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error(`Unhandled rejection in API server at ${promise}: ${reason}`);
      // Don't exit on unhandled rejections, just log them
    });
  }

  async start() {
    try {
      logger.info('Starting Steam ID Processor API Server');
      logger.info('=====================================');
      
      this.apiServer = new ApiServer();
      await this.apiServer.start();
      
      logger.info('✅ API Server started successfully');
      logger.info('Ready to receive HTTP requests for profile management');
      
    } catch (error) {
      logger.error(`Failed to start API server: ${error.message}`);
      process.exit(1);
    }
  }

  async shutdown() {
    try {
      logger.info('Shutting down API server...');
      
      if (this.apiServer) {
        await this.apiServer.stop();
      }
      
      logger.info('API server shutdown complete');
      process.exit(0);
      
    } catch (error) {
      logger.error(`Error during API server shutdown: ${error.message}`);
      process.exit(1);
    }
  }
}

// Start the API server
if (require.main === module) {
  const apiMain = new ApiMain();
  apiMain.start();
}

module.exports = ApiMain;