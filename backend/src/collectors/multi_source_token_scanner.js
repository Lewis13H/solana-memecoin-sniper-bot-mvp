// backend/src/collectors/multi_source_token_scanner.js
const EventEmitter = require('events');
const axios = require('axios');
const logger = require('../utils/logger');

// Import individual scanners
const PumpFunScanner = require('./scanners/pumpfun_scanner');
const MoonshotScanner = require('./scanners/moonshot_scanner');
const JupiterScanner = require('./scanners/jupiter_scanner');
const RaydiumScanner = require('./scanners/raydium_scanner');

class MultiSourceTokenScanner extends EventEmitter {
    constructor(database) {
        super();
        this.db = database;
        this.isScanning = false;
        this.scanInterval = 30000; // 30 seconds
        this.processedTokens = new Set();
        
        // Initialize scanners
        this.scanners = {
            pumpfun: new PumpFunScanner(),
            moonshot: new MoonshotScanner(),
            jupiter: new JupiterScanner(),
            raydium: new RaydiumScanner()
        };
        
        // Setup event listeners for each scanner
        this.setupScannerListeners();
    }

    setupScannerListeners() {
        Object.entries(this.scanners).forEach(([name, scanner]) => {
            scanner.on('token', (token) => {
                this.handleNewToken({ ...token, source: name });
            });
            
            scanner.on('error', (error) => {
                logger.error(`${name} scanner error:`, error.message || error);
            });
        });
    }

    async startScanning() {
        if (this.isScanning) return;
        
        this.isScanning = true;
        logger.info('🚀 Multi-Source Token Scanner started');
        
        // Start all scanners
        const startPromises = Object.entries(this.scanners).map(async ([name, scanner]) => {
            try {
                if (scanner.config?.enabled !== false) {
                    await scanner.start();
                    logger.info(`✅ ${name} scanner started`);
                }
            } catch (error) {
                logger.error(`Failed to start ${name} scanner:`, error);
            }
        });
        
        await Promise.all(startPromises);
        
        // Start periodic aggregation
        this.aggregationTimer = setInterval(() => {
            this.aggregateTokenData();
        }, this.scanInterval);
    }

    async handleNewToken(token) {
        // Skip if already processed
        if (this.processedTokens.has(token.address)) {
            return;
        }
        
        try {
            // Mark as processed
            this.processedTokens.add(token.address);
            
            // Enrich token data
            const enrichedToken = await this.enrichTokenData(token);
            
            // Calculate scores
            const analysis = this.analyzeToken(enrichedToken);
            
            // Store if meets criteria
            if (analysis.shouldStore) {
                await this.storeToken(enrichedToken, analysis);
                
                // Emit for other components
                this.emit('new-token', enrichedToken);
                
                logger.info(`✅ New token from ${token.source}: ${token.symbol} (Score: ${analysis.score.toFixed(1)})`);
            }
        } catch (error) {
            logger.error(`Error processing token ${token.symbol}:`, error);
            // Remove from processed on error to allow retry
            this.processedTokens.delete(token.address);
        }
    }

    async enrichTokenData(token) {
        // Add additional data from multiple sources
        const enriched = { ...token };
        
        try {
            // Get additional price data if not present
            if (!enriched.price && enriched.address) {
                enriched.price = await this.getTokenPrice(enriched.address);
            }
            
            // Calculate market cap if not present
            if (!enriched.marketCap && enriched.price && enriched.totalSupply) {
                enriched.marketCap = enriched.price * enriched.totalSupply;
            }
            
            // Add discovery metadata
            enriched.discoveredAt = Date.now();
            enriched.ageMinutes = (Date.now() - enriched.createdAt) / (1000 * 60);
            
        } catch (error) {
            logger.warn(`Failed to enrich token ${token.symbol}:`, error.message);
        }
        
        return enriched;
    }

    analyzeToken(token) {
        let score = 0;
        const factors = {};
        
        // Source priority scoring
        const sourcePriority = {
            pumpfun: 30,
            moonshot: 25,
            raydium: 20,
            jupiter: 15
        };
        
        score += sourcePriority[token.source] || 10;
        factors.sourceScore = sourcePriority[token.source] || 10;
        
        // Age scoring (newer = higher score)
        if (token.ageMinutes < 5) {
            score += 40;
            factors.ageScore = 40;
        } else if (token.ageMinutes < 30) {
            score += 30;
            factors.ageScore = 30;
        } else if (token.ageMinutes < 60) {
            score += 20;
            factors.ageScore = 20;
        } else if (token.ageMinutes < 180) {
            score += 10;
            factors.ageScore = 10;
        }
        
        // Liquidity scoring
        if (token.liquidity > 50000) {
            score += 20;
            factors.liquidityScore = 20;
        } else if (token.liquidity > 10000) {
            score += 15;
            factors.liquidityScore = 15;
        } else if (token.liquidity > 5000) {
            score += 10;
            factors.liquidityScore = 10;
        } else if (token.liquidity > 1000) {
            score += 5;
            factors.liquidityScore = 5;
        }
        
        // Volume/activity scoring
        if (token.volume24h > 100000) {
            score += 20;
            factors.volumeScore = 20;
        } else if (token.volume24h > 50000) {
            score += 15;
            factors.volumeScore = 15;
        } else if (token.volume24h > 10000) {
            score += 10;
            factors.volumeScore = 10;
        } else if (token.volume24h > 1000) {
            score += 5;
            factors.volumeScore = 5;
        }
        
        // Risk calculation
        let riskScore = 40; // Base risk
        
        if (token.liquidity < 5000) riskScore += 20;
        if (token.ageMinutes < 10) riskScore += 20;
        if (token.source === 'pumpfun' || token.source === 'moonshot') riskScore -= 10; // Trusted sources
        if (!token.verified) riskScore += 10;
        
        return {
            score: Math.min(100, score),
            riskScore: Math.min(100, Math.max(0, riskScore)),
            factors: factors,
            shouldStore: score > 30 && riskScore < 80
        };
    }

    async storeToken(token, analysis) {
        try {
            await this.db.addToken({
                address: token.address,
                symbol: token.symbol,
                name: token.name,
                marketCap: token.marketCap || 0,
                liquidity: token.liquidity || 0,
                holders: token.holders || 0,
                socialScore: 0, // Will be updated by social monitor
                riskScore: analysis.riskScore,
                metadata: JSON.stringify({
                    source: token.source,
                    launchTime: token.createdAt,
                    discoveryScore: analysis.score,
                    scoreFactors: analysis.factors
                })
            });
        } catch (error) {
            if (error.message.includes('UNIQUE constraint failed')) {
                // Token already exists, update it
                logger.debug(`Token ${token.symbol} already exists, skipping`);
            } else {
                throw error;
            }
        }
    }

    async getTokenPrice(address) {
        try {
            // Try Jupiter price API first
            const response = await axios.get(
                `https://price.jup.ag/v4/price?ids=${address}`,
                { timeout: 5000 }
            );
            
            if (response.data && response.data.data && response.data.data[address]) {
                return response.data.data[address].price;
            }
            
            return null;
        } catch (error) {
            logger.debug(`Failed to get price for ${address}:`, error.message);
            return null;
        }
    }

    async aggregateTokenData() {
        // Periodic task to cross-reference tokens between scanners
        const allTokens = new Map();
        
        for (const [source, scanner] of Object.entries(this.scanners)) {
            if (scanner.tokens) {
                scanner.tokens.forEach((token, address) => {
                    if (!allTokens.has(address)) {
                        allTokens.set(address, { ...token, sources: [source] });
                    } else {
                        allTokens.get(address).sources.push(source);
                    }
                });
            }
        }
        
        // Tokens appearing in multiple sources get priority
        for (const [address, token] of allTokens) {
            if (token.sources.length > 1 && !this.processedTokens.has(address)) {
                token.multiSource = true;
                token.priority = token.sources.length * 10;
                await this.handleNewToken(token);
            }
        }
    }

    async stopScanning() {
        this.isScanning = false;
        
        // Stop all scanners
        const stopPromises = Object.entries(this.scanners).map(async ([name, scanner]) => {
            try {
                await scanner.stop();
                logger.info(`${name} scanner stopped`);
            } catch (error) {
                logger.error(`Error stopping ${name} scanner:`, error);
            }
        });
        
        await Promise.all(stopPromises);
        
        if (this.aggregationTimer) {
            clearInterval(this.aggregationTimer);
        }
        
        logger.info('Multi-Source Token Scanner stopped');
    }
  
    getScannerStatus() {
        const status = {};
        
        for (const [name, scanner] of Object.entries(this.scanners)) {
            status[name] = {
                enabled: scanner.config?.enabled !== false,
                running: scanner.isRunning || false,
                tokensFound: scanner.tokenCount || 0,
                lastUpdate: scanner.lastUpdate || null
            };
        }
        
        return status;
    }
    
    // Get scanner statistics
    getStats() {
        const stats = {};
        
        Object.entries(this.scanners).forEach(([name, scanner]) => {
            stats[name] = {
                enabled: scanner.config?.enabled !== false,
                tokensFound: scanner.tokens?.size || 0,
                isRunning: scanner.isRunning || false,
                lastUpdate: scanner.lastUpdate || null
            };
        });
        
        stats.total = {
            processedTokens: this.processedTokens.size,
            isScanning: this.isScanning
        };
        
        return stats;
    }
}

module.exports = MultiSourceTokenScanner;