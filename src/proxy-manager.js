// steam-id-processor/src/proxy-manager.js
const fs = require('fs-extra');
const path = require('path');
const logger = require('./utils/logger');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');

class ProxyManager {
  constructor(configDir, cooldownDurations, backoffSequence) {
    logger.info(`🔍 [DEBUG] ProxyManager constructor called with:`);
    logger.info(`🔍 [DEBUG]   configDir: ${configDir}`);
    logger.info(`🔍 [DEBUG]   cooldownDurations: ${JSON.stringify(cooldownDurations)}`);
    logger.info(`🔍 [DEBUG]   backoffSequence: ${JSON.stringify(backoffSequence)}`);
    logger.info(`🔍 [DEBUG]   backoffSequence type: ${typeof backoffSequence}`);
    logger.info(`🔍 [DEBUG]   backoffSequence length: ${backoffSequence?.length}`);
    
    this.configPath = path.join(configDir, 'config_proxies.json');
    this.cooldownPath = path.join(configDir, 'endpoint_cooldowns.json');
    this.config = null;
    this.cooldowns = null;
    this.cooldownDurations = cooldownDurations;
    this.backoffSequence = backoffSequence; // NEW: Exponential backoff sequence
    this.currentProxyIndex = 0; // For round-robin among proxies
    this.backoffLevels = new Map(); // key: "connectionIndex:endpoint", value: level
    
    // VALIDATION: Ensure backoffSequence is valid
    if (!this.backoffSequence || !Array.isArray(this.backoffSequence) || this.backoffSequence.length === 0) {
      logger.error(`🔍 [DEBUG] CRITICAL: Invalid backoffSequence received: ${JSON.stringify(this.backoffSequence)}`);
      logger.error(`🔍 [DEBUG] Using fallback sequence: [1, 2, 4, 8, 16, 32, 60, 120, 240, 480]`);
      this.backoffSequence = [1, 2, 4, 8, 16, 32, 60, 120, 240, 480];
    }
    
    logger.info(`🔍 [DEBUG] Final backoffSequence: ${JSON.stringify(this.backoffSequence)}`);
    
    this.initializeConfig();
    this.initializeCooldowns();
    this.initializeBackoffLevelsFromFile();
  }

  initializeConfig() {
    try {
      // Check if config exists
      if (fs.existsSync(this.configPath)) {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        logger.info('Proxy configuration loaded');
        
        // Ensure it has the correct structure
        this.ensureConfigStructure();
      } else {
        // Create default config with new simplified structure
        this.config = {
          connections: [
            {
              type: 'direct',
              url: null
            }
          ]
        };
        
        this.saveConfig();
        logger.info('Created default proxy configuration');
      }
    } catch (error) {
      logger.error(`Error initializing proxy configuration: ${error.message}`);
      // Create default config as fallback
      this.config = {
        connections: [
          {
            type: 'direct',
            url: null
          }
        ]
      };
    }
  }

  initializeCooldowns() {
    try {
      // Check if cooldowns file exists
      if (fs.existsSync(this.cooldownPath)) {
        this.cooldowns = JSON.parse(fs.readFileSync(this.cooldownPath, 'utf8'));
        logger.info('Endpoint cooldowns loaded');
        
        // Ensure it has the correct structure
        this.ensureCooldownStructure();
      } else {
        // Create default cooldowns structure
        this.createDefaultCooldowns();
        logger.info('Created default endpoint cooldowns file');
      }
    } catch (error) {
      logger.error(`Error initializing endpoint cooldowns: ${error.message}`);
      // Create default cooldowns as fallback
      this.createDefaultCooldowns();
    }
  }

  ensureConfigStructure() {
    // Ensure connections is an array
    if (!Array.isArray(this.config.connections)) {
      this.config.connections = [];
    }

    // Ensure direct connection exists
    const directConnectionExists = this.config.connections.some(
      conn => conn.type === 'direct'
    );
    
    if (!directConnectionExists) {
      this.config.connections.unshift({
        type: 'direct',
        url: null
      });
    }

    // Clean up any old format properties if they exist
    if (this.config.current_index !== undefined) {
      delete this.config.current_index;
    }
    if (this.config.cooldown_duration_ms !== undefined) {
      delete this.config.cooldown_duration_ms;
    }

    // Save changes
    this.saveConfig();
  }

  createDefaultCooldowns() {
    this.cooldowns = {
      connections: this.config.connections.map((conn, index) => ({
        index: index,
        type: conn.type,
        url: conn.url,
        endpoint_cooldowns: {}
      }))
    };
    
    this.saveCooldowns();
  }

  ensureCooldownStructure() {
    // Ensure connections array exists and matches config
    if (!Array.isArray(this.cooldowns.connections)) {
      this.cooldowns.connections = [];
    }

    // Store the original cooldowns data
    const originalCooldowns = [...this.cooldowns.connections];

    // Sync cooldowns with current config connections
    this.cooldowns.connections = this.config.connections.map((conn, index) => {
      // Try multiple strategies to find existing cooldown data
      let existing = null;
      
      // Strategy 1: Match by index, type, and URL
      existing = originalCooldowns.find(
        cooldownConn => cooldownConn.index === index && 
                       cooldownConn.type === conn.type && 
                       cooldownConn.url === conn.url
      );
      
      // Strategy 2: If not found, match by type and URL (index might have changed)
      if (!existing) {
        existing = originalCooldowns.find(
          cooldownConn => cooldownConn.type === conn.type && 
                         cooldownConn.url === conn.url
        );
      }
      
      // Strategy 3: For direct connections, match by type only
      if (!existing && conn.type === 'direct') {
        existing = originalCooldowns.find(
          cooldownConn => cooldownConn.type === 'direct'
        );
      }

      return {
        index: index,
        type: conn.type,
        url: conn.url,
        endpoint_cooldowns: existing?.endpoint_cooldowns || {}
      };
    });

    this.saveCooldowns();
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      logger.error(`Error saving proxy configuration: ${error.message}`);
    }
  }

  saveCooldowns() {
    try {
      fs.writeFileSync(this.cooldownPath, JSON.stringify(this.cooldowns, null, 2));
    } catch (error) {
      logger.error(`Error saving endpoint cooldowns: ${error.message}`);
    }
  }

  addSocks5Proxy(proxyUrl) {
    // Validate SOCKS5 URL format
    if (!proxyUrl.startsWith('socks5://')) {
      logger.error('Invalid SOCKS5 URL format. Must start with socks5://');
      return false;
    }

    // Check if proxy already exists
    const exists = this.config.connections.some(
      conn => conn.type === 'socks5' && conn.url === proxyUrl
    );
    
    if (!exists) {
      this.config.connections.push({
        type: 'socks5',
        url: proxyUrl
      });
      
      // Add corresponding cooldown entry
      this.cooldowns.connections.push({
        index: this.config.connections.length - 1,
        type: 'socks5',
        url: proxyUrl,
        endpoint_cooldowns: {}
      });
      
      this.saveConfig();
      this.saveCooldowns();
      
      // Log without showing credentials
      const maskedUrl = proxyUrl.replace(/:([^:@]+)@/, ':***@');
      logger.info(`Added new SOCKS5 proxy: ${maskedUrl}`);
      return true;
    }
    
    return false;
  }

  removeSocks5Proxy(proxyUrl) {
    const initialLength = this.config.connections.length;
    
    // Filter out the specified proxy from config
    this.config.connections = this.config.connections.filter(
      conn => !(conn.type === 'socks5' && conn.url === proxyUrl)
    );
    
    // Filter out the corresponding cooldown entry
    this.cooldowns.connections = this.cooldowns.connections.filter(
      conn => !(conn.type === 'socks5' && conn.url === proxyUrl)
    );
    
    // Re-index the remaining connections
    this.cooldowns.connections.forEach((conn, index) => {
      conn.index = index;
    });
    
    if (this.config.connections.length < initialLength) {
      // Reset proxy round-robin index if it's now out of bounds
      if (this.currentProxyIndex >= this.getProxyConnections().length) {
        this.currentProxyIndex = 0;
      }
      
      this.saveConfig();
      this.saveCooldowns();
      
      const maskedUrl = proxyUrl.replace(/:([^:@]+)@/, ':***@');
      logger.info(`Removed SOCKS5 proxy: ${maskedUrl}`);
      return true;
    }
    
    return false;
  }

  // Get all proxy connections (excluding direct)
  getProxyConnections() {
    return this.config.connections.filter(conn => conn.type !== 'direct');
  }

  // Clean up expired cooldowns
  cleanupExpiredCooldowns() {
    const now = Date.now();
    let cleanupCount = 0;
    
    for (const conn of this.cooldowns.connections) {
      const endpointNames = Object.keys(conn.endpoint_cooldowns);
      
      for (const endpoint of endpointNames) {
        const cooldown = conn.endpoint_cooldowns[endpoint];
        
        if (cooldown.cooldown_until <= now) {
          // For 429 cooldowns, preserve the backoff level in memory but clean up file
          if (cooldown.reason === '429') {
            const key = `${conn.index}:${endpoint}`;
            // Keep the backoff level in memory, just remove the file entry
            logger.debug(`🔓 Cooldown expired for connection ${conn.index} endpoint ${endpoint} (preserving backoff level ${this.backoffLevels.get(key) || 'unknown'} in memory)`);
          } else {
            const connDesc = conn.type === 'direct' ? 'direct connection' : `SOCKS5 proxy`;
            logger.debug(`🔓 Cooldown expired for ${connDesc} endpoint ${endpoint}`);
          }
          
          delete conn.endpoint_cooldowns[endpoint];
          cleanupCount++;
        }
      }
    }
    
    if (cleanupCount > 0) {
      this.saveCooldowns();
      logger.info(`🧹 Cleaned up ${cleanupCount} expired endpoint cooldowns`);
    }
    
    return cleanupCount;
  }

  // Check if a specific connection is available for a specific endpoint
  isConnectionAvailableForEndpoint(connectionIndex, endpoint) {
    const conn = this.cooldowns.connections[connectionIndex];
    if (!conn) {
      logger.debug(`Connection index ${connectionIndex} not found in cooldowns`);
      return false;
    }
    
    const cooldown = conn.endpoint_cooldowns[endpoint];
    if (!cooldown) {
      logger.debug(`No cooldown found for connection ${connectionIndex} endpoint ${endpoint} - available`);
      return true;
    }
    
    const isAvailable = cooldown.cooldown_until <= Date.now();
    logger.debug(`Connection ${connectionIndex} endpoint ${endpoint}: cooldown until ${cooldown.cooldown_until}, now ${Date.now()}, available: ${isAvailable}`);
    return isAvailable;
  }

  // Get the best available connection for an endpoint (direct first, then round-robin proxies)
  getBestConnectionForEndpoint(endpoint) {
    // Always try direct connection first
    if (this.isConnectionAvailableForEndpoint(0, endpoint)) {
      const directConn = this.config.connections[0];
      logger.debug(`Using direct connection for ${endpoint}`);
      return {
        connection: directConn,
        index: 0
      };
    }
    
    // If direct is not available, try proxies in round-robin fashion
    const proxyConnections = this.getProxyConnections();
    if (proxyConnections.length === 0) {
      return null; // No proxy connections available
    }
    
    // Try each proxy starting from current round-robin position
    for (let i = 0; i < proxyConnections.length; i++) {
      const proxyIndex = (this.currentProxyIndex + i) % proxyConnections.length;
      // Convert proxy index to actual connection index (skip direct connection at index 0)
      const actualConnectionIndex = proxyIndex + 1;
      
      if (this.isConnectionAvailableForEndpoint(actualConnectionIndex, endpoint)) {
        // Update round-robin index for next time
        this.currentProxyIndex = (proxyIndex + 1) % proxyConnections.length;
        
        const proxyConn = this.config.connections[actualConnectionIndex];
        const maskedUrl = proxyConn.url ? proxyConn.url.replace(/:([^:@]+)@/, ':***@') : 'unknown';
        logger.debug(`Using SOCKS5 proxy ${maskedUrl} for ${endpoint}`);
        
        return {
          connection: proxyConn,
          index: actualConnectionIndex
        };
      }
    }
    
    return null; // No connections available for this endpoint
  }

  markConnectionCooldownForEndpoint(connectionIndex, endpoint, errorType, errorMessage) {
    logger.debug(`🔍 [DEBUG] markConnectionCooldownForEndpoint called:`);
    logger.debug(`🔍 [DEBUG]   connectionIndex: ${connectionIndex}`);
    logger.debug(`🔍 [DEBUG]   endpoint: ${endpoint}`);
    logger.debug(`🔍 [DEBUG]   errorType: ${errorType}`);
    logger.debug(`🔍 [DEBUG]   errorMessage: ${errorMessage}`);
    
    const conn = this.cooldowns.connections[connectionIndex];
    if (!conn) {
      logger.error(`🔍 [DEBUG] Connection index ${connectionIndex} not found for cooldown marking`);
      logger.error(`🔍 [DEBUG] Available connections: ${this.cooldowns.connections.length}`);
      logger.error(`🔍 [DEBUG] Connection indices: ${this.cooldowns.connections.map((c, i) => i).join(', ')}`);
      return;
    }
    
    logger.debug(`🔍 [DEBUG] Found connection: ${conn.type} at index ${connectionIndex}`);
    
    // Handle 429 errors with exponential backoff
    if (errorType === '429') {
      logger.debug(`🔍 [DEBUG] Handling 429 error with backoff`);
      
      // NEW: Use in-memory state as source of truth
      const key = `${connectionIndex}:${endpoint}`;
      const currentLevel = this.backoffLevels.get(key) || 0;
      
      logger.debug(`🔍 [DEBUG] Current backoff level from memory: ${currentLevel}`);
      logger.debug(`🔍 [DEBUG] backoffSequence: ${JSON.stringify(this.backoffSequence)}`);
      logger.debug(`🔍 [DEBUG] backoffSequence length: ${this.backoffSequence?.length}`);
      
      if (!this.backoffSequence || !Array.isArray(this.backoffSequence)) {
        logger.error(`🔍 [DEBUG] CRITICAL: backoffSequence is invalid: ${typeof this.backoffSequence}`);
        logger.error(`🔍 [DEBUG] backoffSequence value: ${JSON.stringify(this.backoffSequence)}`);
        // Use fallback
        this.backoffSequence = [1, 2, 4, 8, 16, 32, 60, 120, 240, 480];
        logger.error(`🔍 [DEBUG] Using fallback backoffSequence: ${JSON.stringify(this.backoffSequence)}`);
      }
      
      // Calculate new backoff level
      const newLevel = Math.min(currentLevel + 1, this.backoffSequence.length - 1);
      logger.debug(`🔍 [DEBUG] New backoff level: ${newLevel}`);
      
      // Update in-memory state (source of truth)
      this.backoffLevels.set(key, newLevel);
      logger.debug(`🔍 [DEBUG] Updated in-memory backoff level to: ${newLevel}`);
      
      // Get cooldown duration from backoff sequence
      logger.debug(`🔍 [DEBUG] Getting cooldown duration for level ${newLevel}`);
      
      if (newLevel >= this.backoffSequence.length) {
        logger.error(`🔍 [DEBUG] CRITICAL: Cannot access backoffSequence[${newLevel}]`);
        logger.error(`🔍 [DEBUG] backoffSequence: ${JSON.stringify(this.backoffSequence)}`);
        logger.error(`🔍 [DEBUG] backoffSequence length: ${this.backoffSequence?.length}`);
        
        // Use fallback duration
        const fallbackMinutes = 1;
        logger.error(`🔍 [DEBUG] Using fallback duration: ${fallbackMinutes} minutes`);
        
        const cooldownDuration = fallbackMinutes * 60 * 1000;
        const cooldownUntil = Date.now() + cooldownDuration;
        
        conn.endpoint_cooldowns[endpoint] = {
          cooldown_until: cooldownUntil,
          reason: '429',
          backoff_level: newLevel, // Store the level for file consistency
          applied_at: Date.now(),
          error_message: errorMessage + ' (FALLBACK USED)',
          duration_minutes: fallbackMinutes
        };
        
        this.saveCooldowns();
        logger.error(`🔒 FALLBACK: Applied 1-minute cooldown due to backoffSequence error`);
        return;
      }
      
      const cooldownMinutes = this.backoffSequence[newLevel];
      logger.debug(`🔍 [DEBUG] Cooldown duration: ${cooldownMinutes} minutes`);
      
      const cooldownDuration = cooldownMinutes * 60 * 1000; // Convert to milliseconds
      const cooldownUntil = Date.now() + cooldownDuration;
      
      // Store the new cooldown with backoff information
      conn.endpoint_cooldowns[endpoint] = {
        cooldown_until: cooldownUntil,
        reason: '429',
        backoff_level: newLevel, // Store for file consistency
        applied_at: Date.now(),
        error_message: errorMessage,
        duration_minutes: cooldownMinutes
      };
      
      logger.debug(`🔍 [DEBUG] Saving cooldown: ${JSON.stringify(conn.endpoint_cooldowns[endpoint])}`);
      this.saveCooldowns();
      
      // Enhanced logging for backoff progression
      const cooldownUntilDate = new Date(cooldownUntil);
      const connType = conn.type === 'direct' ? 'direct connection' : 'SOCKS5 proxy';
      const sequencePosition = `${newLevel + 1}/${this.backoffSequence.length}`;
      
      logger.warn(`🔒 Rate limit (429) cooldown applied to ${connType} for ${endpoint} endpoint`);
      logger.warn(`    Backoff level: ${currentLevel} → ${newLevel} (${sequencePosition}) → ${cooldownMinutes} minutes`);
      logger.warn(`    Available again at: ${cooldownUntilDate.toLocaleString()}`);
      logger.warn(`    Next level would be: ${this.getNextBackoffDuration(newLevel)} minutes`);
      
      return;
    }
    
    // Handle other error types with existing logic (no changes but add logging)
    logger.debug(`🔍 [DEBUG] Handling non-429 error: ${errorType}`);
    
    let cooldownDuration;
    let description;
    
    if (errorType === 'connection_error') {
      cooldownDuration = this.cooldownDurations.connection_reset;
      description = `Connection error on ${endpoint} endpoint`;
    } else if (errorType === 'timeout') {
      cooldownDuration = this.cooldownDurations.timeout;
      description = `Timeout error on ${endpoint} endpoint`;
    } else if (errorType === 'dns_failure') {
      cooldownDuration = this.cooldownDurations.dns_failure;
      description = `DNS failure on ${endpoint} endpoint`;
    } else if (errorType === 'socks_error') {
      cooldownDuration = this.cooldownDurations.socks_error;
      description = `SOCKS5 error on ${endpoint} endpoint`;
    } else {
      // Fallback for unknown errors
      cooldownDuration = 60000; // 1 minute fallback
      description = `Unknown error on ${endpoint} endpoint`;
    }
    
    logger.debug(`🔍 [DEBUG] Non-429 cooldown duration: ${cooldownDuration}ms`);
    
    const cooldownUntil = Date.now() + cooldownDuration;
    
    conn.endpoint_cooldowns[endpoint] = {
      cooldown_until: cooldownUntil,
      reason: errorType,
      duration_used: cooldownDuration,
      applied_at: Date.now(),
      error_message: errorMessage
    };
    
    this.saveCooldowns();
    
    // Log with human-readable time and duration
    const cooldownUntilDate = new Date(cooldownUntil);
    const cooldownMinutes = Math.ceil(cooldownDuration / 60000);
    const connType = conn.type === 'direct' ? 'direct connection' : 'SOCKS5 proxy';
    
    logger.warn(`🔒 Marked ${connType} as in cooldown for ${endpoint} endpoint for ${cooldownMinutes} minutes until ${cooldownUntilDate.toLocaleString()}`);
    logger.warn(`    Reason: ${description} - ${errorMessage}`);
  }

  // NEW: Helper method to get the next backoff duration for logging - FIXED
  getNextBackoffDuration(currentLevel) {
    const nextLevel = currentLevel + 1;
    // FIX: Use this.backoffSequence instead of this.cooldownDurations.BACKOFF_SEQUENCE_MINUTES
    if (nextLevel >= this.backoffSequence.length) {
      return this.backoffSequence[0]; // Reset to first level
    }
    return this.backoffSequence[nextLevel];
  }

  // NEW: Reset backoff on successful request
  resetBackoffOnSuccess(connectionIndex, endpoint) {
    const conn = this.cooldowns.connections[connectionIndex];
    if (!conn) {
      return; // No connection found
    }
    
    const cooldown = conn.endpoint_cooldowns[endpoint];
    
    // Reset in-memory state regardless of file state
    const key = `${connectionIndex}:${endpoint}`;
    const hadBackoffLevel = this.backoffLevels.has(key);
    const previousLevel = this.backoffLevels.get(key) || 0;
    
    if (hadBackoffLevel) {
      // Clear from in-memory state (source of truth)
      this.backoffLevels.delete(key);
      
      const connType = conn.type === 'direct' ? 'direct connection' : 'SOCKS5 proxy';
      logger.info(`✅ Reset 429 backoff for ${connType} on ${endpoint} endpoint (was level ${previousLevel})`);
    }
    
    // Also clean up file state if it exists and was a 429 cooldown
    if (cooldown && cooldown.reason === '429') {
      delete conn.endpoint_cooldowns[endpoint];
      this.saveCooldowns();
    }
  }

  // Check if all connections are in cooldown for a specific endpoint
  areAllConnectionsInCooldownForEndpoint(endpoint) {
    this.cleanupExpiredCooldowns();
    
    let availableCount = 0;
    for (let i = 0; i < this.config.connections.length; i++) {
      if (this.isConnectionAvailableForEndpoint(i, endpoint)) {
        availableCount++;
      }
    }
    
    const allInCooldown = availableCount === 0;
    logger.debug(`Endpoint ${endpoint}: ${availableCount}/${this.config.connections.length} connections available, allInCooldown: ${allInCooldown}`);
    
    return allInCooldown;
  }

  // Get next available time for an endpoint across all connections
  getNextAvailableTimeForEndpoint(endpoint) {
    let earliestTime = Number.MAX_SAFE_INTEGER;
    
    for (const conn of this.cooldowns.connections) {
      const cooldown = conn.endpoint_cooldowns[endpoint];
      if (cooldown && cooldown.cooldown_until < earliestTime) {
        earliestTime = cooldown.cooldown_until;
      }
    }
    
    return earliestTime === Number.MAX_SAFE_INTEGER ? 0 : Math.max(0, earliestTime - Date.now());
  }

  // Create axios instance for a specific endpoint
  createAxiosInstance(endpoint) {
    const endpointName = this.getEndpointName(endpoint);
    const bestConnection = this.getBestConnectionForEndpoint(endpointName);
    
    if (!bestConnection) {
      // No connections available for this endpoint
      const nextAvailableIn = this.getNextAvailableTimeForEndpoint(endpointName);
      const waitTimeMin = Math.ceil(nextAvailableIn / 60000);
      
      logger.warn(`⏳ All connections in cooldown for ${endpointName}. Next available in ~${waitTimeMin} minutes.`);
      return {
        allInCooldown: true,
        nextAvailableIn: nextAvailableIn,
        endpointName: endpointName
      };
    }
    
    const { connection, index } = bestConnection;
    
    // Store the connection info for error handling
    const axiosConfig = {
      timeout: this.getTimeoutForEndpoint(endpointName),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36'
      },
      _connectionInfo: {
        index: index,
        type: connection.type,
        endpointName: endpointName
      }
    };
    
    // Configure proxy if needed
    if (connection.type === 'socks5') {
      try {
        if (!connection.url || !connection.url.startsWith('socks5://')) {
          throw new Error('Invalid SOCKS5 URL format');
        }
        
        const socksAgent = new SocksProxyAgent(connection.url);
        axiosConfig.httpsAgent = socksAgent;
        axiosConfig.httpAgent = socksAgent;
        
        // Add additional headers for inventory endpoints
        if (endpointName === 'inventory') {
          axiosConfig.headers['Sec-Fetch-Dest'] = 'empty';
          axiosConfig.headers['Sec-Fetch-Mode'] = 'cors';
          axiosConfig.headers['Sec-Fetch-Site'] = 'same-origin';
        }
        
      } catch (error) {
        logger.error(`Error creating SOCKS5 proxy configuration: ${error.message}`);
        
        // Mark this proxy as in cooldown due to configuration error
        this.markConnectionCooldownForEndpoint(index, endpointName, 'socks_error', error.message);
        
        // Try to get another connection
        return this.createAxiosInstance(endpoint);
      }
    }
    
    return axios.create(axiosConfig);
  }

  // Helper method to extract endpoint name from URL
  getEndpointName(url) {
    if (url.includes('GetFriendList')) return 'friends';
    if (url.includes('inventory')) return 'inventory';
    if (url.includes('GetSteamLevel')) return 'steam_level';
    if (url.includes('GetAnimatedAvatar')) return 'animated_avatar';
    if (url.includes('GetAvatarFrame')) return 'avatar_frame';
    if (url.includes('GetMiniProfileBackground')) return 'mini_profile_background';
    if (url.includes('GetProfileBackground')) return 'profile_background';
    
    return 'other';
  }

  // Helper method to get timeout based on endpoint
  getTimeoutForEndpoint(endpointName) {
    if (endpointName === 'inventory') return 25000;
    return 15000;
  }

  // Handle request errors and mark cooldowns appropriately
  handleRequestError(error, axiosConfig) {
    const connectionInfo = axiosConfig._connectionInfo;
    if (!connectionInfo) {
      logger.error('No connection info available for error handling');
      return { error };
    }
    
    const { index, endpointName } = connectionInfo;
    
    // Check if rate limited
    if (error.response && error.response.status === 429) {
      logger.warn(`Rate limit (429) hit for ${endpointName} on connection ${index}`);
      
      // Mark current connection as in cooldown for this endpoint
      this.markConnectionCooldownForEndpoint(index, endpointName, '429', error.message);
      
      // Return special value indicating rate limit
      return { rateLimited: true, error, endpointName };
    }
    
    // Check for SOCKS5-specific errors
    if (error.message && error.message.toLowerCase().includes('socks')) {
      logger.warn(`SOCKS5 error for ${endpointName} on connection ${index}: ${error.message}`);
      
      // Mark current connection as in cooldown for this endpoint
      this.markConnectionCooldownForEndpoint(index, endpointName, 'socks_error', error.message);
      
      return { socksError: true, error, endpointName };
    }
    
    // Handle other connection errors
    if (this.isConnectionError(error)) {
      const errorType = this.categorizeConnectionError(error);
      logger.warn(`${errorType} for ${endpointName} on connection ${index}: ${error.message}`);
      
      // Mark current connection as in cooldown for this endpoint
      this.markConnectionCooldownForEndpoint(index, endpointName, errorType, error.message);
      
      return { connectionError: true, error, endpointName, errorType };
    }
    
    // Handle other errors normally
    return { error };
  }

  // Helper method to detect connection errors
  isConnectionError(error) {
    const errorMsg = error.message || '';
    
    return (
      errorMsg.includes('socket disconnected') ||
      errorMsg.includes('socket hang up') ||
      errorMsg.includes('ECONNRESET') ||
      errorMsg.includes('ECONNREFUSED') ||
      errorMsg.includes('ETIMEDOUT') ||
      errorMsg.includes('EHOSTUNREACH') ||
      errorMsg.includes('timeout') ||
      errorMsg.includes('certificate') ||
      errorMsg.includes('SSL') ||
      errorMsg.includes('TLS') ||
      errorMsg.includes('ENOTFOUND')
    );
  }

  // Categorize connection errors for appropriate cooldown durations
  categorizeConnectionError(error) {
    const errorMsg = error.message || '';
    
    if (errorMsg.includes('ENOTFOUND') || errorMsg.includes('EHOSTUNREACH')) {
      return 'dns_failure';
    }
    
    if (errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) {
      return 'timeout';
    }
    
    return 'connection_error';
  }

  // Get connection status for monitoring
  getConnectionStatus() {
    this.cleanupExpiredCooldowns();
    
    const status = {
      totalConnections: this.config.connections.length,
      connections: [],
      endpointSummary: {}
    };
    
    // Collect all unique endpoints that have active cooldowns
    const allEndpoints = new Set();
    for (const conn of this.cooldowns.connections) {
      Object.keys(conn.endpoint_cooldowns).forEach(endpoint => allEndpoints.add(endpoint));
    }
    
    // Add common endpoints even if they don't have active cooldowns
    ['friends', 'inventory', 'steam_level', 'animated_avatar', 'avatar_frame', 'mini_profile_background', 'profile_background'].forEach(ep => allEndpoints.add(ep));
    
    const now = Date.now();
    
    // Analyze each connection
    for (let i = 0; i < this.config.connections.length; i++) {
      const configConn = this.config.connections[i];
      const cooldownConn = this.cooldowns.connections[i];
      
      const connStatus = {
        index: i,
        type: configConn.type,
        url: configConn.url,
        availableEndpoints: 0,
        totalEndpoints: allEndpoints.size,
        endpointCooldowns: {}
      };
      
      // Check each endpoint for this connection
      for (const endpoint of allEndpoints) {
        const cooldown = cooldownConn?.endpoint_cooldowns[endpoint];
        
        if (!cooldown || cooldown.cooldown_until <= now) {
          connStatus.availableEndpoints++;
          connStatus.endpointCooldowns[endpoint] = 'available';
        } else {
          const remainingMs = Math.max(0, cooldown.cooldown_until - now);
          connStatus.endpointCooldowns[endpoint] = {
            status: 'cooldown',
            remainingMs: remainingMs,
            reason: cooldown.reason,
            until: new Date(cooldown.cooldown_until).toLocaleString()
          };
        }
      }
      
      status.connections.push(connStatus);
    }
    
    // Create endpoint summary (which connections are available for each endpoint)
    for (const endpoint of allEndpoints) {
      const availableConnections = [];
      
      for (let i = 0; i < this.config.connections.length; i++) {
        if (this.isConnectionAvailableForEndpoint(i, endpoint)) {
          availableConnections.push(i);
        }
      }
      
      status.endpointSummary[endpoint] = {
        availableConnections: availableConnections.length,
        totalConnections: this.config.connections.length,
        nextAvailableIn: availableConnections.length === 0 ? this.getNextAvailableTimeForEndpoint(endpoint) : 0
      };
    }
    
    return status;
  }

  // Initialize backoff levels from file on startup
  initializeBackoffLevelsFromFile() {
    try {
      if (!this.cooldowns || !this.cooldowns.connections) {
        logger.debug('No cooldowns data available for backoff level initialization');
        return;
      }
      
      let initializedCount = 0;
      
      for (const conn of this.cooldowns.connections) {
        const connectionIndex = conn.index;
        
        for (const [endpoint, cooldown] of Object.entries(conn.endpoint_cooldowns)) {
          // Solo inicializar si es un cooldown de 429 con backoff_level
          if (cooldown.reason === '429' && typeof cooldown.backoff_level === 'number') {
            const key = `${connectionIndex}:${endpoint}`;
            this.backoffLevels.set(key, cooldown.backoff_level);
            initializedCount++;
            
            logger.debug(`Initialized backoff level ${cooldown.backoff_level} for connection ${connectionIndex} endpoint ${endpoint}`);
          }
        }
      }
      
      if (initializedCount > 0) {
        logger.info(`✅ Initialized ${initializedCount} backoff levels from file on startup`);
      } else {
        logger.debug('No backoff levels found in file to initialize');
      }
      
    } catch (error) {
      logger.error(`Error initializing backoff levels from file: ${error.message}`);
    }
  }
}

module.exports = ProxyManager;