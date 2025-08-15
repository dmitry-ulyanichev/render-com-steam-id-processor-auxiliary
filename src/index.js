// steam-id-processor/src/index.js
const CONFIG = require('../config/config');
const FileManager = require('./file-manager');
const SteamValidator = require('./steam-validator');
const ApiService = require('./api-service');
const QueueManager = require('./queue-manager');
const ApiServer = require('./api-server'); // NUEVO
const logger = require('./utils/logger');

// Global state variables
let isProcessing = false;
let apiServer = null; // NUEVO

async function processQueuedProfiles(steamValidator, apiService, queueManager) {
  if (isProcessing) {
    logger.debug('Processing already in progress, skipping');
    return;
  }
  
  isProcessing = true;
  logger.debug(`🔍 [DEBUG] Starting processQueuedProfiles`);
  
  try {
    // Process deferred checks first if connections are available
    logger.debug(`🔍 [DEBUG] Processing deferred checks...`);
    const deferredResult = await steamValidator.processDeferredChecks(queueManager);
    if (deferredResult.processed > 0) {
      logger.info(`Processed ${deferredResult.processed} deferred checks, ${deferredResult.remaining} remaining`);
    } else {
      logger.debug(`🔍 [DEBUG] No deferred checks were processed (processed: ${deferredResult.processed}, remaining: ${deferredResult.remaining})`);
    }
    
    // Find next processable profile from queue
    logger.debug(`🔍 [DEBUG] Getting next processable profile...`);
    const profile = await queueManager.getNextProcessableProfile();
    
    if (!profile) {
      logger.debug('🔍 [DEBUG] No processable profiles in queue');
      isProcessing = false;
      return;
    }
    
    logger.debug(`🔍 [DEBUG] Found processable profile: ${profile.steam_id} (user: ${profile.username})`);
    logger.debug(`🔍 [DEBUG] Profile checks: ${JSON.stringify(profile.checks)}`);
    
    const steamId = profile.steam_id;
    const username = profile.username;
    
    // Run checks that are marked "to_check"
    const checksToRun = Object.entries(profile.checks)
      .filter(([_, status]) => status === "to_check")
      .map(([name, _]) => name);
    
    logger.debug(`🔍 [DEBUG] Checks to run: ${checksToRun.join(', ')}`);
    
    // If no "to_check" checks, handle completion or deferred status
    if (checksToRun.length === 0) {
      logger.debug(`🔍 [DEBUG] Profile ${steamId}: No 'to_check' checks remaining, checking completion status`);
      
      const hasDeferred = Object.values(profile.checks).some(status => status === "deferred");
      logger.debug(`🔍 [DEBUG] Profile ${steamId}: Has deferred checks: ${hasDeferred}`);
      
      const completionStatus = await queueManager.getAllChecksComplete(steamId);
      logger.debug(`🔍 [DEBUG] Profile ${steamId}: Completion status: ${JSON.stringify(completionStatus)}`);
      
      if (completionStatus.allComplete) {
        if (completionStatus.allPassed) {
          logger.info(`All checks passed for ${steamId} (user: ${username}), sending to API`);
          logger.info(`🔑 API key being used: ${CONFIG.LINK_HARVESTER_API_KEY ? CONFIG.LINK_HARVESTER_API_KEY.substring(0, 8) + '...' : 'undefined'}`);
          
          const apiResult = await apiService.handleNewSteamId(steamId, username);
          
          if (apiResult.success) {
            logger.info(`API submission successful for ${steamId} (user: ${username})`);
            // Remove from queue on success
            await queueManager.removeProfileFromQueue(steamId);
          } else {
            // Check if error is retryable or permanent
            const errorMessage = apiResult.error || '';
            const isRetryableError = 
              errorMessage.includes('Internal server error') ||           // 500 errors
              errorMessage.includes('No response from server') ||        // Network timeouts
              errorMessage.includes('Request setup error') ||            // Connection issues
              errorMessage.includes('Service temporarily unavailable') || // 503 errors
              (apiResult.status >= 500 && apiResult.status < 600);       // Any 5xx error
            
            if (isRetryableError) {
              logger.warn(`API submission failed with retryable error for ${steamId} (user: ${username}): ${apiResult.error}`);
              logger.info(`Profile ${steamId} (user: ${username}) will remain in queue for retry`);
              // Don't remove - will be retried in next processing cycle
            } else {
              // Permanent error or success case
              if (errorMessage.includes('Link already exists')) {
                logger.info(`Steam ID ${steamId} (user: ${username}) already exists on PythonAnywhere - removing from queue`);
              } else {
                logger.error(`API submission failed with permanent error for ${steamId} (user: ${username}): ${apiResult.error}`);
                logger.info(`Removing ${steamId} (user: ${username}) from queue (non-retryable error)`);
              }
              // Remove from queue for permanent errors
              await queueManager.removeProfileFromQueue(steamId);
            }
          }
        } else {
          // Some checks failed validation - remove from queue
          logger.info(`Some checks failed for ${steamId} (user: ${username}), removing from queue`);
          await queueManager.removeProfileFromQueue(steamId);
        }
      } else {
        // Has deferred checks - don't process repeatedly, just log and wait
        logger.debug(`🔍 [DEBUG] Profile ${steamId} (user: ${username}) has deferred checks, will be processed when connections are available`);
      }
      
      isProcessing = false;
      return;
    }
    
    // Process the profile with "to_check" checks
    logger.info(`Processing queued profile: ${steamId} (user: ${username})`);
    logger.debug(`Profile ${steamId}: Found ${checksToRun.length} checks to run: ${checksToRun.join(', ')}`);
    
    // Flag to track if we've detected a private profile
    let isPrivateProfile = false;
    
    // Run each check in order
    for (let i = 0; i < checksToRun.length; i++) {
      const checkName = checksToRun[i];
      
      // Skip further checks if we've already identified this as a private profile
      // and the current check is either friends or csgo_inventory
      const isRateLimitedCheck = checkName === 'friends' || checkName === 'csgo_inventory';
      if (isPrivateProfile && isRateLimitedCheck) {
        logger.info(`Auto-passing check '${checkName}' for ${steamId} (user: ${username}) (private profile)`);
        await queueManager.updateProfileCheck(steamId, checkName, "passed");
        continue;
      }
      
      try {
        let checkResult;
        
        // Run the appropriate check
        switch (checkName) {
          case 'animated_avatar':
            checkResult = await steamValidator.checkAnimatedAvatar(steamId);
            break;
          case 'avatar_frame':
            checkResult = await steamValidator.checkAvatarFrame(steamId);
            break;
          case 'mini_profile_background':
            checkResult = await steamValidator.checkMiniProfileBackground(steamId);
            break;
          case 'profile_background':
            checkResult = await steamValidator.checkProfileBackground(steamId);
            break;
          case 'steam_level':
            checkResult = await steamValidator.checkSteamLevel(steamId);
            
            // After steam level check, determine if this is a private profile
            if (checkResult.success && 
                checkResult.details && 
                checkResult.details.note && 
                checkResult.details.note.includes("Empty response from API")) {
              isPrivateProfile = true;
              logger.info(`Private profile detected for ${steamId} (user: ${username}) - will auto-pass remaining private checks`);
            }
            break;
          case 'friends':
            checkResult = await steamValidator.checkFriends(steamId);
            break;
          case 'csgo_inventory':
            checkResult = await steamValidator.checkCsgoInventory(steamId);
            break;
          default:
            logger.error(`Unknown check type: ${checkName}`);
            checkResult = {
              success: false,
              passed: false,
              error: `Unknown check type: ${checkName}`
            };
        }
        
        // Handle check result
        if (!checkResult.success) {
          // Check for deferred status (all connections in cooldown for this endpoint)
          if (checkResult.deferred) {
            logger.warn(`Check '${checkName}' for ${steamId} (user: ${username}) deferred due to all connections in cooldown`);
            await queueManager.updateProfileCheck(steamId, checkName, "deferred");
            const waitTimeMin = Math.ceil((checkResult.nextAvailableIn || 60000) / 60000);
            logger.info(`Will retry when a connection becomes available (est. ${waitTimeMin} minutes)`);
            continue; // Continue to next check, don't exit the loop
          }
          
          // Regular API error - mark as deferred and continue with other checks
          logger.warn(`Check '${checkName}' for ${steamId} (user: ${username}) failed with API error: ${checkResult.error}`);
          await queueManager.updateProfileCheck(steamId, checkName, "deferred");
          logger.info(`Marked ${checkName} as deferred, continuing with other checks for ${steamId} (user: ${username})`);
          continue; // Continue to next check, don't exit the loop
        } else if (!checkResult.passed) {
          // Check failed validation - remove from queue
          logger.info(`Check '${checkName}' for ${steamId} (user: ${username}) failed validation, removing from queue`);
          await queueManager.removeProfileFromQueue(steamId);
          break; // Exit the check loop for this profile
        } else {
          // Check passed - update status
          logger.info(`Check '${checkName}' for ${steamId} (user: ${username}) passed`);
          await queueManager.updateProfileCheck(steamId, checkName, "passed");
        }
      } catch (checkError) {
        logger.error(`Error running check '${checkName}' for ${steamId} (user: ${username}): ${checkError.message}`);
        await queueManager.updateProfileCheck(steamId, checkName, "deferred");
        logger.info(`Marked ${checkName} as deferred due to error, continuing with other checks for ${steamId} (user: ${username})`);
        continue; // Continue to next check
      }
    }
  } catch (error) {
    logger.error(`Queue processing error: ${error.message}`);
  } finally {
    isProcessing = false;
  }
}

async function main() {
  logger.info('Starting Steam ID Processor Service');
  logger.info('===================================');
  logger.info(`Queue file: ${CONFIG.QUEUE_PATH || 'steam-id-processor/profiles_queue.json'}`);
  
  // DEBUG: Verificar CONFIG completo
  logger.info(`🔍 [DEBUG] CONFIG keys: ${Object.keys(CONFIG).join(', ')}`);
  logger.info(`🔍 [DEBUG] CONFIG.BACKOFF_SEQUENCE_MINUTES: ${JSON.stringify(CONFIG.BACKOFF_SEQUENCE_MINUTES)}`);
  logger.info(`🔍 [DEBUG] CONFIG.BACKOFF_SEQUENCE_MINUTES type: ${typeof CONFIG.BACKOFF_SEQUENCE_MINUTES}`);
  logger.info(`🔍 [DEBUG] CONFIG.COOLDOWN_DURATIONS: ${JSON.stringify(CONFIG.COOLDOWN_DURATIONS)}`);
  
  if (!CONFIG.BACKOFF_SEQUENCE_MINUTES) {
    logger.error(`🔍 [DEBUG] CRITICAL: BACKOFF_SEQUENCE_MINUTES missing from CONFIG!`);
    logger.error(`🔍 [DEBUG] Full CONFIG object:`);
    logger.error(JSON.stringify(CONFIG, null, 2));
  }
  
  // Validate environment variables
  if (!CONFIG.STEAM_API_KEY) {
    logger.error('❌ STEAM_API_KEY not found in environment variables');
    logger.error('Please add STEAM_API_KEY=your_key to your .env file');
    process.exit(1);
  }
  
  if (!CONFIG.LINK_HARVESTER_API_KEY) {
    logger.error('❌ LINK_HARVESTER_API_KEY not found in environment variables');
    logger.error('Please add LINK_HARVESTER_API_KEY=your_key to your .env file');
    process.exit(1);
  }
  
  // NUEVO: Iniciar API Server
  try {
    logger.info('🌐 Starting API Server...');
    apiServer = new ApiServer();
    await apiServer.start();
    logger.info('✅ API Server started successfully');
  } catch (error) {
    logger.error(`❌ Failed to start API server: ${error.message}`);
    process.exit(1);
  }
  
  // Initialize components
  const fileManager = new FileManager(CONFIG);
  logger.info(`🔍 [DEBUG] About to initialize SteamValidator with CONFIG`);
  const steamValidator = new SteamValidator(CONFIG);
  const apiService = new ApiService(CONFIG);
  const queueManager = new QueueManager(CONFIG);
  
  logger.info('Service initialized and ready for processing');

  // Convert any existing deferred checks from previous runs
  // queueManager.convertDeferredChecksToToCheck().then(result => {
  //   if (result.conversions > 0) {
  //     logger.info(`Startup: Converted ${result.conversions} deferred checks from previous session`);
  //   }
  // });
  
  // Start the processing loops
  
  // 1. Process queued profiles (main processing loop)
  const processQueue = async () => {
    try {
      logger.debug(`🔍 [DEBUG] processQueue called at ${new Date().toISOString()}`);
      await processQueuedProfiles(steamValidator, apiService, queueManager);
      logger.debug(`🔍 [DEBUG] processQueue completed at ${new Date().toISOString()}`);
    } catch (error) {
      logger.error(`Queue processing error: ${error.message}`);
    }
    
    // Schedule next run with variable delay
    const nextDelay = isProcessing ? 1000 : CONFIG.PROCESSING_DELAY;
    logger.debug(`🔍 [DEBUG] Scheduling next processQueue in ${nextDelay}ms (isProcessing: ${isProcessing})`);
    setTimeout(processQueue, nextDelay);
  };

  // 2. Periodically check and log proxy status, cleanup cooldowns
  const checkProxyStatus = async () => {
    try {
      logger.debug(`🔍 [DEBUG] checkProxyStatus called at ${new Date().toISOString()}`);
      // Clean up expired cooldowns first
      const cleanupCount = steamValidator.proxyManager.cleanupExpiredCooldowns();
      
      const status = steamValidator.getProxyStatus();
      
      // More detailed connection status logging with endpoint-specific cooldowns
      const connectionDetails = status.connections.map((conn, index) => {
        const connType = conn.type === 'direct' ? 'Direct' : `SOCKS5 ${conn.url?.split('@')[1] || 'proxy'}`;
        const availableEndpoints = conn.availableEndpoints;
        const totalEndpoints = conn.totalEndpoints;
        
        if (availableEndpoints === totalEndpoints) {
          return `${connType}: All endpoints available`;
        } else if (availableEndpoints === 0) {
          return `${connType}: All endpoints in cooldown`;
        } else {
          return `${connType}: ${availableEndpoints}/${totalEndpoints} endpoints available`;
        }
      }).join(', ');
      
      // Get deferred check statistics (READ-ONLY)
      const deferredStats = await queueManager.getDeferredCheckStats();
      
      // Get queue statistics (READ-ONLY)
      const queueStats = await queueManager.getQueueStats();
      
      // Log current status
      logger.info(`🔌 Connection status: ${connectionDetails}`);
      logger.info(`📋 Queue status: ${queueStats.totalProfiles} profiles total`);
      
      if (queueStats.totalProfiles > 0) {
        const userSummary = Object.entries(queueStats.byUsername)
          .map(([user, count]) => `${user}:${count}`)
          .join(', ');
        logger.info(`    By user: ${userSummary}`);
      }
      
      if (deferredStats.totalDeferred > 0) {
        logger.info(`📋 Deferred checks: ${deferredStats.totalDeferred} checks across ${deferredStats.profilesWithDeferred} profiles`);
      }
      
      // Log endpoint-specific status if there are any cooldowns
      const endpointSummary = status.endpointSummary;
      const endpointsWithCooldowns = Object.entries(endpointSummary)
        .filter(([_, summary]) => summary.availableConnections < summary.totalConnections);
      
      if (endpointsWithCooldowns.length > 0) {
        logger.info(`🚫 Endpoint cooldowns:`);
        endpointsWithCooldowns.forEach(([endpoint, summary]) => {
          if (summary.availableConnections === 0) {
            const waitTimeMin = Math.ceil(summary.nextAvailableIn / 60000);
            logger.info(`    ${endpoint}: All connections in cooldown (~${waitTimeMin}m remaining)`);
          } else {
            logger.info(`    ${endpoint}: ${summary.availableConnections}/${summary.totalConnections} connections available`);
          }
        });
      }
      
      // Process any deferred checks where connections are now available
      const deferredChecks = Array.from(steamValidator.getDeferredChecks().entries());
      
      logger.debug(`🔍 [DEBUG] steamValidator.getDeferredChecks() size: ${steamValidator.getDeferredChecks().size}`);
      logger.debug(`🔍 [DEBUG] deferredChecks entries: ${deferredChecks.length}`);
      
      if (deferredChecks.length > 0) {
        logger.info(`🔄 Processing ${deferredChecks.length} deferred checks...`);
        const deferredResult = await steamValidator.processDeferredChecks(queueManager);
        if (deferredResult.processed > 0) {
          logger.info(`✅ Processed ${deferredResult.processed} deferred checks, ${deferredResult.remaining} remaining`);
        } else {
          logger.debug(`No deferred checks were processed`);
        }
      } else {
        logger.debug(`🔍 [DEBUG] No deferred checks in steamValidator.deferredChecks Map`);
      }
      
    } catch (error) {
      logger.error(`Proxy status check error: ${error.message}`);
    }
    
    // Schedule next check (every minute)
    setTimeout(checkProxyStatus, 60 * 1000);
  };

  // Start all processes
  logger.info(`🔍 [DEBUG] Starting processQueue...`);
  processQueue();
  logger.info(`🔍 [DEBUG] Starting checkProxyStatus...`);
  checkProxyStatus();
  
  logger.info('All processing loops started');
  logger.info('Waiting for Steam IDs to be added to queue via Django API...');
}

// Start the service
main().catch(error => {
  logger.error(`Service initialization failed: ${error.message}`);
  process.exit(1);
});

// Handle graceful shutdown - MODIFICADO para incluir API server
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  
  // NUEVO: Cerrar API server
  if (apiServer) {
    try {
      await apiServer.stop();
      logger.info('API Server stopped');
    } catch (error) {
      logger.error(`Error stopping API server: ${error.message}`);
    }
  }
  
  // Allow some time for cleanup
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  
  // NUEVO: Cerrar API server
  if (apiServer) {
    try {
      await apiServer.stop();
      logger.info('API Server stopped');
    } catch (error) {
      logger.error(`Error stopping API server: ${error.message}`);
    }
  }
  
  // Allow some time for cleanup
  setTimeout(() => process.exit(0), 1000);
});