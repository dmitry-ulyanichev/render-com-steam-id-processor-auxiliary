// steam-id-processor\src\queue-manager.js
const fs = require('fs-extra');
const path = require('path');
const logger = require('./utils/logger');
const QueueFileManager = require('./utils/queue-file-manager');

class QueueManager {
  constructor(config) {
    this.config = config;
    // Queue file is now inside steam-id-processor directory
    this.queuePath = path.join(__dirname, '../profiles_queue.json');
    
    // Initialize the file manager with locking capabilities
    this.fileManager = new QueueFileManager(this.queuePath);
    
    // Ensure queue file exists
    this.ensureQueueFileExists();
    
    // Setup cleanup on process exit
    this.setupCleanupHandlers();
  }

  async ensureQueueFileExists() {
    await this.fileManager.ensureQueueFileExists();
  }

  setupCleanupHandlers() {
    // Cleanup lock files on process exit
    const cleanup = async () => {
      await this.fileManager.cleanup();
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', cleanup);
  }

  // Internal method without locking - for use within withFileLock operations
  async _readQueueProfilesInternal() {
    try {
      const data = await require('fs-extra').readFile(this.queuePath, 'utf8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      logger.error(`Error reading queue file internally: ${error.message}`);
      return [];
    }
  }

  // Internal method without locking - for use within withFileLock operations  
  async _writeQueueProfilesInternal(profiles) {
    try {
      if (!Array.isArray(profiles)) {
        throw new Error(`Invalid profiles data: expected array, got ${typeof profiles}`);
      }
      
      const jsonData = JSON.stringify(profiles, null, 2);
      await require('fs-extra').writeFile(this.queuePath, jsonData, 'utf8');
      return true;
    } catch (error) {
      logger.error(`Error writing queue file internally: ${error.message}`);
      return false;
    }
  }

  async getQueuedProfiles() {
    try {
      return await this.fileManager.readQueueProfiles();
    } catch (error) {
      logger.error(`Error reading queue profiles: ${error.message}`);
      return [];
    }
  }

  async saveQueuedProfiles(profiles) {
    try {
      await this.fileManager.writeQueueProfiles(profiles);
      return true;
    } catch (error) {
      logger.error(`Error saving queue profiles: ${error.message}`);
      return false;
    }
  }

  async addProfileToQueue(steamId, username, apiService = null) {
    try {
      return await this.fileManager.withFileLock(async () => {
        const profiles = await this._readQueueProfilesInternal();
        
        // Check if already in queue
        const existing = profiles.find(p => p.steam_id === steamId);
        if (existing) {
          logger.info(`Profile ${steamId} (user: ${username}) already in queue`);
          return existing;
        }
        
        // Check if ID already exists in database (if apiService provided)
        if (apiService) {
          const existsCheckResult = await apiService.checkSteamIdExists(steamId);
          
          if (existsCheckResult.success && existsCheckResult.exists) {
            logger.info(`Steam ID ${steamId} (user: ${username}) already exists in database, not adding to queue`);
            return null; // Don't add to queue
          }
          
          if (!existsCheckResult.success) {
            logger.warn(`Failed to check if ID ${steamId} (user: ${username}) exists: ${existsCheckResult.error}. Adding to queue anyway.`);
          }
        }
        
        // Validate username
        if (!username || typeof username !== 'string') {
          logger.error(`Invalid username '${username}' for Steam ID ${steamId}. Username must be a non-empty string.`);
          return null;
        }
        
        // Create new profile object with username
        const profile = {
          steam_id: steamId,
          username: username,
          timestamp: Date.now(),
          checks: {
            animated_avatar: "to_check",
            avatar_frame: "to_check",
            mini_profile_background: "to_check",
            profile_background: "to_check",
            steam_level: "to_check",
            friends: "to_check",
            csgo_inventory: "to_check"
          }
        };
        
        // Add to queue
        profiles.push(profile);
        const saveSuccess = await this._writeQueueProfilesInternal(profiles);
        
        if (!saveSuccess) {
          throw new Error('Failed to save updated queue');
        }
        
        logger.info(`Added profile ${steamId} (user: ${username}) to queue`);
        return profile;
      }, { operationName: `addProfileToQueue_${steamId}` });
    } catch (error) {
      logger.error(`Error adding profile to queue: ${error.message}`);
      throw error;
    }
  }

  async updateProfileCheck(steamId, checkName, status) {
    try {
      return await this.fileManager.withFileLock(async () => {
        const profiles = await this._readQueueProfilesInternal();
        
        // Find the profile
        const profileIndex = profiles.findIndex(p => p.steam_id === steamId);
        if (profileIndex === -1) {
          logger.warn(`Profile ${steamId} not found in queue`);
          return false;
        }
        
        // Validate status
        const validStatuses = ["to_check", "passed", "failed", "deferred"];
        if (!validStatuses.includes(status)) {
          logger.error(`Invalid status '${status}' for check update. Valid statuses: ${validStatuses.join(', ')}`);
          return false;
        }
        
        // Update the check status
        profiles[profileIndex].checks[checkName] = status;
        const saveSuccess = await this._writeQueueProfilesInternal(profiles);
        
        if (!saveSuccess) {
          throw new Error('Failed to save updated profile check');
        }
        
        const username = profiles[profileIndex].username || 'unknown';
        logger.debug(`Updated ${steamId} (user: ${username}) check '${checkName}' to '${status}'`);
        return true;
      }, { operationName: `updateProfileCheck_${steamId}_${checkName}` });
    } catch (error) {
      logger.error(`Error updating profile check: ${error.message}`);
      return false;
    }
  }

  async removeProfileFromQueue(steamId) {
    try {
      return await this.fileManager.withFileLock(async () => {
        const profiles = await this._readQueueProfilesInternal();
        
        // Find the profile to get username for logging
        const profileToRemove = profiles.find(p => p.steam_id === steamId);
        const username = profileToRemove?.username || 'unknown';
        
        // Find and remove the profile
        const filteredProfiles = profiles.filter(p => p.steam_id !== steamId);
        
        if (filteredProfiles.length < profiles.length) {
          const saveSuccess = await this._writeQueueProfilesInternal(filteredProfiles);
          
          if (!saveSuccess) {
            throw new Error('Failed to save queue after profile removal');
          }
          
          logger.info(`Removed profile ${steamId} (user: ${username}) from queue`);
          return true;
        } else {
          logger.warn(`Profile ${steamId} not found in queue to remove`);
          return false;
        }
      }, { operationName: `removeProfileFromQueue_${steamId}` });
    } catch (error) {
      logger.error(`Error removing profile from queue: ${error.message}`);
      return false;
    }
  }

  async processNextQueued() {
    const profiles = await this.getQueuedProfiles();
    
    if (profiles.length === 0) {
      return null;
    }
    
    return profiles[0];
  }

  // Get next profile that has checks that can be processed
  async getNextProcessableProfile() {
    const profiles = await this.getQueuedProfiles();
    
    if (profiles.length === 0) {
      return null;
    }
    
    // Look for a profile with "to_check" checks that can be processed
    for (const profile of profiles) {
      const hasToCheck = Object.values(profile.checks).some(status => status === "to_check");
      const hasDeferred = Object.values(profile.checks).some(status => status === "deferred");
      
      // If profile has "to_check" checks, it can be processed
      if (hasToCheck) {
        return profile;
      }
      
      // If profile has no "to_check" but no "deferred" either, it's complete
      if (!hasToCheck && !hasDeferred) {
        return profile; // Return for final processing (API submission)
      }
      
      // If profile only has deferred checks, skip it for now and continue to next profile
    }
    
    // If no profiles with "to_check" found, return first profile with deferred checks for potential conversion
    for (const profile of profiles) {
      const hasDeferred = Object.values(profile.checks).some(status => status === "deferred");
      if (hasDeferred) {
        return profile;
      }
    }
    
    // No processable profiles found
    return null;
  }

  async getAllChecksPassed(steamId) {
    const profiles = await this.getQueuedProfiles();
    const profile = profiles.find(p => p.steam_id === steamId);
    
    if (!profile) {
      logger.warn(`Profile ${steamId} not found in queue when checking status`);
      return false;
    }
    
    // Check if all checks are passed (ignore deferred checks for now)
    const allPassed = Object.values(profile.checks).every(status => status === "passed");
    return allPassed;
  }

  // Convert all deferred checks back to "to_check"
  async convertDeferredChecksToToCheck() {
    try {
      return await this.fileManager.withFileLock(async () => {
        // Use internal methods that don't use locking to avoid nested locks
        const profiles = await this._readQueueProfilesInternal();
        let conversionsCount = 0;
        let profilesAffected = 0;
        
        for (const profile of profiles) {
          let profileChanged = false;
          
          for (const [checkName, status] of Object.entries(profile.checks)) {
            if (status === "deferred") {
              profile.checks[checkName] = "to_check";
              conversionsCount++;
              profileChanged = true;
            }
          }
          
          if (profileChanged) {
            profilesAffected++;
            const username = profile.username || 'unknown';
            logger.debug(`Converted deferred checks for ${profile.steam_id} (user: ${username})`);
          }
        }
        
        if (conversionsCount > 0) {
          // Use internal method that doesn't use locking
          const saveSuccess = await this._writeQueueProfilesInternal(profiles);
          
          if (!saveSuccess) {
            throw new Error('Failed to save converted deferred checks');
          }
          
          logger.info(`Converted ${conversionsCount} deferred checks to 'to_check' across ${profilesAffected} profiles`);
        } else {
          logger.debug('No deferred checks found to convert');
        }
        
        return {
          conversions: conversionsCount,
          profilesAffected: profilesAffected
        };
      }, { operationName: 'convertDeferredChecksToToCheck' });
    } catch (error) {
      logger.error(`Error converting deferred checks: ${error.message}`);
      return {
        conversions: 0,
        profilesAffected: 0
      };
    }
  }

  // Get count of deferred checks across all profiles
  async getDeferredCheckStats() {
    const profiles = await this.getQueuedProfiles();
    let totalDeferred = 0;
    let profilesWithDeferred = 0;
    
    for (const profile of profiles) {
      let profileDeferredCount = 0;
      
      for (const status of Object.values(profile.checks)) {
        if (status === "deferred") {
          totalDeferred++;
          profileDeferredCount++;
        }
      }
      
      if (profileDeferredCount > 0) {
        profilesWithDeferred++;
      }
    }
    
    return {
      totalDeferred,
      profilesWithDeferred,
      totalProfiles: profiles.length
    };
  }

  // Check if all checks are complete (passed or failed, not deferred)
  async getAllChecksComplete(steamId) {
    const profiles = await this.getQueuedProfiles();
    const profile = profiles.find(p => p.steam_id === steamId);
    
    if (!profile) {
      logger.warn(`Profile ${steamId} not found in queue when checking completion status`);
      return { allComplete: false, allPassed: false };
    }
    
    // Check if all checks are either passed or failed (no to_check or deferred)
    const allComplete = Object.values(profile.checks).every(status => 
      status === "passed" || status === "failed"
    );
    
    const allPassed = Object.values(profile.checks).every(status => status === "passed");
    
    return {
      allComplete,
      allPassed
    };
  }

  // Get queue statistics including usernames
  async getQueueStats() {
    const profiles = await this.getQueuedProfiles();
    
    const stats = {
      totalProfiles: profiles.length,
      byUsername: {},
      byStatus: {
        to_check: 0,
        passed: 0,
        failed: 0,
        deferred: 0
      }
    };
    
    for (const profile of profiles) {
      const username = profile.username || 'unknown';
      
      // Count by username
      if (!stats.byUsername[username]) {
        stats.byUsername[username] = 0;
      }
      stats.byUsername[username]++;
      
      // Count check statuses
      for (const status of Object.values(profile.checks)) {
        if (stats.byStatus[status] !== undefined) {
          stats.byStatus[status]++;
        }
      }
    }
    
    return stats;
  }

  // Get profile by Steam ID (useful for debugging)
  async getProfileBySteamId(steamId) {
    const profiles = await this.getQueuedProfiles();
    return profiles.find(p => p.steam_id === steamId) || null;
  }

  // Utility method for delay
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Method for external services to safely update a profile check
  async updateProfileCheckExternal(steamId, checkName, status, source = 'external') {
    try {
      logger.info(`External update from ${source}: ${steamId} check '${checkName}' -> '${status}'`);
      const result = await this.updateProfileCheck(steamId, checkName, status);
      
      if (result) {
        logger.info(`Successfully applied external update from ${source} for ${steamId}`);
      } else {
        logger.warn(`Failed to apply external update from ${source} for ${steamId}`);
      }
      
      return result;
    } catch (error) {
      logger.error(`Error in external update from ${source}: ${error.message}`);
      return false;
    }
  }
}

module.exports = QueueManager;