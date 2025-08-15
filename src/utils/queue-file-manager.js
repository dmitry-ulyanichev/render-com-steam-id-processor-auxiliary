// steam-id-processor/src/utils/queue-file-manager.js
const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

class QueueFileManager {
  constructor(queueFilePath) {
    this.queueFilePath = queueFilePath;
    this.lockFilePath = `${queueFilePath}.lock`;
    this.processId = process.pid;
    this.maxRetries = 3; // Reduced retries to fail faster
    this.baseRetryDelay = 200; // 200ms base delay
    this.lockTimeout = 300000; // 5 minutes max lock age (was 30 seconds)
  }

  /**
   * Execute operation with file lock protection
   * @param {Function} operation - Async function to execute with lock
   * @param {Object} options - Options for locking behavior
   * @param {boolean} options.readOnly - If true, operation only reads the file
   * @param {number} options.maxRetries - Override default max retries
   * @param {string} options.operationName - Name of the operation for logging
   * @returns {Promise} Result of the operation
   */
  async withFileLock(operation, options = {}) {
    const { readOnly = false, maxRetries = this.maxRetries, operationName = 'unknown' } = options;
    let attempts = 0;
    
    const operationId = `${operationName}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    // logger.info(`🔒 [${operationId}] Starting ${readOnly ? 'READ' : 'WRITE'} operation: ${operationName}`);

    while (attempts <= maxRetries) {
      attempts++;
      
      try {
        // Ensure queue file exists for write operations
        if (!readOnly) {
          await this.ensureQueueFileExists();
        }

        // Verify file exists for read operations
        if (readOnly && !await fs.pathExists(this.queueFilePath)) {
          throw new Error(`Queue file does not exist: ${this.queueFilePath}`);
        }

        // logger.debug(`🔒 [${operationId}] Attempting file operation (attempt ${attempts})`);
        
        // Acquire lock
        await this.acquireLock(operationId);
        
        try {
          // logger.debug(`🔓 [${operationId}] Lock acquired, executing operation`);
          // Execute the operation
          const result = await operation();
          
          // For write operations, validate the result if it's JSON content
          if (!readOnly && typeof result === 'string') {
            this.validateJsonContent(result, `write operation attempt ${attempts}`);
          }
          
          // logger.info(`✅ [${operationId}] Operation completed successfully`);
          return result;
          
        } finally {
          // Always release lock
          await this.releaseLock(operationId);
        }
        
      } catch (error) {
        // Enhanced error categorization
        const isCorruptionError = error.message && (
          error.message.includes('Unexpected end of JSON input') ||
          error.message.includes('Unexpected token') ||
          error.message.includes('Expected') ||
          error.message.includes('JSON') ||
          error.message.includes('Invalid queue structure') ||
          error.message.includes('Invalid profile')
        );
        
        const isFileSystemError = error.code && (
          error.code === 'ENOENT' ||
          error.code === 'EBUSY' ||
          error.code === 'EACCES' ||
          error.code === 'EMFILE' ||
          error.code === 'ENFILE'
        );

        const isLockError = error.message && (
          error.message.includes('Could not acquire lock') ||
          error.message.includes('Lock timeout') ||
          error.message.includes('Lock file exists')
        );
        
        if ((isCorruptionError || isFileSystemError || isLockError) && attempts <= maxRetries) {
          // Enhanced backoff calculation
          const baseDelay = this.baseRetryDelay * Math.pow(2, attempts - 1);
          const jitter = Math.random() * 50;
          const waitTime = Math.min(baseDelay + jitter, 10000);
          
          const errorType = isCorruptionError ? 'corruption' : 
                           isFileSystemError ? 'filesystem' : 'lock';
          // logger.debug(`File ${errorType} error detected, retrying in ${Math.round(waitTime)}ms (attempt ${attempts}): ${error.message}`);
          await this.delay(waitTime);
          continue;
        }
        
        if (attempts > maxRetries) {
          logger.error(`Operation failed after ${maxRetries} attempts for ${this.queueFilePath}: ${error.message}`);
          throw new Error(`Could not complete operation for ${this.queueFilePath}: ${error.message}`);
        }
        
        // For other errors, shorter retry
        const waitTime = 1000;
        // logger.debug(`File operation failed, retrying in ${waitTime}ms: ${error.message}`);
        await this.delay(waitTime);
      }
    }
  }

  /**
   * Acquire exclusive lock on the queue file
   */
  async acquireLock() {
    const maxLockAttempts = 20; // Reduced from 50 to fail faster
    let attempts = 0;

    while (attempts < maxLockAttempts) {
      try {
        // Check if lock file already exists
        if (await fs.pathExists(this.lockFilePath)) {
          // Check if it's a stale lock
          const isStale = await this.isLockStale();
          if (isStale) {
            logger.warn(`Removing stale lock file: ${this.lockFilePath}`);
            await fs.remove(this.lockFilePath);
          } else {
            // Lock is active, wait longer and retry
            attempts++;
            await this.delay(500); // Increased from 100ms to 500ms
            continue;
          }
        }

        // Try to create lock file atomically
        const lockContent = {
          processId: this.processId,
          timestamp: Date.now(),
          hostname: require('os').hostname(),
          platform: process.platform
        };

        // Use writeFile with exclusive flag to ensure atomicity
        await fs.writeFile(this.lockFilePath, JSON.stringify(lockContent, null, 2), { flag: 'wx' });
        
        // logger.debug(`Acquired lock: ${this.lockFilePath}`);
        return;

      } catch (error) {
        if (error.code === 'EEXIST') {
          // Lock file was created by another process, retry
          attempts++;
          await this.delay(500); // Increased delay
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Could not acquire lock after ${maxLockAttempts} attempts. Lock file: ${this.lockFilePath}`);
  }

  /**
   * Release the lock by removing the lock file
   */
  async releaseLock(operationId = 'unknown') {
    try {
      if (await fs.pathExists(this.lockFilePath)) {
        // Verify we own this lock before removing it
        const lockContent = await fs.readJson(this.lockFilePath);
        if (lockContent.processId === this.processId) {
          await fs.remove(this.lockFilePath);
          // logger.debug(`🔓 [${operationId}] Released lock: ${this.lockFilePath}`);
        } else {
          logger.warn(`🔓 [${operationId}] Cannot release lock owned by different process: ${lockContent.processId} (ours: ${this.processId})`);
        }
      } else {
        logger.debug(`🔓 [${operationId}] Lock file already removed: ${this.lockFilePath}`);
      }
    } catch (error) {
      logger.warn(`🔓 [${operationId}] Error releasing lock ${this.lockFilePath}: ${error.message}`);
      // Don't throw - lock release errors shouldn't fail the operation
    }
  }

  /**
   * Check if a lock file is stale (older than lockTimeout)
   */
  async isLockStale() {
    try {
      const lockContent = await fs.readJson(this.lockFilePath);
      const lockAge = Date.now() - lockContent.timestamp;
      return lockAge > this.lockTimeout;
    } catch (error) {
      // If we can't read the lock file, consider it stale
      logger.debug(`Cannot read lock file, considering stale: ${error.message}`);
      return true;
    }
  }

  /**
   * Ensure the queue file exists
   */
  async ensureQueueFileExists() {
    if (!await fs.pathExists(this.queueFilePath)) {
      await fs.ensureDir(path.dirname(this.queueFilePath));
      await fs.writeFile(this.queueFilePath, '[]', 'utf8');
      logger.info(`Created empty queue file at: ${this.queueFilePath}`);
    }
  }

  /**
   * Validate JSON content
   */
  validateJsonContent(content, operation = 'unknown') {
    try {
      const parsed = JSON.parse(content);
      
      // Additional validation for queue files
      if (!Array.isArray(parsed)) {
        throw new Error(`Invalid queue structure: expected array, got ${typeof parsed}`);
      }
      
      // Validate each profile has required fields
      for (let i = 0; i < parsed.length; i++) {
        const profile = parsed[i];
        if (!profile.steam_id || !profile.username || !profile.checks) {
          throw new Error(`Invalid profile at index ${i}: missing required fields`);
        }
      }
      
      logger.debug(`JSON validation passed for ${operation} (${parsed.length} profiles)`);
      return { valid: true, parsed };
    } catch (error) {
      logger.error(`JSON validation failed for ${operation}: ${error.message}`);
      throw new Error(`JSON validation failed: ${error.message}`);
    }
  }

  /**
   * Read queue profiles with lock protection
   */
  async readQueueProfiles() {
    return this.withFileLock(async () => {
      try {
        const data = await fs.readFile(this.queueFilePath, 'utf8');
        const validation = this.validateJsonContent(data, 'read operation');
        return validation.parsed;
      } catch (error) {
        logger.error(`Error reading queue file: ${error.message}`);
        return [];
      }
    }, { readOnly: true, operationName: 'readQueueProfiles' });
  }

  /**
   * Write queue profiles with lock protection
   */
  async writeQueueProfiles(profiles) {
    return this.withFileLock(async () => {
      try {
        // Validate input
        if (!Array.isArray(profiles)) {
          throw new Error(`Invalid profiles data: expected array, got ${typeof profiles}`);
        }
        
        // Pre-validate the data structure
        const jsonData = JSON.stringify(profiles, null, 2);
        this.validateJsonContent(jsonData, 'pre-write validation');
        
        // Write to temporary file first for atomic operation
        const tempPath = `${this.queueFilePath}.tmp.${Date.now()}.${this.processId}`;
        await fs.writeFile(tempPath, jsonData, 'utf8');
        
        // Verify the temporary file is valid
        const verification = await fs.readFile(tempPath, 'utf8');
        this.validateJsonContent(verification, 'post-write verification');
        
        // Atomic move (rename) to final location
        await fs.rename(tempPath, this.queueFilePath);
        
        // Final verification of the moved file
        const finalVerification = await fs.readFile(this.queueFilePath, 'utf8');
        this.validateJsonContent(finalVerification, 'final verification');
        
        logger.debug(`Successfully saved ${profiles.length} profiles to queue with full validation`);
        return true;
      } catch (error) {
        logger.error(`Error saving queue file: ${error.message}`);
        
        // Clean up temp files if they exist
        try {
          const tempPattern = `${this.queueFilePath}.tmp.`;
          const dir = path.dirname(this.queueFilePath);
          const files = await fs.readdir(dir);
          
          for (const file of files) {
            if (file.startsWith(path.basename(tempPattern))) {
              const tempFile = path.join(dir, file);
              await fs.remove(tempFile);
              logger.debug(`Cleaned up temp file: ${tempFile}`);
            }
          }
        } catch (cleanupError) {
          logger.debug(`Error during temp file cleanup: ${cleanupError.message}`);
        }
        
        throw error;
      }
    }, { operationName: 'writeQueueProfiles' });
  }

  /**
   * Utility method for delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Cleanup method to remove stale locks on process exit
   */
  async cleanup() {
    try {
      if (await fs.pathExists(this.lockFilePath)) {
        const lockContent = await fs.readJson(this.lockFilePath);
        if (lockContent.processId === this.processId) {
          await fs.remove(this.lockFilePath);
          logger.info(`Cleaned up lock file on exit: ${this.lockFilePath}`);
        }
      }
    } catch (error) {
      logger.debug(`Error during cleanup: ${error.message}`);
    }
  }
}

module.exports = QueueFileManager;